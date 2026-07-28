#!/usr/bin/env python3

import argparse
import math
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import time


NOTE_ID = re.compile(r"^[a-f0-9]{24}$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract reviewable frames from uncatalogued local videos.")
    parser.add_argument("--media-dir", required=True)
    parser.add_argument("--curation", required=True)
    parser.add_argument("--catalog")
    parser.add_argument("--config")
    parser.add_argument("--analysis-dir", required=True)
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--ffprobe", required=True)
    parser.add_argument("--max-items", type=int, default=5)
    parser.add_argument("--window-seconds", type=float, default=30)
    parser.add_argument("--max-total-frames", type=int, default=60)
    parser.add_argument("--max-total-bytes", type=int, default=20 * 1024 * 1024)
    parser.add_argument("--max-wall-seconds", type=float, default=120)
    parser.add_argument("--review-pages-only", action="store_true")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Extract sparse evidence without a transcription recommendation.",
    )
    parser.add_argument(
        "--dense-range",
        action="append",
        default=[],
        metavar="START:END",
        help="Add 0.5-second evidence only for an unresolved time range.",
    )
    return parser.parse_args()


def build_frame_queue(
    media_dir: Path,
    curation: dict,
    analysis_dir: Path,
    max_items: int,
    allowed_note_ids: set[str] | None = None,
    require_visual_recommendation: bool = True,
) -> list[dict]:
    if max_items < 1 or max_items > 25:
        raise ValueError("--max-items must be between 1 and 25")
    queue = []
    for video in sorted(media_dir.glob("*.mp4"), key=lambda item: item.name):
        note_id = video.stem
        if (
            not NOTE_ID.fullmatch(note_id)
            or note_id in curation
            or (allowed_note_ids is not None and note_id not in allowed_note_ids)
        ):
            continue
        if require_visual_recommendation:
            transcript_path = analysis_dir / note_id / "transcription.json"
            try:
                transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
                visual_review = transcript.get("visual_review", {})
                visual_level = visual_review.get("level")
                missing_facts = visual_review.get("missing_facts") or []
            except (OSError, json.JSONDecodeError):
                continue
            if (
                transcript.get("status") != "transcribed"
                or visual_level not in {"sparse", "dense"}
                or not missing_facts
            ):
                continue
        else:
            missing_facts = ["manual-visual-check"]
        manifest = analysis_dir / note_id / "extraction.json"
        start_seconds = 0.0
        if manifest.is_file():
            try:
                existing = json.loads(manifest.read_text(encoding="utf-8"))
                if existing.get("status") in {
                    "frames-extracted", "visual-evidence-extracted",
                    "visual-evidence-resolved", "visual-source-exhausted",
                }:
                    continue
                start_seconds = float(existing.get("next_start_seconds") or 0.0)
            except (OSError, json.JSONDecodeError):
                pass
        queue.append({
            "note_id": note_id,
            "video": video,
            "start_seconds": start_seconds,
            "missing_facts": list(missing_facts),
        })
        if len(queue) >= max_items:
            break
    return queue


def build_review_queue(
    analysis_dir: Path,
    curation: dict,
    max_items: int,
    allowed_note_ids: set[str] | None = None,
) -> list[dict]:
    if max_items < 1 or max_items > 25:
        raise ValueError("--max-items must be between 1 and 25")
    queue = []
    for note_dir in sorted(analysis_dir.iterdir(), key=lambda item: item.name):
        note_id = note_dir.name
        if (
            not note_dir.is_dir()
            or not NOTE_ID.fullmatch(note_id)
            or note_id in curation
            or (allowed_note_ids is not None and note_id not in allowed_note_ids)
        ):
            continue
        manifest_path = note_dir / "extraction.json"
        frames_dir = note_dir / "frames"
        review_dir = note_dir / "review-pages-100"
        if not manifest_path.is_file() or not frames_dir.is_dir():
            continue
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if manifest.get("status") not in {
            "frames-extracted", "visual-evidence-extracted",
            "visual-window-ready", "visual-source-exhausted",
        }:
            continue
        if review_dir.is_dir() and any(review_dir.glob("page_*.jpg")):
            continue
        queue.append({"note_id": note_id, "note_dir": note_dir, "manifest": manifest})
        if len(queue) >= max_items:
            break
    return queue


