#!/usr/bin/env python3

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import tempfile


NOTE_ID = re.compile(r"^[a-f0-9]{24}$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ENTITY_TOPIC = re.compile(
    r"skill|github|开源|项目|工具|网站|插件|工作流|workflow|agent|软件|应用",
    re.IGNORECASE,
)
VISUAL_CUE = re.compile(r"屏幕|画面|看这里|看这个|这个技能|这个项目|这个工具")
HIDDEN_NAME_CUE = re.compile(r"记住这个(?:项目|工具|技能)?名字|今天要说的是[它他]?|名字就在画面")
REPO_OR_URL = re.compile(
    r"https?://\S+|github(?:\.com)?[/：:\s]+[\w.-]+/[\w.-]+|\b[\w.-]+/[\w.-]+\b",
    re.IGNORECASE,
)
REPOSITORY_CUE = re.compile(r"github|开源|代码仓库|官方仓库|repository|\brepo\b", re.IGNORECASE)
GITHUB_REPOSITORY = re.compile(
    r"https?://github\.com/\s*[\w.-]+\s*/\s*[\w.-]+"
    r"|github(?:\.com)?\s*[/：:]\s*[\w.-]+\s*/\s*[\w.-]+"
    r"|(?:repository|repo|仓库)\s*"
    r"(?:is|=|:|：|是|为|名为|地址(?:是|为)?|链接(?:是|为)?)\s*"
    r"[\w.-]+\s*/\s*[\w.-]+",
    re.IGNORECASE,
)
NAMED_ENTITY = re.compile(
    r"(?:(?<!什么)叫做?|名为|名称是|项目名是|工具名是|技能名是)\s*[《「『\"']?"
    r"([A-Za-z][A-Za-z0-9_.-]{2,}|[\u4e00-\u9fff]{2,12})",
    re.IGNORECASE,
)
LISTED_ENTITY = re.compile(
    r"(?:第[一二三四五六七八九十\d]+个|首先|其次|最后一个)\s*"
    r"([A-Za-z][A-Za-z0-9_.-]{2,})",
    re.IGNORECASE,
)
TAGGED_ENTITY = re.compile(r"#\s*([A-Za-z][A-Za-z0-9_.-]{2,})")
GENERIC_ENTITY_TAGS = {
    "ai", "agent", "github", "skill", "skills", "tool", "tools",
    "video", "audio", "translation", "software", "workflow", "tutorial",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Transcribe pending local videos before deciding whether visual review is needed."
    )
    parser.add_argument("--media-dir", required=True)
    parser.add_argument("--curation", required=True)
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--analysis-dir", required=True)
    parser.add_argument("--ffmpeg", required=True)
    parser.add_argument("--ffprobe", required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--language", default="zh")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--max-items", type=int, default=20)
    parser.add_argument("--max-item-seconds", type=float, default=600)
    parser.add_argument("--max-batch-seconds", type=float, default=900)
    parser.add_argument("--status-file")
    parser.add_argument("--keep-audio", action="store_true")
    parser.add_argument("--reassess-only", action="store_true")
    return parser.parse_args()


def normalize_published_since(value: str | None) -> str | None:
    if value in (None, ""):
        return None
    date = str(value).strip()
    if not ISO_DATE.fullmatch(date):
        raise ValueError("published_since must use YYYY-MM-DD")
    datetime.strptime(date, "%Y-%m-%d")
    return date


def catalog_notes(catalog: dict, published_since: str | None = None) -> dict:
    notes = catalog.get("notes")
    if not isinstance(notes, dict):
        raise ValueError("catalog must contain a notes object")
    cutoff = normalize_published_since(published_since)
    selected = {}
    for note_id, note in notes.items():
        if not NOTE_ID.fullmatch(note_id) or not isinstance(note, dict):
            continue
        if cutoff is not None:
            published = str(note.get("published_at") or "").strip()[:10]
            if not ISO_DATE.fullmatch(published) or published < cutoff:
                continue
        selected[note_id] = note
    return selected


