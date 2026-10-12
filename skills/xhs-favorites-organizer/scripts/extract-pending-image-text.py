#!/usr/bin/env python3

"""Run an explicitly configured local OCR engine on sealed cached images only."""

import argparse
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import tempfile
import threading
import time
from datetime import datetime, timezone


NOTE_ID = re.compile(r"^[a-f0-9]{24}$")
HASH = re.compile(r"^[a-f0-9]{64}$")
MAX_OCR_BYTES = 800_000

# Which cached files are a note's images is decided in one place, shared with the sync service.
_CACHED_IMAGES_SPEC = importlib.util.spec_from_file_location(
    "favsense_cached_images", Path(__file__).with_name("cached_images.py")
)
CACHED_IMAGES = importlib.util.module_from_spec(_CACHED_IMAGES_SPEC)
_CACHED_IMAGES_SPEC.loader.exec_module(CACHED_IMAGES)


def _is_plain_path(path: Path, expected_mode: int) -> bool:
    candidate = Path(os.path.abspath(str(path)))
    try:
        metadata = os.lstat(candidate)
    except OSError:
        return False
    attributes = getattr(metadata, "st_file_attributes", 0)
    if (
        candidate.is_symlink()
        or attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        or stat.S_IFMT(metadata.st_mode) != expected_mode
    ):
        return False
    for parent in candidate.parents:
        try:
            parent_metadata = os.lstat(parent)
        except OSError:
            return False
        if (
            parent.is_symlink()
            or getattr(parent_metadata, "st_file_attributes", 0)
            & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
        ):
            return False
    return True


def _is_plain_file(path: Path) -> bool:
    return _is_plain_path(path, stat.S_IFREG)


def _is_plain_directory(path: Path) -> bool:
    return _is_plain_path(path, stat.S_IFDIR)


def ocr_tool_version(engine: Path) -> str:
    target = Path(engine)
    if not _is_plain_file(target):
        raise ValueError("OCR engine identity is unavailable")
    digest = hashlib.sha256()
    with target.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return f"local-ocr;engine_sha256={digest.hexdigest()}"


def dispatch_evidence_methods(context):
    if context.get("safety_stopped") is True:
        return []
    methods = []
    if context.get("cached_video") and context.get("transcriber_available"):
        methods.append("local_transcription")
    if context.get("cached_image") and context.get("ocr_available"):
        methods.append("local_image_ocr")
    return methods


def _atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not _is_plain_directory(path.parent) or (
        os.path.lexists(path) and not _is_plain_file(path)
    ):
        raise ValueError("OCR output path is unavailable or redirected")
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        text=True,
    )
    temporary = Path(temporary_name)
    try:
        if not _is_plain_file(temporary):
            raise ValueError("OCR temporary path is unavailable or redirected")
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor = -1
            json.dump(value, handle, ensure_ascii=False, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def _windows_kill_job(process):
    if os.name != "nt" or not hasattr(process, "_handle"):
        return None
    from ctypes import wintypes

    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_longlong),
            ("PerJobUserTimeLimit", ctypes.c_longlong),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [
            ("ReadOperationCount", ctypes.c_ulonglong),
            ("WriteOperationCount", ctypes.c_ulonglong),
            ("OtherOperationCount", ctypes.c_ulonglong),
            ("ReadTransferCount", ctypes.c_ulonglong),
            ("WriteTransferCount", ctypes.c_ulonglong),
            ("OtherTransferCount", ctypes.c_ulonglong),
        ]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", BasicLimits),
            ("IoInfo", IoCounters),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
    ]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
    limits = ExtendedLimits()
    limits.BasicLimitInformation.LimitFlags = 0x00002000
    if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        kernel32.CloseHandle(job)
        raise OSError(ctypes.get_last_error(), "SetInformationJobObject failed")
    if not kernel32.AssignProcessToJobObject(job, wintypes.HANDLE(process._handle)):
        kernel32.CloseHandle(job)
        raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")
    return job, kernel32.CloseHandle


def _resume_windows_process(process):
    if os.name != "nt" or not hasattr(process, "_handle"):
        return
    from ctypes import wintypes
    ntdll = ctypes.WinDLL("ntdll")
    ntdll.NtResumeProcess.argtypes = [wintypes.HANDLE]
    ntdll.NtResumeProcess.restype = ctypes.c_long
    status = ntdll.NtResumeProcess(wintypes.HANDLE(process._handle))
    if status != 0:
        raise OSError(status, "NtResumeProcess failed")


def _stop_process_tree(process, job):
    if job:
        handle, close_handle = job
        close_handle(handle)
    elif os.name != "nt" and hasattr(process, "pid"):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if hasattr(process, "poll") and process.poll() is None:
        process.kill()


