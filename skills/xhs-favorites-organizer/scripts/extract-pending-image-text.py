#!/usr/bin/env python3

"""Run an explicitly configured local OCR engine on sealed cached images only."""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import threading
import time
from datetime import datetime, timezone


NOTE_ID = re.compile(r"^[a-f0-9]{24}$")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
MAX_OCR_BYTES = 800_000


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
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, path)


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


def _run_engine(command, popen_factory=subprocess.Popen, *, timeout=60, max_bytes=MAX_OCR_BYTES):
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
    if job:
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
    try:
        return returncode, output.decode("utf-8"), ""
    except UnicodeDecodeError:
        return returncode, "", "ocr_failed"


def extract_cached_images(media_dir: Path, analysis_dir: Path, *, engine: Path | None, allowed_note_ids: set[str], runner=subprocess.Popen):
    allowed = {note_id for note_id in allowed_note_ids if NOTE_ID.fullmatch(str(note_id))}
    if engine is None:
        return {"status": "ocr_unavailable", "processed": 0, "failed": 0, "records": []}
    engine = Path(engine)
    if not engine.is_file() or engine.is_symlink():
        return {"status": "ocr_unavailable", "processed": 0, "failed": 0, "records": []}
    records = []
    failed = 0
    candidates = sorted(
        path for path in media_dir.iterdir()
        if path.is_file() and not path.is_symlink() and path.suffix.lower() in IMAGE_SUFFIXES and path.stem in allowed
    ) if media_dir.is_dir() and not media_dir.is_symlink() else []
    for image in candidates:
        try:
            returncode, output, output_error = _run_engine([str(engine), str(image)], runner)
        except (OSError, subprocess.TimeoutExpired):
            returncode, output, output_error = 1, "", "ocr_failed"
        if returncode != 0 or output_error:
            failed += 1
            records.append({
                "note_id": image.stem, "status": "failed",
                "reason_code": output_error or "ocr_failed",
            })
            continue
        text = re.sub(r"\s+", " ", output).strip()
        if not text or len(text) > 200_000:
            failed += 1
            records.append({"note_id": image.stem, "status": "failed", "reason_code": "ocr_empty"})
            continue
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        _atomic_json(analysis_dir / image.stem / "visual-ocr.json", {
            "schema_version": 1,
            "status": "extracted",
            "method": "local_image_ocr",
            "provider": "configured-local-engine",
            "tool_version": "local-ocr-v1",
            "result_sha256": digest,
            "captured_at": datetime.now(timezone.utc).isoformat(),
            "text": text,
        })
        records.append({"note_id": image.stem, "status": "extracted", "result_sha256": digest})
    return {"status": "completed" if not failed else "partial", "processed": len(candidates) - failed, "failed": failed, "records": records}


def main():
    parser = argparse.ArgumentParser(description="Extract text from private cached images using an explicitly configured local engine.")
    parser.add_argument("--media-dir", required=True)
    parser.add_argument("--analysis-dir", required=True)
    parser.add_argument("--engine")
    parser.add_argument("--note-id", action="append", default=[])
    parser.add_argument("--report", required=True)
    options = parser.parse_args()
    result = extract_cached_images(Path(options.media_dir), Path(options.analysis_dir), engine=Path(options.engine) if options.engine else None, allowed_note_ids=set(options.note_id))
    _atomic_json(Path(options.report), result)
    print(json.dumps({key: result[key] for key in ("status", "processed", "failed")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
