#!/usr/bin/env python3
"""Validate and import completed DianDian results into the private keyed store."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import threading
from uuid import uuid4

from save_diandian_summary import (
    MAX_SUMMARY_LENGTH,
    MAX_TITLE_LENGTH,
    build_record,
    private_destination,
    private_store_lock,
    serialize_record,
)


MAX_BATCH_ITEMS = 500
MAX_BATCH_INPUT_BYTES = MAX_BATCH_ITEMS * (
    MAX_SUMMARY_LENGTH + MAX_TITLE_LENGTH + 512
)


def _commit_records_locked(
    prepared: list[tuple[Path, dict[str, str | int]]],
) -> None:
    staged: list[tuple[Path, Path]] = []
    backups: list[tuple[Path, Path | None]] = []
    rollback_failed = False
    transaction_id = f"{os.getpid()}.{threading.get_ident()}.{uuid4().hex}"
    try:
        for destination, record in prepared:
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(
                f".{destination.name}.{transaction_id}.stage"
            )
            temporary.write_text(serialize_record(record), encoding="utf-8")
            staged.append((destination, temporary))

        for destination, temporary in staged:
            backup = None
            if destination.exists():
                if not destination.is_file():
                    raise ValueError("DianDian destination must be a regular file")
                backup = destination.with_name(
                    f".{destination.name}.{transaction_id}.backup"
                )
                destination.replace(backup)
            backups.append((destination, backup))
            temporary.replace(destination)
    except Exception:
        rollback_error = None
        for destination, backup in reversed(backups):
            try:
                destination.unlink(missing_ok=True)
                if backup is not None and backup.exists():
                    backup.replace(destination)
            except OSError as error:
                rollback_error = rollback_error or error
        if rollback_error is not None:
            rollback_failed = True
            raise RuntimeError("DianDian batch rollback failed") from rollback_error
        raise
    finally:
        for _destination, temporary in staged:
            temporary.unlink(missing_ok=True)
        if not rollback_failed:
            for _destination, backup in backups:
                if backup is not None:
                    backup.unlink(missing_ok=True)


def commit_records(
    prepared: list[tuple[Path, dict[str, str | int]]],
) -> None:
    if not prepared:
        return
    private_root = prepared[0][0].parent
    for destination, record in prepared:
        note_id = record.get("note_id")
        if not isinstance(note_id, str):
            raise ValueError("DianDian record note_id must be a string")
        if destination.resolve() != private_destination(private_root, note_id):
            raise ValueError("batch destinations must share one private keyed store")
    with private_store_lock(private_root):
        _commit_records_locked(prepared)


def import_batch(input_file: Path, private_root: Path) -> int:
    if input_file.stat().st_size > MAX_BATCH_INPUT_BYTES:
        raise ValueError("batch input is too large")
    payload = json.loads(input_file.read_text(encoding="utf-8"))
    items = payload.get("succeeded") if isinstance(payload, dict) else None
    if not isinstance(payload, dict) or set(payload) != {"succeeded"}:
        raise ValueError("batch must contain only succeeded")
    if not isinstance(items, list) or len(items) > MAX_BATCH_ITEMS:
        raise ValueError("batch succeeded must be a list with at most 500 items")
    seen: set[str] = set()
    prepared: list[tuple[Path, dict[str, str | int]]] = []
    for item in items:
        if not isinstance(item, dict) or set(item) != {"note_id", "title", "summary"}:
            raise ValueError("each batch result must contain only note_id, title and summary")
        if not all(isinstance(item[key], str) for key in ("note_id", "title", "summary")):
            raise ValueError("batch note_id, title and summary must be strings")
        note_id = item["note_id"]
        if note_id in seen:
            raise ValueError("batch contains a duplicate note_id")
        seen.add(note_id)
        destination = private_destination(private_root, note_id)
        record = build_record(item["title"], item["summary"], note_id)
        prepared.append((destination, record))
    commit_records(prepared)
    return len(items)


def main() -> None:
    parser = argparse.ArgumentParser(description="Import a private DianDian run after validating every result.")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--private-root", required=True, type=Path)
    args = parser.parse_args()
    count = import_batch(args.input, args.private_root)
    print(json.dumps({"saved": count}))


if __name__ == "__main__":
    main()
