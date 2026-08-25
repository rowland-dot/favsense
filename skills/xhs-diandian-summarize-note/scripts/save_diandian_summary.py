#!/usr/bin/env python3
"""Clean a completed DianDian reply and save a private summary record."""

from __future__ import annotations

import argparse
from collections.abc import Iterator
from contextlib import contextmanager
import errno
import hashlib
import html
import json
import os
import re
import shutil
import threading
import time
import unicodedata
from uuid import uuid4
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows uses msvcrt below.
    fcntl = None

try:
    import msvcrt
except ImportError:  # pragma: no cover - POSIX uses fcntl above.
    msvcrt = None


NOTE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
MAX_TITLE_LENGTH = 200
MAX_SUMMARY_LENGTH = 200_000
MAX_SUMMARY_INPUT_BYTES = MAX_SUMMARY_LENGTH * 4
PRIVATE_STORE_LOCK_TIMEOUT_SECONDS = 30.0
BATCH_JOURNAL_NAME = ".batch-journal.json"
_PRIVATE_STORE_THREAD_LOCKS: dict[Path, threading.RLock] = {}
_PRIVATE_STORE_THREAD_LOCKS_GUARD = threading.Lock()
SENSITIVE_SOURCE_PATTERN = re.compile(
    r"(?i)(?:xsec[\s_-]*token\s*=|"
    r"\b(?:access_token|refresh_token|authorization|cookie|password|secret)\s*[:=]|"
    r"\bBearer\s+[A-Za-z0-9._~+/-]{8,}|"
    r"(?:(?:https?:)?//)?(?:www\.)?xiaohongshu\.com/)"
)
TRAILING_FOOTER_PATTERNS = (
    re.compile(r"(?:以上内容|本回答|本内容|内容)由\s*AI\s*生成[，, ]*(?:仅供参考)?[。！!]?"),
    re.compile(r"如果你还想了解更多(?:内容)?[，, ]*可以继续问我[。！!]?"),
    re.compile(r"你还可以继续问我(?:关于这篇笔记)?的问题[。！!]?"),
    re.compile(r"还有其他问题(?:的话)?[，, ]*欢迎继续提问[。！!]?"),
)


def _normalize_paragraph(paragraph: str) -> str:
    return "\n".join(line.rstrip() for line in paragraph.strip().splitlines()).strip()


def _is_recognized_footer(paragraph: str) -> bool:
    compact = re.sub(r"\s+", "", paragraph)
    return any(pattern.fullmatch(compact) for pattern in TRAILING_FOOTER_PATTERNS)


def _sensitive_scan_text(value: str) -> str:
    normalized = value
    for _ in range(8):
        decoded = unicodedata.normalize("NFKC", unquote(html.unescape(normalized)))
        decoded = "".join(character for character in decoded if unicodedata.category(character) != "Cf")
        if decoded == normalized:
            break
        normalized = decoded
    return normalized


def clean_summary(text: str) -> tuple[str, list[str]]:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    paragraphs = [
        _normalize_paragraph(part)
        for part in re.split(r"\n\s*\n", normalized)
        if part.strip()
    ]
    removed: list[str] = []

    while paragraphs and _is_recognized_footer(paragraphs[-1]):
        removed.insert(0, paragraphs.pop())

    return "\n\n".join(paragraphs), removed