def build_transcription_queue(
    media_dir: Path,
    curation: dict,
    analysis_dir: Path,
    max_items: int,
    allowed_note_ids: set[str] | None = None,
) -> list[dict]:
    if max_items < 1 or max_items > 100:
        raise ValueError("--max-items must be between 1 and 100")
    candidates = []
    for video in media_dir.glob("*.mp4"):
        note_id = video.stem
        if (
            not NOTE_ID.fullmatch(note_id)
            or note_id in curation
            or (allowed_note_ids is not None and note_id not in allowed_note_ids)
        ):
            continue
        transcript_path = analysis_dir / note_id / "transcription.json"
        resume_start = 0.0
        if transcript_path.is_file():
            try:
                transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
                status = transcript.get("status")
                window = transcript.get("audio_window") or {}
                missing_facts = transcript.get("visual_review", {}).get("missing_facts") or []
                needs_continuation = bool(window.get("truncated") and missing_facts)
                if status == "transcribed" and not needs_continuation:
                    continue
                if status in {"partial", "transcribed"} and needs_continuation:
                    resume_start = float(window.get("next_start", window.get("end", 0.0)) or 0.0)
            except (OSError, json.JSONDecodeError):
                pass
        candidates.append({
            "note_id": note_id,
            "video": video,
            "resume_start_seconds": resume_start,
        })
    candidates.sort(key=lambda item: (item["video"].stat().st_size, item["video"].name))
    return candidates[:max_items]


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


def apply_duration_budget(
    items: list[dict],
    duration_reader,
    max_items: int,
    max_item_seconds: float,
    max_batch_seconds: float,
) -> tuple[list[dict], dict]:
    if max_item_seconds <= 0 or max_batch_seconds <= 0:
        raise ValueError("duration budgets must be positive")
    selected = []
    total_duration = 0.0
    skipped = {"clipped": 0, "batch_budget": 0, "source_exhausted": 0}
    for item in items:
        duration = float(duration_reader(item["video"]))
        start = max(0.0, float(item.get("resume_start_seconds") or 0.0))
        remaining = max(0.0, duration - start)
        if remaining <= 0:
            skipped["source_exhausted"] += 1
            continue
        effective_duration = min(remaining, max_item_seconds)
        if remaining > max_item_seconds:
            skipped["clipped"] += 1
        if total_duration + effective_duration > max_batch_seconds:
            skipped["batch_budget"] += 1
            continue
        item = dict(item)
        item["source_duration_seconds"] = duration
        item["audio_start_seconds"] = start
        item["audio_limit_seconds"] = effective_duration
        item["clipped"] = start + effective_duration < duration
        selected.append(item)
        total_duration += effective_duration
        if len(selected) >= max_items:
            break
    return selected, skipped


def write_status(path: Path | None, payload: dict) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def has_named_entity(text: str) -> bool:
    return bool(REPO_OR_URL.search(text) or NAMED_ENTITY.search(text) or LISTED_ENTITY.search(text))


def tagged_entity_candidates(note: dict) -> list[str]:
    description = str(note.get("description") or "")
    candidates = TAGGED_ENTITY.findall(description)
    candidates.extend(re.findall(r"\b[A-Za-z][A-Za-z0-9_.-]{2,}\b", str(note.get("tags") or "")))
    selected = []
    for candidate in candidates:
        normalized = candidate.lower()
        looks_distinctive = (
            any(character.isupper() for character in candidate[1:])
            or bool(re.search(r"[0-9_.-]", candidate))
        )
        if normalized not in GENERIC_ENTITY_TAGS and looks_distinctive:
            selected.append(candidate)
    return list(dict.fromkeys(selected))


