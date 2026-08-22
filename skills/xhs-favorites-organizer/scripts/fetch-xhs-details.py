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


NOTE_PATH = re.compile(r"^/(?:explore|discovery/item)/([A-Za-z0-9_-]{1,128})$")
PINNED_XHS_COMMIT = "d805ebdd3db53f68137bc2b7a6ed118ce572d09b"
SAFETY_SIGNAL = re.compile(
    r"(?:300031|验证码|滑块(?:验证)?|请完成(?:安全)?验证|访问频繁|操作频繁|"
    r"请求频繁|安全验证|安全限制|captcha|too\s+many\s+requests|"
    r"http(?:/[\d.]+)?\s*429|status[_\s-]*(?:code)?\s*[:=]?\s*429|"
    r"(?:状态码|错误码)\s*[:：=]?\s*429|"
    r"[\"']?(?:code|status)[\"']?\s*[:=]\s*429)",
    re.IGNORECASE,
)
STRUCTURED_SAFETY_SIGNAL = re.compile(
    r"(?:[\"']?(?:error[_-]?code|code|status)[\"']?\s*[:=]\s*[\"']?(?:300031|429)\b|"
    r"http(?:/[\d.]+)?\s*429|status[_\s-]*(?:code)?\s*[:=]?\s*429|"
    r"(?:状态码|错误码)\s*[:：=]?\s*(?:300031|429))",
    re.IGNORECASE,
)
SAFETY_STATE_MESSAGE_KEYS = frozenset({
    "error", "errormessage", "errmsg", "message", "toast", "riskmessage", "verifymessage",
})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Read XHS note URLs from stdin and emit token-free JSON metadata."
    )
    parser.add_argument("--xhs-dir", required=True, help="XHS-Downloader source directory")
    parser.add_argument("--max-items", type=int, default=200)
    parser.add_argument("--delay", type=float, default=1.5)
    parser.add_argument("--lock-file")
    parser.add_argument("--safety-stop-file")
    return parser.parse_args()


def acquire_single_flight(lock_path: Path | None):
    """Acquire the shared platform-request OS lock without deleting lock files."""
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


def validate_urls(text: str, max_items: int) -> list[tuple[str, str]]:
    if max_items < 1 or max_items > 1000:
        raise ValueError("--max-items must be between 1 and 1000")

    values = [value for value in text.split() if value]
    if not values:
        raise ValueError("stdin did not contain any URLs")
    if len(values) > max_items:
        raise ValueError(f"received {len(values)} URLs; limit is {max_items}")

    validated = []
    seen = set()
    for value in values:
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
            raise ValueError("input contains a non-Xiaohongshu or unsupported URL")
        note_id = match.group(1)
        if note_id not in seen:
            seen.add(note_id)
            validated.append((value, note_id))
    return validated


