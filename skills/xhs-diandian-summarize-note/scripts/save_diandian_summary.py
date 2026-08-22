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
import threading
import time
import unicodedata
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