def assess_visual_need(note: dict, transcript: str) -> dict:
    text = " ".join(str(transcript or "").split())
    reasons = []
    missing_facts = []
    if len(text) < 24:
        reasons.append("insufficient-speech")
        missing_facts.append("content-summary")
    context = " ".join([
        str(note.get("title") or ""),
        str(note.get("description") or ""),
        text,
    ])
    entity_topic = bool(ENTITY_TOPIC.search(context))
    metadata = " ".join([
        str(note.get("description") or ""),
        str(note.get("tags") or ""),
    ])
    tagged_entities = tagged_entity_candidates(note)
    named_entity = has_named_entity(text) or bool(
        REPO_OR_URL.search(metadata) or tagged_entities
    )
    if HIDDEN_NAME_CUE.search(text) and not (
        REPO_OR_URL.search(text)
        or NAMED_ENTITY.search(text)
        or REPO_OR_URL.search(metadata)
        or tagged_entities
    ):
        named_entity = False
    if entity_topic and not named_entity:
        reasons.append("entity-name-missing")
        missing_facts.append("entity-name")
    repository_claim = bool(REPOSITORY_CUE.search(context))
    repository_evidence = " ".join([text, metadata])
    if repository_claim and not GITHUB_REPOSITORY.search(repository_evidence):
        reasons.append("repository-identity-unverified")
        missing_facts.append("repository-identity")
    if VISUAL_CUE.search(text) and not named_entity:
        reasons.append("visual-reference-without-name")
        if "entity-name" not in missing_facts:
            missing_facts.append("visual-detail")
    return {
        "level": "sparse" if missing_facts else "none",
        "reasons": list(dict.fromkeys(reasons)),
        "missing_facts": list(dict.fromkeys(missing_facts)),
        "stop_when_resolved": True,
    }


