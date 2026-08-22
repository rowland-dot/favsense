#!/usr/bin/env python3

"""Run an explicitly configured local OCR engine on sealed cached images only."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from datetime import datetime, timezone


NOTE_ID = re.compile(r"^[a-f0-9]{24}$")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


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


def extract_cached_images(media_dir: Path, analysis_dir: Path, *, engine: Path | None, allowed_note_ids: set[str], runner=subprocess.run):
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
        completed = runner([str(engine), str(image)], capture_output=True, text=True, encoding="utf-8", timeout=60, check=False)
        if completed.returncode != 0:
            failed += 1
            records.append({"note_id": image.stem, "status": "failed", "reason_code": "ocr_failed"})
            continue
        text = re.sub(r"\s+", " ", str(completed.stdout or "")).strip()
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