def build_record(
    title: str,
    summary_text: str,
    note_id: str,
    *,
    captured_at: str | None = None,
) -> dict[str, str | int]:
    if not all(isinstance(value, str) for value in (title, summary_text, note_id)):
        raise ValueError("title, summary and note_id must be strings")
    if len(title) > MAX_TITLE_LENGTH or len(summary_text) > MAX_SUMMARY_LENGTH:
        raise ValueError("DianDian title or reply is too long")
    normalized_note_id = note_id.strip()
    if not NOTE_ID_PATTERN.fullmatch(normalized_note_id):
        raise ValueError("note_id contains unsupported characters")
    if not title.strip():
        raise ValueError("DianDian title must not be empty")
    summary, _removed = clean_summary(summary_text)
    if not summary or len(summary) > MAX_SUMMARY_LENGTH:
        raise ValueError("DianDian reply is empty or too long after footer cleanup")
    normalized_title = title.strip()
    if (
        SENSITIVE_SOURCE_PATTERN.search(_sensitive_scan_text(normalized_title))
        or SENSITIVE_SOURCE_PATTERN.search(_sensitive_scan_text(summary))
    ):
        raise ValueError("DianDian reply contains sensitive source data")

    record: dict[str, str | int] = {
        "version": 1,
        "provider": "xiaohongshu-diandian",
        "prompt": "总结",
        "note_id": normalized_note_id,
        "title": normalized_title,
        "summary": summary,
        "request_sha256": hashlib.sha256(
            f"{normalized_title}\0{summary_text.strip()}".encode("utf-8")
        ).hexdigest(),
        "captured_at": captured_at or datetime.now(timezone.utc).isoformat(),
    }
    return record


def serialize_record(record: dict[str, str | int]) -> str:
    return json.dumps(record, ensure_ascii=False, indent=2) + "\n"


def _write_record_unlocked(destination: Path, record: dict[str, str | int]) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(
        f".{destination.name}.{os.getpid()}.{threading.get_ident()}.tmp"
    )
    try:
        temporary.write_text(serialize_record(record), encoding="utf-8")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def _resolved_private_root(private_root: Path) -> Path:
    resolved_root = private_root.resolve()
    if resolved_root.name != "diandian-summaries" or resolved_root.parent.name != ".xhs-favorites":
        raise ValueError("private root must end with .xhs-favorites/diandian-summaries")
    return resolved_root


def _plain_file_or_missing(path: Path) -> bool:
    if path.is_symlink():
        raise ValueError("DianDian batch transaction path is unsafe")
    if not path.exists():
        return False
    if not path.is_file():
        raise ValueError("DianDian batch transaction path must be a regular file")
    return True


def _batch_transaction_paths(
    private_root: Path, transaction_id: str, item: object
) -> tuple[Path, Path, Path | None, bool]:
    if not isinstance(item, dict) or set(item) != {
        "destination", "stage", "backup", "had_original"
    }:
        raise ValueError("DianDian batch journal item is invalid")
    destination_name = item["destination"]
    stage_name = item["stage"]
    backup_name = item["backup"]
    had_original = item["had_original"]
    if not isinstance(destination_name, str):
        raise ValueError("DianDian batch journal path is invalid")
    destination_match = re.fullmatch(
        rf"({NOTE_ID_PATTERN.pattern[1:-1]})\.json", destination_name
    )
    expected_stage = f".{destination_name}.{transaction_id}.stage"
    expected_backup = f".{destination_name}.{transaction_id}.backup"
    if (
        destination_match is None
        or stage_name != expected_stage
        or not isinstance(had_original, bool)
        or backup_name != (expected_backup if had_original else None)
    ):
        raise ValueError("DianDian batch journal path is invalid")
    destination = private_root / destination_name
    stage = private_root / expected_stage
    backup = private_root / expected_backup if had_original else None
    return destination, stage, backup, had_original