def reassess_transcripts(analysis_dir: Path, notes: dict) -> dict:
    updated = 0
    visual_needed = 0
    for transcript_path in analysis_dir.glob("*/transcription.json"):
        note_id = transcript_path.parent.name
        if note_id not in notes:
            continue
        try:
            transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if transcript.get("status") not in {"partial", "transcribed"}:
            continue
        assessment = assess_visual_need(notes[note_id], transcript.get("text", ""))
        transcript["visual_review"] = assessment
        window = transcript.get("audio_window") or {}
        if window.get("truncated") and not assessment["missing_facts"]:
            window["complete"] = True
            transcript["audio_window"] = window
            transcript["status"] = "transcribed"
        transcript_path.write_text(
            json.dumps(transcript, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        updated += 1
        if assessment["level"] != "none":
            visual_needed += 1
    return {"reassessed": updated, "visual_review_needed": visual_needed}


def run(command: list[str], timeout: int = 900) -> None:
    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("audio extraction failed")


def transcribe_video(model, ffmpeg: Path, item: dict, note: dict, analysis_dir: Path, language: str, keep_audio: bool) -> dict:
    note_dir = analysis_dir / item["note_id"]
    note_dir.mkdir(parents=True, exist_ok=True)
    audio_path = note_dir / "audio-16khz.wav"
    audio_start = float(item.get("audio_start_seconds") or 0.0)
    audio_limit = float(item.get("audio_limit_seconds") or item.get("source_duration_seconds") or 0)
    source_duration = float(item.get("source_duration_seconds") or 0.0)
    command = [
        str(ffmpeg), "-hide_banner", "-loglevel", "error", "-y",
    ]
    if audio_start > 0:
        command.extend(["-ss", str(audio_start)])
    command.extend(["-i", str(item["video"])])
    if audio_limit > 0:
        command.extend(["-t", str(audio_limit)])
    command.extend(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(audio_path)])
    try:
        run(command)
        segments_iter, info = model.transcribe(
            str(audio_path),
            language=language,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        previous = {}
        transcript_path = note_dir / "transcription.json"
        if audio_start > 0 and transcript_path.is_file():
            try:
                previous = json.loads(transcript_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                previous = {}
        segments = list(previous.get("segments") or [])
        for segment in segments_iter:
            segments.append({
                "start": round(audio_start + float(segment.start), 3),
                "end": round(audio_start + float(segment.end), 3),
                "text": str(segment.text).strip(),
                "avg_logprob": round(float(segment.avg_logprob), 4),
                "no_speech_prob": round(float(segment.no_speech_prob), 4),
            })
        text = " ".join(segment["text"] for segment in segments if segment["text"]).strip()
        assessment = assess_visual_need(note, text)
        audio_end = min(source_duration, audio_start + audio_limit) if source_duration else audio_start + audio_limit
        source_complete = bool(source_duration and audio_end >= source_duration - 0.01)
        resolved = not assessment["missing_facts"]
        analysis_complete = source_complete or resolved
        result = {
            "status": "transcribed" if analysis_complete else "partial",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "language": getattr(info, "language", language),
            "language_probability": round(float(getattr(info, "language_probability", 0.0)), 4),
            "duration_seconds": round(float(getattr(info, "duration", 0.0)), 3),
            "source_duration_seconds": round(source_duration, 3),
            "audio_window": {
                "start": 0.0,
                "end": round(audio_end, 3),
                "next_start": round(audio_end, 3),
                "truncated": not source_complete,
                "complete": analysis_complete,
                "stopped_early": bool(resolved and not source_complete),
            },
            "text": text,
            "segments": segments,
            "visual_review": assessment,
        }
        transcript_path.write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return result
    finally:
        if not keep_audio:
            audio_path.unlink(missing_ok=True)


def main() -> None:
    args = parse_args()
    ffmpeg = Path(args.ffmpeg).resolve()
    ffprobe = Path(args.ffprobe).resolve()
    if not ffmpeg.is_file() or not ffprobe.is_file():
        raise ValueError("ffmpeg and ffprobe executables are required")
    media_dir = Path(args.media_dir).resolve()
    analysis_dir = Path(args.analysis_dir).resolve()
    curation = json.loads(Path(args.curation).resolve().read_text(encoding="utf-8"))
    catalog = json.loads(Path(args.catalog).resolve().read_text(encoding="utf-8"))
    config = json.loads(Path(args.config).resolve().read_text(encoding="utf-8-sig"))
    notes = catalog_notes(catalog, config.get("published_since"))
    if args.reassess_only:
        print(json.dumps(reassess_transcripts(analysis_dir, notes)))
        return
    candidates = build_transcription_queue(
        media_dir,
        curation,
        analysis_dir,
        100,
        allowed_note_ids=set(notes),
    )
    queue, skipped = apply_duration_budget(
        candidates,
        lambda video: probe_duration(ffprobe, video),
        args.max_items,
        args.max_item_seconds,
        args.max_batch_seconds,
    )
    status_file = Path(args.status_file).resolve() if args.status_file else None
    if not queue:
        result = {
            "queued": 0, "transcribed": 0, "visual_review_needed": 0, "failed": 0,
            "skipped": skipped,
        }
        write_status(status_file, result)
        print(json.dumps(result))
        return

    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise RuntimeError("faster-whisper is not installed; run setup-transcription.ps1") from error

    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        download_root=str(Path(args.model_dir).resolve()),
        local_files_only=True,
        cpu_threads=min(8, max(1, __import__("os").cpu_count() or 4)),
    )
    completed = 0
    visual_needed = 0
    failed = 0
    for index, item in enumerate(queue, start=1):
        try:
            result = transcribe_video(
                model,
                ffmpeg,
                item,
                notes.get(item["note_id"], {}),
                analysis_dir,
                args.language,
                args.keep_audio,
            )
            completed += 1
            if result["visual_review"]["level"] != "none":
                visual_needed += 1
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
            failed += 1
        progress = {
            "progress": index,
            "total": len(queue),
            "transcribed": completed,
            "visual_review_needed": visual_needed,
            "failed": failed,
            "skipped": skipped,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        write_status(status_file, progress)
        print(json.dumps(progress), flush=True)
    final = {
        "queued": len(queue),
        "transcribed": completed,
        "visual_review_needed": visual_needed,
        "failed": failed,
        "skipped": skipped,
    }
    write_status(status_file, final)
    print(json.dumps(final))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print(f"transcriber: {error}")
        raise SystemExit(1) from error