def _run_engine(
    command, popen_factory=subprocess.Popen, *, timeout=60, max_bytes=MAX_OCR_BYTES, encoding="utf-8"
):
    options = {"stdout": subprocess.PIPE, "stderr": subprocess.PIPE}
    if os.name == "nt":
        options["creationflags"] = (
            subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP | 0x00000004
        )
    else:
        options["start_new_session"] = True
    process = popen_factory(command, **options)
    job = None
    try:
        job = _windows_kill_job(process)
        _resume_windows_process(process)
    except Exception:
        _stop_process_tree(process, job)
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
        process.stdout.close()
        process.stderr.close()
        raise
    deadline = time.monotonic() + timeout
    output = bytearray()
    overflow = threading.Event()
    stderr_bytes = [0]

    def drain(stream, capture):
        total = 0
        try:
            for chunk in iter(lambda: stream.read(64 * 1024), b""):
                total += len(chunk)
                if capture is not None and len(capture) < max_bytes:
                    capture.extend(chunk[:max_bytes - len(capture)])
                if total > max_bytes and not overflow.is_set():
                    overflow.set()
                    try:
                        process.terminate()
                    except OSError:
                        pass
        except (OSError, ValueError):
            pass
        finally:
            if capture is None:
                stderr_bytes[0] = total
            stream.close()

    readers = [
        threading.Thread(target=drain, args=(process.stdout, output), daemon=True),
        threading.Thread(target=drain, args=(process.stderr, None), daemon=True),
    ]
    for reader in readers:
        reader.start()
    reason = ""
    try:
        returncode = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        reason = "ocr_timed_out"
        _stop_process_tree(process, job)
        job = None
        try:
            returncode = process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            returncode = 1
    if job or os.name != "nt":
        # The engine has exited; stop whatever it left behind (closing the job
        # on Windows, killing the engine's process group on POSIX) before
        # waiting on readers, since a descendant holding the pipes would
        # otherwise make a successful run look timed out.
        _stop_process_tree(process, job)
        job = None
    for reader in readers:
        reader.join(max(0, deadline - time.monotonic()))
    if any(reader.is_alive() for reader in readers):
        reason = "ocr_timed_out"
    for reader in readers:
        reader.join(1)
    if overflow.is_set():
        return returncode, "", "ocr_output_too_large"
    if reason:
        return returncode, "", reason
    # The engine exits non-zero with nothing on either stream for a picture with no text on it; a broken or
    # missing picture leaves a stack trace on stderr. Only the first is a blank page.
    if returncode != 0 and not output and not stderr_bytes[0]:
        return returncode, "", "ocr_no_text"
    # Strict on purpose: bytes that are not in the declared encoding fail the page; nothing is guessed or replaced.
    try:
        return returncode, output.decode(encoding), ""
    except UnicodeDecodeError:
        return returncode, "", "ocr_failed"


def _current_extraction(path: Path, content_sha256: str, tool_version: str) -> str:
    """The result hash of an artifact that already holds this note's text for this revision and engine, else ''."""
    if not _is_plain_file(path):
        return ""
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return ""
    text = value.get("text") if isinstance(value, dict) else None
    if (
        isinstance(value, dict)
        and value.get("schema_version") == 1
        and value.get("status") == "extracted"
        and value.get("method") == "local_image_ocr"
        and value.get("provider") == "configured-local-engine"
        and value.get("content_sha256") == content_sha256
        and value.get("tool_version") == tool_version
        and isinstance(text, str)
        and text
        and value.get("result_sha256") == hashlib.sha256(text.encode("utf-8")).hexdigest()
    ):
        return value["result_sha256"]
    return ""