def verify_checkout(xhs_dir: Path) -> None:
    git_prefix = ["git", "-c", f"safe.directory={xhs_dir}", "-C", str(xhs_dir)]
    try:
        commit = subprocess.run(
            [*git_prefix, "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        ).stdout.strip()
        dirty = subprocess.run(
            [*git_prefix, "status", "--porcelain"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError) as error:
        raise ValueError("could not verify the XHS-Downloader checkout") from error
    if commit != PINNED_XHS_COMMIT:
        raise ValueError(
            f"unsupported XHS-Downloader commit {commit}; expected {PINNED_XHS_COMMIT}"
        )
    if dirty:
        raise ValueError("XHS-Downloader checkout is modified; restore the pinned checkout")


def clean_text(value, max_chars: int = 20_000):
    if value is None:
        return None
    text = " ".join(str(value).split()).strip()
    return text[:max_chars] or None


def first_list(value):
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("comments", "list", "data", "items"):
            if isinstance(value.get(key), list):
                return value[key]
    return []


def normalize_comments(value, max_items: int = 30) -> list[dict]:
    """Keep useful comment evidence without retaining commenter identity."""
    results = []

    def append(items, reply: bool = False):
        for item in first_list(items):
            if len(results) >= max_items:
                return
            if not isinstance(item, dict):
                continue
            text = clean_text(
                item.get("content")
                or item.get("contentText")
                or item.get("content_text")
                or item.get("text"),
                500,
            )
            if text:
                evidence = {"text": text, "reply": reply}
                likes = clean_text(item.get("likeCount") or item.get("like_count"), 64)
                if likes:
                    evidence["liked_count"] = likes
                results.append(evidence)
            replies = (
                item.get("subComments")
                or item.get("sub_comments")
                or item.get("replies")
            )
            if replies:
                append(replies, True)

    append(value)
    return results


def response_note_id(note: dict) -> str | None:
    for key in ("noteId", "note_id", "id"):
        value = note.get(key)
        if value not in (None, ""):
            return str(value)
    return None


def note_and_comments_from_state(state: dict, note_id: str) -> tuple[dict, object]:
    detail_map = state.get("note", {}).get("noteDetailMap", {}) if isinstance(state, dict) else {}
    if isinstance(detail_map, dict) and detail_map:
        detail = detail_map.get(note_id)
        if isinstance(detail, dict):
            note = detail.get("note")
            identity = response_note_id(note) if isinstance(note, dict) else None
            if isinstance(note, dict) and identity in (None, note_id):
                return note, detail.get("comments", [])

    phone = state.get("noteData", {}).get("data", {}) if isinstance(state, dict) else {}
    if isinstance(phone, dict):
        note = phone.get("noteData")
        if isinstance(note, dict) and response_note_id(note) == note_id:
            return note, phone.get("comments", note.get("comments", []))
    return {}, []


def state_contains_safety_limit(value: object) -> bool:
    if isinstance(value, list):
        return any(state_contains_safety_limit(item) for item in value)
    if not isinstance(value, dict):
        return False
    for key, child in value.items():
        normalized_key = re.sub(r"[^a-z]", "", str(key).lower())
        if normalized_key in {"code", "status", "errorcode", "statuscode"} and str(child).strip() in {"300031", "429"}:
            return True
        if normalized_key in SAFETY_STATE_MESSAGE_KEYS and SAFETY_SIGNAL.search(str(child or "")):
            return True
        if normalized_key in {"note", "notedata", "notedetailmap", "comments", "commentdata"}:
            continue
        if state_contains_safety_limit(child):
            return True
    return False


def normalize(raw: dict, note_id: str, comments=None) -> dict:
    for key in ("作品ID", "笔记ID", "note_id", "noteId"):
        identity = raw.get(key)
        if identity not in (None, "") and str(identity) != note_id:
            raise ValueError("detail response identity did not match the requested note")
    result = {
        "note_id": note_id,
        "detail_fetched": True,
        "comment_evidence_checked": True,
        "title": clean_text(raw.get("作品标题"), 500),
        "description": clean_text(raw.get("作品描述"), 20_000),
        "type": clean_text(raw.get("作品类型"), 100),
        "tags": clean_text(raw.get("作品标签"), 2_000),
        "author": clean_text(raw.get("作者昵称"), 200),
        "author_id": clean_text(raw.get("作者ID"), 256),
        "webUrl": f"https://www.xiaohongshu.com/explore/{note_id}",
        "published_at": clean_text(raw.get("发布时间"), 128),
        "updated_at": clean_text(raw.get("最后更新时间"), 128),
        "collected_count": clean_text(raw.get("收藏数量"), 64),
        "comment_count": clean_text(raw.get("评论数量"), 64),
        "share_count": clean_text(raw.get("分享数量"), 64),
        "liked_count": clean_text(raw.get("点赞数量"), 64),
    }
    evidence = normalize_comments(comments)
    if evidence:
        result["comment_evidence"] = evidence
    return result


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
        mounts={
            "http://": AsyncHTTPTransport(proxy=manager.proxy),
            "https://": AsyncHTTPTransport(proxy=manager.proxy),
        },
    )
    app.html.client = manager.request_client
    await old_request.aclose()
    await old_download.aclose()


async def extract_note(app, url: str, note_id: str) -> tuple[dict | None, dict | None]:
    """Fetch one note exactly once and return a sanitized gap when it is unavailable."""
    diagnostics = io.StringIO()
    html = ""
    try:
        with redirect_stdout(diagnostics):
            html = await app.html.request_url(url)
            script = app.convert._extract_object(html)  # pinned adapter boundary
            state = app.convert._convert_object(script) if script else {}
            note_data, comments = note_and_comments_from_state(state, note_id)
            raw = app.explore.run(app.json_to_namespace(note_data)) if note_data else {}
        if raw and (
            state_contains_safety_limit(state)
            or STRUCTURED_SAFETY_SIGNAL.search(diagnostics.getvalue())
        ):
            return None, {"note_id": note_id, "reason": "safety stop"}
        if not raw:
            if SAFETY_SIGNAL.search(f"{html}\n{diagnostics.getvalue()}"):
                return None, {"note_id": note_id, "reason": "safety stop"}
            return None, {"note_id": note_id, "reason": "detail unavailable"}
        return normalize(raw, note_id, comments), None
    except Exception as error:  # noqa: BLE001
        # Do not expose signed Xiaohongshu URLs or xsec tokens in the gap report.
        if SAFETY_SIGNAL.search(f"{html}\n{diagnostics.getvalue()}\n{error}"):
            return None, {"note_id": note_id, "reason": "safety stop"}
        return None, {"note_id": note_id, "reason": "request failed"}


async def fetch(
    urls: list[tuple[str, str]],
    xhs_class,
    delay: float,
    safety_stop_path: Path | None = None,
) -> tuple[list[dict], list[dict]]:
    if safety_stop_path is not None and safety_stop_path.exists():
        return [], [
            {"note_id": note_id, "reason": "safety stop"}
            for _, note_id in urls
        ]
    app = xhs_class(
        max_retry=0,
        record_data=False,
        image_download=False,
        video_download=False,
        live_download=False,
        download_record=False,
        script_server=False,
    )
    results = []
    failures = []
    await replace_insecure_clients(app)
    await app.__aenter__()
    try:
        for index, (url, note_id) in enumerate(urls):
            if safety_stop_path is not None and safety_stop_path.exists():
                failures.extend(
                    {"note_id": remaining_id, "reason": "safety stop"}
                    for _, remaining_id in urls[index:]
                )
                break
            note, failure = await extract_note(app, url, note_id)
            if note is not None:
                results.append(note)
            if failure is not None:
                failures.append(failure)
                if failure.get("reason") == "safety stop":
                    write_safety_stop(safety_stop_path)
                    failures.extend(
                        {"note_id": remaining_id, "reason": "safety stop"}
                        for _, remaining_id in urls[index + 1:]
                    )
                    break
            if index + 1 < len(urls) and delay > 0:
                await asyncio.sleep(delay)
                if safety_stop_path is not None and safety_stop_path.exists():
                    failures.extend(
                        {"note_id": remaining_id, "reason": "safety stop"}
                        for _, remaining_id in urls[index + 1:]
                    )
                    break
    finally:
        await app.__aexit__(None, None, None)
    return results, failures


def main() -> None:
    args = parse_args()
    xhs_dir = Path(args.xhs_dir).resolve()
    lock_path = Path(args.lock_file).resolve() if args.lock_file else None
    safety_stop_path = Path(args.safety_stop_file).resolve() if args.safety_stop_file else None
    if not (xhs_dir / "source" / "application" / "app.py").is_file():
        raise ValueError(f"XHS-Downloader source was not found: {xhs_dir}")

    if args.delay < 0 or args.delay > 60:
        raise ValueError("--delay must be between 0 and 60 seconds")
    verify_checkout(xhs_dir)
    urls = validate_urls(sys.stdin.read(), args.max_items)
    if safety_stop_path is not None and safety_stop_path.exists():
        json.dump({
            "notes": [],
            "failures": [
                {"note_id": note_id, "reason": "safety stop"}
                for _, note_id in urls
            ],
        }, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return
    try:
        lock_handle = acquire_single_flight(lock_path)
    except FileExistsError:
        json.dump({
            "notes": [],
            "failures": [
                {"note_id": note_id, "reason": "request failed"}
                for _, note_id in urls
            ],
        }, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return
    sys.path.insert(0, str(xhs_dir))
    try:
        from source import XHS  # pylint: disable=import-outside-toplevel

        notes, failures = asyncio.run(fetch(urls, XHS, args.delay, safety_stop_path))
        json.dump({"notes": notes, "failures": failures}, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
    finally:
        if lock_handle is not None:
            lock_handle.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print(f"xhs-detail-fetcher: {error}", file=sys.stderr)
        raise SystemExit(1) from error
