#!/usr/bin/env python3
"""Validate and import completed DianDian results into the private keyed store."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from uuid import uuid4

from save_diandian_summary import (
    BATCH_JOURNAL_NAME,
    MAX_SUMMARY_LENGTH,
    MAX_TITLE_LENGTH,
    _recover_batch_transaction_unlocked,
    _note_filename_identity,
    _reject_existing_filename_alias,
    _write_batch_journal,
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
    transaction_id = uuid4().hex
    private_root = prepared[0][0].parent
    journal_path = private_root / BATCH_JOURNAL_NAME
    items: list[dict[str, object]] = []
    try:
        filename_identities: set[str] = set()
        for destination, record in prepared:
            note_id = str(record["note_id"])
            filename_identity = _note_filename_identity(note_id)
            if filename_identity in filename_identities:
                raise ValueError("batch contains a case-insensitive filename alias")
            filename_identities.add(filename_identity)
            _reject_existing_filename_alias(private_root, destination)
            temporary = destination.with_name(
                f".{destination.name}.{transaction_id}.stage"
            )
            backup = destination.with_name(
                f".{destination.name}.{transaction_id}.backup"
            )
            if destination.is_symlink() or (
                destination.exists() and not destination.is_file()
            ):
                raise ValueError("DianDian destination must be a regular file")
            items.append({
                "destination": destination.name,
                "stage": temporary.name,
                "backup": backup.name if destination.exists() else None,
                "had_original": destination.exists(),
            })
            staged.append((destination, temporary))
        _write_batch_journal(private_root, {
            "version": 1,
            "transaction_id": transaction_id,
            "status": "prepared",
            "items": items,
        })
        for (_destination, temporary), (_destination_again, record) in zip(
            staged, prepared, strict=True
        ):
            with temporary.open("x", encoding="utf-8") as handle:
                handle.write(serialize_record(record))
                handle.flush()
                os.fsync(handle.fileno())

        for (destination, temporary), item in zip(staged, items, strict=True):
            if item["had_original"]:
                backup = private_root / str(item["backup"])
                destination.replace(backup)
            temporary.replace(destination)
        _write_batch_journal(private_root, {
            "version": 1,
            "transaction_id": transaction_id,
            "status": "committed",
            "items": items,
        })
        _recover_batch_transaction_unlocked(private_root)
    except Exception:
        if journal_path.exists():
            try:
                _recover_batch_transaction_unlocked(private_root)
            except (OSError, ValueError) as rollback_error:
                raise RuntimeError("DianDian batch rollback failed") from rollback_error
        raise
    finally:
        if not journal_path.exists():
            for _destination, temporary in staged:
                temporary.unlink(missing_ok=True)


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
        filename_identity = _note_filename_identity(note_id)
        if filename_identity in seen:
            raise ValueError("batch contains a duplicate note_id or filename alias")
        seen.add(filename_identity)
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