def extract_cached_images(
    media_dir: Path,
    analysis_dir: Path,
    *,
    engine: Path | None,
    allowed_note_ids: set[str],
    content_sha256_by_id: dict[str, str] | None = None,
    runner=subprocess.Popen,
    engine_encoding: str = "utf-8",
    image_note_ids: set[str] | None = None,
):
    try:
        "".encode(engine_encoding)  # rejects an unknown name and a non-text codec such as rot13
    except LookupError as error:
        raise ValueError(f"image_ocr.output_encoding is not a text encoding: {engine_encoding!r}") from error
    allowed = {note_id for note_id in allowed_note_ids if NOTE_ID.fullmatch(str(note_id))}
    revisions = {
        note_id: str(content_sha256).strip()
        for note_id, content_sha256 in (content_sha256_by_id or {}).items()
        if note_id in allowed and HASH.fullmatch(str(content_sha256).strip())
    }
    if engine is None:
        return {"status": "ocr_unavailable", "processed": 0, "failed": 0, "records": []}
    engine = Path(engine)
    if not _is_plain_file(engine):
        return {"status": "ocr_unavailable", "processed": 0, "failed": 0, "records": []}
    analysis_dir.mkdir(parents=True, exist_ok=True)
    if not _is_plain_directory(analysis_dir):
        raise ValueError("OCR analysis directory is unavailable or redirected")
    records = []
    failed = 0
    # A note's cached images, in page order: `<id>.jpg` is one page, `<id>_<n>.jpeg` is page n.
    pages = {}
    if _is_plain_directory(media_dir):
        for path in media_dir.iterdir():
            parsed = CACHED_IMAGES.image_page(path.name)
            if parsed and parsed[0] in revisions and _is_plain_file(path):
                pages.setdefault(parsed[0], []).append((parsed[1], path.name, path))
    candidates = {
        note_id: [path for _, _, path in sorted(pages[note_id])] for note_id in sorted(pages)
    }
    for note_id, images in candidates.items():
        content_sha256 = revisions[note_id]
        note_dir = analysis_dir / note_id
        note_dir.mkdir(parents=True, exist_ok=True)
        if not _is_plain_directory(note_dir):
            failed += 1
            records.append({
                "note_id": note_id,
                "status": "failed",
                "reason_code": "ocr_output_path_unavailable",
            })
            continue
        artifact_path = note_dir / "visual-ocr.json"
        output_error = ""
        page_texts = []
        try:
            tool_version = ocr_tool_version(engine)
        except (OSError, ValueError):
            tool_version = "unavailable"
            output_error = "ocr_engine_changed"
        else:
            # Rewriting an accepted note's evidence changes its evidence version, so a current artifact is left alone.
            current = _current_extraction(artifact_path, content_sha256, tool_version)
            if current:
                records.append({"note_id": note_id, "status": "extracted", "result_sha256": current})
                continue
            for image in images:
                try:
                    returncode, output, output_error = _run_engine(
                        [str(engine), str(image)], runner, encoding=engine_encoding
                    )
                except (OSError, subprocess.TimeoutExpired):
                    returncode, output, output_error = 1, "", "ocr_failed"
                if output_error == "ocr_no_text":
                    output_error = ""  # a picture with no text on it is a blank page, not a failure
                    continue
                if returncode != 0 and not output_error:
                    output_error = "ocr_failed"
                if output_error:
                    break
                page_texts.append(re.sub(r"\s+", " ", output).strip())
            try:
                current_tool_version = ocr_tool_version(engine)
            except (OSError, ValueError):
                current_tool_version = ""
            if current_tool_version != tool_version:
                output_error = "ocr_engine_changed"
        text = " ".join(page for page in page_texts if page)
        if not output_error and (not text or len(text) > 200_000):
            output_error = "ocr_empty"
        if output_error:
            failed += 1
            _atomic_json(artifact_path, {
                "schema_version": 1,
                "status": "failed",
                "method": "local_image_ocr",
                "provider": "configured-local-engine",
                "tool_version": tool_version,
                "content_sha256": content_sha256,
                "captured_at": datetime.now(timezone.utc).isoformat(),
                "reason_code": output_error,
            })
            records.append({"note_id": note_id, "status": "failed", "reason_code": output_error})
            continue
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        _atomic_json(artifact_path, {
            "schema_version": 1,
            "status": "extracted",
            "method": "local_image_ocr",
            "provider": "configured-local-engine",
            "tool_version": tool_version,
            "content_sha256": content_sha256,
            "result_sha256": digest,
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "text": text,
        })
        records.append({"note_id": note_id, "status": "extracted", "result_sha256": digest})
    # An image note that was asked for but has no cached image was not read. Say so, so the report never
    # reads "completed, 0 processed" for a run that read nothing.
    missing = sorted((set(image_note_ids or ()) & set(revisions)) - set(candidates))
    records.extend({"note_id": note_id, "status": "skipped", "reason_code": "no_cached_images"} for note_id in missing)
    return {
        "status": "completed" if not failed and not missing else "partial",
        "processed": len(candidates) - failed,
        "failed": failed,
        "missing": len(missing),
        "records": records,
    }


def main():
    parser = argparse.ArgumentParser(description="Extract text from private cached images using an explicitly configured local engine.")
    parser.add_argument("--media-dir", required=True)
    parser.add_argument("--analysis-dir", required=True)
    parser.add_argument("--engine")
    parser.add_argument("--engine-encoding", default="utf-8")
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--note-id", action="append", default=[])
    parser.add_argument("--report", required=True)
    options = parser.parse_args()
    catalog = json.loads(Path(options.catalog).resolve().read_text(encoding="utf-8-sig"))
    notes = catalog.get("notes") if isinstance(catalog, dict) else None
    if not isinstance(notes, dict):
        raise ValueError("catalog must contain a notes object")
    result = extract_cached_images(
        Path(options.media_dir),
        Path(options.analysis_dir),
        engine=Path(options.engine) if options.engine else None,
        allowed_note_ids=set(options.note_id),
        engine_encoding=options.engine_encoding,
        image_note_ids={
            note_id for note_id, note in notes.items()
            if isinstance(note, dict) and note.get("type") == "图文"
        },
        content_sha256_by_id={
            note_id: note.get("content_sha256")
            for note_id, note in notes.items()
            if isinstance(note, dict)
        },
    )
    _atomic_json(Path(options.report), result)
    print(json.dumps(
        {key: result[key] for key in ("status", "processed", "failed", "missing") if key in result},
        ensure_ascii=False,
    ))


if __name__ == "__main__":
    main()