def _write_batch_journal(private_root: Path, journal: dict[str, object]) -> None:
    destination = private_root / BATCH_JOURNAL_NAME
    temporary = private_root / f"{BATCH_JOURNAL_NAME}.{uuid4().hex}.tmp"
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump(journal, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def _recover_batch_transaction_unlocked(private_root: Path) -> None:
    journal_path = private_root / BATCH_JOURNAL_NAME
    if not _plain_file_or_missing(journal_path):
        return
    if journal_path.stat().st_size > 512 * 1024:
        raise ValueError("DianDian batch journal is too large")
    try:
        journal = json.loads(journal_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError("DianDian batch journal is invalid") from error
    if (
        not isinstance(journal, dict)
        or set(journal) != {"version", "transaction_id", "status", "items"}
        or journal.get("version") != 1
        or not isinstance(journal.get("transaction_id"), str)
        or re.fullmatch(r"[a-f0-9]{32}", journal["transaction_id"]) is None
        or journal.get("status") not in {"prepared", "committed"}
        or not isinstance(journal.get("items"), list)
        or not journal["items"]
        or len(journal["items"]) > 500
    ):
        raise ValueError("DianDian batch journal is invalid")
    paths = [
        _batch_transaction_paths(private_root, journal["transaction_id"], item)
        for item in journal["items"]
    ]
    if len({destination for destination, *_rest in paths}) != len(paths):
        raise ValueError("DianDian batch journal contains duplicate destinations")
    if journal["status"] == "prepared":
        for destination, stage, backup, had_original in reversed(paths):
            if had_original:
                if backup is not None and _plain_file_or_missing(backup):
                    if _plain_file_or_missing(destination):
                        destination.unlink()
                    backup.replace(destination)
                elif not _plain_file_or_missing(destination):
                    raise ValueError("DianDian batch rollback source is unavailable")
            elif not _plain_file_or_missing(stage) and _plain_file_or_missing(destination):
                destination.unlink()
    else:
        for destination, _stage, _backup, _had_original in paths:
            if not _plain_file_or_missing(destination):
                raise ValueError("DianDian committed batch record is unavailable")
    for _destination, stage, backup, _had_original in paths:
        if _plain_file_or_missing(stage):
            stage.unlink()
        if backup is not None and _plain_file_or_missing(backup):
            backup.unlink()
    journal_path.unlink()


def _process_is_active(pid: object) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        open_process = kernel32.OpenProcess
        open_process.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        open_process.restype = wintypes.HANDLE
        get_exit_code = kernel32.GetExitCodeProcess
        get_exit_code.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        get_exit_code.restype = wintypes.BOOL
        close_handle = kernel32.CloseHandle
        close_handle.argtypes = (wintypes.HANDLE,)
        close_handle.restype = wintypes.BOOL

        # os.kill(pid, 0) broadcasts CTRL_C_EVENT on Windows.
        handle = open_process(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() != 87
        try:
            exit_code = wintypes.DWORD()
            if not get_exit_code(handle, ctypes.byref(exit_code)):
                return True
            return exit_code.value == 259
        finally:
            close_handle(handle)
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False


@contextmanager
def _organization_mutation_lock(resolved_root: Path) -> Iterator[None]:
    lock_parent = resolved_root.parent / "organization-migration"
    lock_parent.mkdir(parents=True, exist_ok=True)
    if lock_parent.is_symlink() or not lock_parent.is_dir():
        raise ValueError("organization mutation lock root is unsafe")
    lock_path = lock_parent / ".apply-lock"
    nonce = uuid4().hex
    candidate = lock_parent / f".apply-lock.candidate-{nonce}"
    candidate.mkdir()
    (candidate / "owner.json").write_text(
        json.dumps({"schema_version": 1, "pid": os.getpid(), "nonce": nonce}) + "\n",
        encoding="utf-8",
    )
    deadline = time.monotonic() + PRIVATE_STORE_LOCK_TIMEOUT_SECONDS
    acquired = False
    try:
        while not acquired:
            try:
                candidate.rename(lock_path)
                acquired = True
                break
            except OSError as error:
                if not lock_path.exists():
                    raise
                if lock_path.is_symlink() or not lock_path.is_dir():
                    raise ValueError("organization mutation lock is unsafe") from error
                try:
                    owner = json.loads(
                        (lock_path / "owner.json").read_text(encoding="utf-8")
                    )
                except (OSError, ValueError, TypeError, json.JSONDecodeError) as owner_error:
                    raise ValueError("organization mutation lock is invalid") from owner_error
                if _process_is_active(owner.get("pid")):
                    if time.monotonic() >= deadline:
                        raise TimeoutError(
                            "timed out waiting for the organization mutation lock"
                        ) from error
                    time.sleep(0.05)
                    continue
                stale = lock_parent / f".apply-lock.stale-{uuid4().hex}"
                try:
                    lock_path.rename(stale)
                except OSError:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(
                            "timed out waiting for the organization mutation lock"
                        ) from error
                    time.sleep(0.05)
                    continue
                try:
                    candidate.rename(lock_path)
                    acquired = True
                finally:
                    shutil.rmtree(stale, ignore_errors=True)
        yield
    finally:
        shutil.rmtree(candidate, ignore_errors=True)
        if acquired:
            try:
                owner = json.loads(
                    (lock_path / "owner.json").read_text(encoding="utf-8")
                )
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                owner = {}
            if owner.get("nonce") == nonce:
                shutil.rmtree(lock_path)


@contextmanager
def private_store_lock(private_root: Path) -> Iterator[None]:
    """Serialize all single and batch writers across threads and processes."""
    resolved_root = _resolved_private_root(private_root)
    resolved_root.mkdir(parents=True, exist_ok=True)
    with _PRIVATE_STORE_THREAD_LOCKS_GUARD:
        thread_lock = _PRIVATE_STORE_THREAD_LOCKS.setdefault(
            resolved_root, threading.RLock()
        )
    with thread_lock:
        with _organization_mutation_lock(resolved_root):
            lock_path = resolved_root / ".writer.lock"
            with lock_path.open("a+b") as lock_file:
                lock_file.seek(0, os.SEEK_END)
                if lock_file.tell() == 0:
                    lock_file.write(b"\0")
                    lock_file.flush()
                deadline = time.monotonic() + PRIVATE_STORE_LOCK_TIMEOUT_SECONDS
                while True:
                    try:
                        lock_file.seek(0)
                        if msvcrt is not None:
                            msvcrt.locking(lock_file.fileno(), msvcrt.LK_NBLCK, 1)
                        elif fcntl is not None:
                            fcntl.flock(
                                lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB
                            )
                        else:  # pragma: no cover - all supported platforms provide one.
                            raise RuntimeError("interprocess file locking is unavailable")
                        break
                    except OSError as error:
                        if error.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                            raise
                        if time.monotonic() >= deadline:
                            raise TimeoutError(
                                "timed out waiting for the DianDian private store lock"
                            ) from error
                        time.sleep(0.05)
                try:
                    _recover_batch_transaction_unlocked(resolved_root)
                    yield
                finally:
                    lock_file.seek(0)
                    if msvcrt is not None:
                        msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
                    elif fcntl is not None:
                        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def write_record(destination: Path, record: dict[str, str | int]) -> None:
    with private_store_lock(destination.parent):
        _write_record_unlocked(destination, record)


def save_record(
    destination: Path,
    title: str,
    summary_text: str,
    note_id: str,
) -> dict[str, str | int]:
    record = build_record(title, summary_text, note_id)
    expected_destination = private_destination(destination.parent, str(record["note_id"]))
    if destination.resolve() != expected_destination:
        raise ValueError("destination must be the private <note_id>.json path")
    write_record(destination, record)
    return record


def private_destination(private_root: Path, note_id: str) -> Path:
    resolved_root = _resolved_private_root(private_root)
    if not NOTE_ID_PATTERN.fullmatch(note_id.strip()):
        raise ValueError("note_id contains unsupported characters")
    return resolved_root / f"{note_id.strip()}.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Clean a DianDian AI reply and save it without source URLs or tokens."
    )
    parser.add_argument("--input", required=True, type=Path, help="UTF-8 reply text file")
    parser.add_argument("--private-root", required=True, type=Path, help="Private .xhs-favorites/diandian-summaries directory")
    parser.add_argument("--title", required=True, help="Xiaohongshu note title")
    parser.add_argument("--note-id", required=True, help="Stable Xiaohongshu note identifier")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.input.stat().st_size > MAX_SUMMARY_INPUT_BYTES:
        raise ValueError("DianDian reply input is too large")
    reply = args.input.read_text(encoding="utf-8")
    save_record(private_destination(args.private_root, args.note_id), args.title, reply, args.note_id)


if __name__ == "__main__":
    main()