def normalize_published_since(value: str | None) -> str | None:
    if value in (None, ""):
        return None
    date = str(value).strip()
    if not ISO_DATE.fullmatch(date):
        raise ValueError("published_since must use YYYY-MM-DD")
    datetime.strptime(date, "%Y-%m-%d")
    return date


def catalog_note_ids(catalog: dict, published_since: str | None = None) -> set[str]:
    notes = catalog.get("notes")
    if not isinstance(notes, dict):
        raise ValueError("catalog must contain a notes object")
    cutoff = normalize_published_since(published_since)
    selected = set()
    for note_id, note in notes.items():
        if not NOTE_ID.fullmatch(note_id) or not isinstance(note, dict):
            continue
        if cutoff is not None:
            published = str(note.get("published_at") or "").strip()[:10]
            if not ISO_DATE.fullmatch(published) or published < cutoff:
                continue
        selected.add(note_id)
    return selected


def run(command: list[str], timeout: int = 900) -> None:
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=timeout, check=False)
    if result.returncode != 0:
        raise RuntimeError("ffmpeg processing failed")


def create_review_pages(ffmpeg: Path, note_dir: Path, frame_count: int) -> int:
    frames = sorted((note_dir / "frames").glob("seq_*.jpg"))
    if frame_count < 1 or not frames:
        raise ValueError("sequence frames are required for review pages")
    review_dir = note_dir / "review-pages-100"
    review_dir.mkdir(parents=True, exist_ok=True)
    expected_pages = math.ceil(len(frames) / 100)
    concat_file = review_dir / "frames.concat.txt"
    concat_file.write_text(
        "".join(f"file '{str(frame.resolve()).replace(chr(39), chr(39) * 2)}'\n" for frame in frames),
        encoding="utf-8",
    )
    try:
        run([
            str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
            "-f", "concat", "-safe", "0", "-i", str(concat_file),
            "-vf", "scale=180:-2,tile=10x10:padding=2:margin=2",
            "-fps_mode", "vfr", "-frames:v", str(expected_pages), "-q:v", "3",
            str(review_dir / "page_%03d.jpg"),
        ])
    finally:
        concat_file.unlink(missing_ok=True)
    page_count = len(list(review_dir.glob("page_*.jpg")))
    if page_count != expected_pages:
        raise RuntimeError("review page generation was incomplete")
    return page_count


