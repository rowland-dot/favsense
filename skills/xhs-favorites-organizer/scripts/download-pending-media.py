#!/usr/bin/env python3

import argparse
import asyncio
from contextlib import redirect_stdout
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlparse


NOTE_ID = re.compile(r"^[a-f0-9]{24}$")
NOTE_PATH = re.compile(r"^/(?:explore|discovery/item)/([a-f0-9]{24})$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SAFETY_LIMIT = re.compile(
    r"(?:300031|验证码|滑块(?:验证)?|请完成(?:安全)?验证|访问频繁|操作频繁|"
    r"请求频繁|安全验证|安全限制|captcha|too\s+many\s+requests|"
    r"http(?:/[\d.]+)?\s*429|status[_\s-]*(?:code)?\s*[:=]?\s*429|"
    r"(?:状态码|错误码)\s*[:：=]?\s*429|"
    r"[\"']?(?:code|status)[\"']?\s*[:=]\s*429)",
    re.IGNORECASE,
)
STRUCTURED_SAFETY_LIMIT = re.compile(
    r"(?:[\"']?(?:error[_-]?code|code|status)[\"']?\s*[:=]\s*[\"']?(?:300031|429)\b|"
    r"http(?:/[\d.]+)?\s*429|status[_\s-]*(?:code)?\s*[:=]?\s*429|"
    r"(?:状态码|错误码)\s*[:：=]?\s*(?:300031|429))",
    re.IGNORECASE,
)
PINNED_XHS_COMMIT = "d805ebdd3db53f68137bc2b7a6ed118ce572d09b"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download a bounded batch of uncatalogued XHS media for local analysis."
    )
    parser.add_argument("--catalog")
    parser.add_argument("--curation")
    parser.add_argument("--config")
    parser.add_argument("--signed-urls-stdin", action="store_true")
    parser.add_argument("--xhs-dir", required=True)
    parser.add_argument("--media-dir", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--lock-file")
    parser.add_argument("--safety-stop-file")
    parser.add_argument("--max-items", type=int, default=5)
    parser.add_argument("--delay", type=float, default=3.0)
    return parser.parse_args()


def contains_safety_limit(value: str) -> bool:
    return bool(SAFETY_LIMIT.search(str(value or "")))


def safety_limit_detected(output: str, error: Exception | None = None) -> bool:
    """Recognize platform stop signals without persisting request details."""
    return bool(STRUCTURED_SAFETY_LIMIT.search(str(output or ""))) or (
        error is not None and contains_safety_limit(str(error))
    )


def write_safety_stop(path: Path | None) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump({
            "stopped_at": datetime.now(timezone.utc).isoformat(),
            "reason": "platform-safety-limit",
        }, handle)


def acquire_single_flight(lock_path: Path | None):
    """Acquire a crash-safe OS file lock; the caller releases it by closing."""
    if lock_path is None:
        return None
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    if lock_path.is_symlink():
        raise ValueError("platform request lock must not be redirected")
    handle = lock_path.open("a+", encoding="utf-8")
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(" ")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt  # pylint: disable=import-outside-toplevel

            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl  # pylint: disable=import-outside-toplevel

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        handle.seek(0)
        handle.truncate()
        handle.write(json.dumps({
            "pid": os.getpid(),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }))
        handle.flush()
        return handle
    except (OSError, BlockingIOError) as error:
        handle.close()
        raise FileExistsError(str(lock_path)) from error


def classify_error(error: Exception) -> str:
    message = str(error).lower()
    if "client has been closed" in message or "event loop is closed" in message:
        return "client-closed"
    if isinstance(error, TimeoutError) or "timeout" in message or "timed out" in message:
        return "timeout"
    return type(error).__name__.lower()


def has_cached_media(media_dir: Path, note_id: str) -> bool:
    return any(media_dir.glob(f"{note_id}.*")) or any(media_dir.glob(f"{note_id}_*.*"))


def normalize_published_since(value: str | None) -> str | None:
    if value in (None, ""):
        return None
    date = str(value).strip()
    if not ISO_DATE.fullmatch(date):
        raise ValueError("published_since must use YYYY-MM-DD")
    datetime.strptime(date, "%Y-%m-%d")
    return date


def note_is_in_scope(note: dict, published_since: str | None) -> bool:
    if published_since is None:
        return True
    published = str(note.get("published_at") or "").strip()[:10]
    return bool(ISO_DATE.fullmatch(published) and published >= published_since)


def build_signed_queue(text: str, max_items: int) -> list[dict]:
    if max_items < 1 or max_items > 200:
        raise ValueError("--max-items must be between 1 and 200 for signed URLs")
    queue = []
    seen = set()
    for value in text.split():
        parsed = urlparse(value)
        match = NOTE_PATH.fullmatch(parsed.path)
        if (
            parsed.scheme != "https"
            or parsed.hostname != "www.xiaohongshu.com"
            or parsed.port not in (None, 443)
            or parsed.username is not None
            or parsed.password is not None
            or parsed.fragment
            or not match
        ):
            raise ValueError("stdin contains a non-Xiaohongshu or unsupported URL")
        note_id = match.group(1)
        if note_id in seen:
            continue
        seen.add(note_id)
        queue.append({"note_id": note_id, "media_type": "unknown", "url": value})
        if len(queue) >= max_items:
            break
    return queue


def build_pending_queue(
    catalog: dict,
    curation: dict,
    media_dir: Path,
    max_items: int,
    published_since: str | None = None,
) -> list[dict]:
    if max_items < 1 or max_items > 25:
        raise ValueError("--max-items must be between 1 and 25")
    queue = []
    for note_id, note in (catalog.get("notes") or {}).items():
        if len(queue) >= max_items:
            break
        if not NOTE_ID.fullmatch(note_id) or note_id in curation:
            continue
        if not note_is_in_scope(note, published_since):
            continue
        if has_cached_media(media_dir, note_id):
            continue
        media_type = str(note.get("type") or "视频")
        if media_type not in {"视频", "图文"}:
            continue
        queue.append({
            "note_id": note_id,
            "media_type": media_type,
            "url": f"https://www.xiaohongshu.com/explore/{note_id}",
        })
    return queue


def verify_checkout(xhs_dir: Path) -> None:
    prefix = ["git", "-c", f"safe.directory={xhs_dir}", "-C", str(xhs_dir)]
    commit = subprocess.run(
        [*prefix, "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout.strip()
    dirty = subprocess.run(
        [*prefix, "status", "--porcelain"],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    ).stdout.strip()
    if commit != PINNED_XHS_COMMIT:
        raise ValueError("XHS-Downloader checkout is not at the supported revision")
    if dirty:
        raise ValueError("XHS-Downloader checkout is modified")


async def replace_insecure_clients(app) -> None:
    from httpx import AsyncClient, AsyncHTTPTransport

    manager = app.manager
    old_request = manager.request_client
    old_download = manager.download_client
    mounts = {
        "http://": AsyncHTTPTransport(proxy=manager.proxy),
        "https://": AsyncHTTPTransport(proxy=manager.proxy),
    }
    manager.request_client = AsyncClient(
        headers=manager.blank_headers | {"referer": "https://www.xiaohongshu.com/"},
        timeout=manager.timeout,
        verify=True,
        http2=True,
        follow_redirects=True,
        mounts=mounts,
    )
    manager.download_client = AsyncClient(
        headers=manager.blank_headers,
        timeout=manager.timeout,
        verify=True,
        follow_redirects=True,
        mounts=mounts,
    )
    app.html.client = manager.request_client
    app.downloader.client = manager.download_client
    await old_request.aclose()
    await old_download.aclose()


async def download_queue(
    queue: list[dict],
    xhs_dir: Path,
    media_dir: Path,
    delay: float,
    safety_stop_path: Path | None = None,
) -> dict:
    sys.path.insert(0, str(xhs_dir))
    from source import XHS  # pylint: disable=import-outside-toplevel

    app = XHS(
        work_path=str(media_dir.parent),
        folder_name=media_dir.name,
        name_format="作品ID",
        max_retry=0,
        timeout=20,
        record_data=False,
        image_format="JPEG",
        image_download=True,
        video_download=True,
        live_download=False,
        download_record=False,
        folder_mode=False,
        author_archive=False,
        script_server=False,
    )
    await replace_insecure_clients(app)
    await app.__aenter__()
    results = []
    safety_stopped = False
    try:
        for index, item in enumerate(queue):
            if safety_stop_path is not None and safety_stop_path.exists():
                safety_stopped = True
                break
            diagnostics = io.StringIO()
            before = has_cached_media(media_dir, item["note_id"])
            caught_error = None
            try:
                with redirect_stdout(diagnostics):
                    await app.extract(item["url"], download=True, data=False)
                after = has_cached_media(media_dir, item["note_id"])
                status = "downloaded" if after and not before else "unavailable"
            except Exception as error:  # noqa: BLE001
                caught_error = error
                status = "failed"
                error_type = type(error).__name__
                error_hint = classify_error(error)
            else:
                error_type = None
                error_hint = None
            if safety_limit_detected(diagnostics.getvalue(), caught_error):
                status = "safety-stop"
                safety_stopped = True
                write_safety_stop(safety_stop_path)
            result = {"note_id": item["note_id"], "status": status}
            if error_type:
                result["error_type"] = error_type
                result["error_hint"] = error_hint
            results.append(result)
            if safety_stopped:
                break
            if index + 1 < len(queue) and delay > 0:
                await asyncio.sleep(delay)
                if safety_stop_path is not None and safety_stop_path.exists():
                    safety_stopped = True
                    break
    finally:
        await app.__aexit__(None, None, None)
    return {"results": results, "safety_stopped": safety_stopped}


def main() -> None:
    args = parse_args()
    if args.delay < 0 or args.delay > 60:
        raise ValueError("--delay must be between 0 and 60 seconds")
    xhs_dir = Path(args.xhs_dir).resolve()
    media_dir = Path(args.media_dir).resolve()
    report_path = Path(args.report).resolve()
    lock_path = Path(args.lock_file).resolve() if args.lock_file else None
    safety_stop_path = Path(args.safety_stop_file).resolve() if args.safety_stop_file else None
    if safety_stop_path is not None and safety_stop_path.exists():
        print(json.dumps({"queued": 0, "downloaded": 0, "safety_stopped": True, "state": "safety-stopped"}))
        raise SystemExit(2)
    try:
        lock_handle = acquire_single_flight(lock_path)
    except FileExistsError:
        print(json.dumps({"queued": 0, "downloaded": 0, "safety_stopped": False, "state": "busy"}))
        return
    try:
        verify_checkout(xhs_dir)
        media_dir.mkdir(parents=True, exist_ok=True)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        if args.signed_urls_stdin:
            queue = [
                item for item in build_signed_queue(sys.stdin.read(), args.max_items)
                if not has_cached_media(media_dir, item["note_id"])
            ]
        else:
            if not args.catalog or not args.curation:
                raise ValueError("--catalog and --curation are required unless --signed-urls-stdin is used")
            catalog = json.loads(Path(args.catalog).resolve().read_text(encoding="utf-8"))
            curation = json.loads(Path(args.curation).resolve().read_text(encoding="utf-8"))
            published_since = None
            if args.config:
                config = json.loads(Path(args.config).resolve().read_text(encoding="utf-8-sig"))
                published_since = normalize_published_since(config.get("published_since"))
            queue = build_pending_queue(
                catalog, curation, media_dir, args.max_items, published_since=published_since
            )
        outcome = asyncio.run(
            download_queue(queue, xhs_dir, media_dir, args.delay, safety_stop_path)
        ) if queue else {
            "results": [],
            "safety_stopped": False,
        }
        report = {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "queued": len(queue),
            "downloaded": sum(item["status"] == "downloaded" for item in outcome["results"]),
            "unavailable": sum(item["status"] == "unavailable" for item in outcome["results"]),
            "failed": sum(item["status"] == "failed" for item in outcome["results"]),
            "safety_stopped": outcome["safety_stopped"],
            "results": outcome["results"],
        }
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({key: value for key, value in report.items() if key != "results"}, ensure_ascii=False))
        if outcome["safety_stopped"]:
            write_safety_stop(safety_stop_path)
            raise SystemExit(2)
    finally:
        if lock_handle is not None:
            lock_handle.close()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        print(f"pending-media-downloader: {error}", file=sys.stderr)
        raise SystemExit(1) from error