def probe_duration(ffprobe: Path, video: Path) -> float:
    result = subprocess.run(
        [str(ffprobe), "-v", "error", "-show_entries", "format=duration", "-of", "json", str(video)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("ffprobe failed")
    duration = float(json.loads(result.stdout)["format"]["duration"])
    if duration <= 0 or duration > 7200:
        raise ValueError("video duration is outside the supported range")
    return duration


def parse_dense_ranges(values: list[str], duration: float) -> list[tuple[float, float]]:
    ranges = []
    for value in values:
        match = re.fullmatch(r"(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)", value.strip())
        if not match:
            raise ValueError("dense ranges must use START:END seconds")
        start, end = (float(match.group(1)), float(match.group(2)))
        if start < 0 or end <= start or end > duration:
            raise ValueError("dense range is outside the video duration")
        ranges.append((start, end))
    return ranges


def extract_video(
    ffmpeg: Path,
    ffprobe: Path,
    item: dict,
    analysis_dir: Path,
    dense_range_values: list[str] | None = None,
    window_seconds: float = 30,
    max_total_frames: int = 60,
    max_total_bytes: int = 20 * 1024 * 1024,
    max_wall_seconds: float = 120,
) -> dict:
    if window_seconds <= 0 or max_wall_seconds <= 0:
        raise ValueError("visual window and wall-time budgets must be positive")
    if max_total_frames < 1 or max_total_frames > 500:
        raise ValueError("max total frames must be between 1 and 500")
    if max_total_bytes < 1024:
        raise ValueError("max total bytes is too small")
    note_dir = analysis_dir / item["note_id"]
    sequence_dir = note_dir / "frames"
    scene_dir = note_dir / "scenes"
    sequence_dir.mkdir(parents=True, exist_ok=True)
    scene_dir.mkdir(parents=True, exist_ok=True)
    duration = probe_duration(ffprobe, item["video"])
    start = max(0.0, float(item.get("start_seconds") or 0.0))
    if start >= duration:
        raise ValueError("visual review has reached the end of the video")
    end = min(duration, start + window_seconds)
    window_duration = end - start
    dense_ranges = parse_dense_ranges(dense_range_values or [], duration)
    if len(dense_ranges) > 1:
        raise ValueError("only one targeted dense range is allowed per review window")
    if dense_ranges and not (start <= dense_ranges[0][0] < dense_ranges[0][1] <= end):
        raise ValueError("dense range must stay inside the current review window")
    evidence_dirs = [sequence_dir, scene_dir, note_dir / "dense"]
    existing_files = {
        path for directory in evidence_dirs if directory.exists()
        for path in directory.glob("*.jpg")
    }
    existing_files.update(note_dir.glob("overview_*.jpg"))
    existing_count = len(existing_files)
    existing_bytes = sum(path.stat().st_size for path in existing_files)
    remaining_frames = max_total_frames - existing_count
    remaining_bytes = max_total_bytes - existing_bytes
    if remaining_frames < 1 or remaining_bytes < 1:
        raise RuntimeError("visual evidence budget is exhausted")
    manifest_path = note_dir / "extraction.json"
    previous = {}
    if manifest_path.is_file():
        try:
            previous = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            previous = {}
    window_index = len(previous.get("windows") or []) + 1
    started = time.monotonic()

    def bounded_run(command: list[str]) -> None:
        remaining = max_wall_seconds - (time.monotonic() - started)
        if remaining <= 0:
            raise RuntimeError("visual wall-time budget is exhausted")
        run(command, timeout=max(1, int(remaining)))

    sequence_limit = min(6, remaining_frames)
    bounded_run([
        str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
        "-ss", str(start), "-t", str(window_duration), "-i", str(item["video"]),
        "-vf", "fps=0.2,scale='min(1600,iw)':-2", "-frames:v", str(sequence_limit),
        "-q:v", "3", str(sequence_dir / f"seq_w{window_index:03d}_%04d.jpg"),
    ])
    remaining_frames -= len(list(sequence_dir.glob(f"seq_w{window_index:03d}_*.jpg")))
    if remaining_frames > 0:
        scene_limit = min(6, remaining_frames)
        bounded_run([
            str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
            "-ss", str(start), "-t", str(window_duration), "-i", str(item["video"]),
            "-vf", "select=gt(scene\\,0.22),scale='min(1600,iw)':-2", "-fps_mode", "vfr",
            "-frames:v", str(scene_limit), "-q:v", "2",
            str(scene_dir / f"scene_w{window_index:03d}_%04d.jpg"),
        ])
        remaining_frames -= len(list(scene_dir.glob(f"scene_w{window_index:03d}_*.jpg")))
    dense_frame_count = 0
    if dense_ranges and remaining_frames > 0:
        dense_dir = note_dir / "dense"
        dense_dir.mkdir(parents=True, exist_ok=True)
        dense_start, dense_end = dense_ranges[0]
        dense_limit = min(remaining_frames, max(1, int((dense_end - dense_start) * 2)))
        bounded_run([
            str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
            "-ss", str(dense_start), "-t", str(dense_end - dense_start), "-i", str(item["video"]),
            "-vf", "fps=2,scale='min(1600,iw)':-2", "-frames:v", str(dense_limit), "-q:v", "2",
            str(dense_dir / f"range_w{window_index:03d}_%04d.jpg"),
        ])
        dense_frame_count = len(list(dense_dir.glob(f"range_w{window_index:03d}_*.jpg")))
    created_files = {
        path for directory in evidence_dirs if directory.exists()
        for path in directory.glob("*.jpg")
    } - existing_files
    total_files = existing_files | created_files
    total_bytes = sum(path.stat().st_size for path in total_files)
    if len(total_files) > max_total_frames or total_bytes > max_total_bytes:
        for path in created_files:
            path.unlink(missing_ok=True)
        raise RuntimeError("visual frame or byte budget was exceeded")
    windows = list(previous.get("windows") or [])
    windows.append({
        "start": round(start, 3),
        "end": round(end, 3),
        "missing_facts": list(item.get("missing_facts") or []),
    })
    source_exhausted = end >= duration - 0.01
    manifest = {
        "status": "visual-source-exhausted" if source_exhausted else "visual-window-ready",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "duration_seconds": round(duration, 3),
        "sequence_frame_count": len(list(sequence_dir.glob("*.jpg"))),
        "scene_frame_count": len(list(scene_dir.glob("scene_*.jpg"))),
        "dense_frame_count": len(list((note_dir / "dense").glob("*.jpg"))) if (note_dir / "dense").exists() else 0,
        "dense_ranges": [{"start": start, "end": end} for start, end in dense_ranges],
        "review_page_count": 0,
        "windows": windows,
        "next_start_seconds": round(end, 3),
        "source_exhausted": source_exhausted,
        "missing_facts": list(item.get("missing_facts") or []),
        "budget": {
            "max_frames": max_total_frames,
            "used_frames": len(total_files),
            "max_bytes": max_total_bytes,
            "used_bytes": total_bytes,
            "max_wall_seconds": max_wall_seconds,
        },
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return manifest


def main() -> None:
    args = parse_args()
    media_dir = Path(args.media_dir).resolve()
    analysis_dir = Path(args.analysis_dir).resolve()
    ffmpeg = Path(args.ffmpeg).resolve()
    ffprobe = Path(args.ffprobe).resolve()
    if not ffmpeg.is_file() or not ffprobe.is_file():
        raise ValueError("ffmpeg and ffprobe executables are required")
    curation = json.loads(Path(args.curation).resolve().read_text(encoding="utf-8"))
    allowed_note_ids = None
    if args.catalog:
        catalog = json.loads(Path(args.catalog).resolve().read_text(encoding="utf-8"))
        published_since = None
        if args.config:
            config = json.loads(Path(args.config).resolve().read_text(encoding="utf-8-sig"))
            published_since = config.get("published_since")
        allowed_note_ids = catalog_note_ids(catalog, published_since)
    queue = build_frame_queue(
        media_dir,
        curation,
        analysis_dir,
        args.max_items,
        allowed_note_ids=allowed_note_ids,
        require_visual_recommendation=not args.force,
    ) if not args.review_pages_only else build_review_queue(
        analysis_dir, curation, args.max_items, allowed_note_ids=allowed_note_ids
    )
    completed = 0
    failed = 0
    for item in queue:
        try:
            if args.review_pages_only:
                manifest = item["manifest"]
                manifest["review_page_count"] = create_review_pages(
                    ffmpeg, item["note_dir"], int(manifest.get("sequence_frame_count", 0))
                )
                (item["note_dir"] / "extraction.json").write_text(
                    json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
                )
            else:
                extract_video(
                    ffmpeg, ffprobe, item, analysis_dir, args.dense_range,
                    window_seconds=args.window_seconds,
                    max_total_frames=args.max_total_frames,
                    max_total_bytes=args.max_total_bytes,
                    max_wall_seconds=args.max_wall_seconds,
                )
            completed += 1
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
            failed += 1
    result_key = "review_pages_generated" if args.review_pages_only else "frames_extracted"
    print(json.dumps({"queued": len(queue), result_key: completed, "failed": failed}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print(f"frame-extractor: {error}")
        raise SystemExit(1) from error
