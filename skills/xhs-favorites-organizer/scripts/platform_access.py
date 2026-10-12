"""Platform access permission: the one place that answers "may we touch Xiaohongshu now?".

It owns the stop record on disk, the rule that recognises a platform block, the difference
between a stop raised in the current round and one left over from an earlier round, the
wording shown for each, and the operator's clearing of a leftover.

Everything here takes the private state directory (or the record's path), never a bridge
object, so the bridge, the detail fetcher and the media downloader can all load this one file.
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re


STOP_FILE_NAME = "media-download-safety-stop.json"
STOP_REASON = "platform-safety-limit"
MAX_RECORD_BYTES = 64 * 1024

# Phases a script or the bridge may write. The other two are only ever read:
# "media_or_detail" is a record in the old format, "unknown" one that cannot be read at all.
WRITABLE_PHASES = {
    "detail": "详情抓取",
    "media": "媒体下载",
    "page": "页面",
    "diandian": "点点总结",
}
PHASE_LABELS = {
    **WRITABLE_PHASES,
    "media_or_detail": "媒体或详情",
    "unknown": "未知",
}

ROUND_STOP_MESSAGE = "小红书触发安全限制，已停止本轮且不会继续重试"
CLEAR_ACTION_LABEL = "已确认恢复，清除并继续"

# What counts as the platform saying stop. Input differs by caller: the detail fetcher and the
# media downloader read failed pages and process output, the bridge reads the DianDian page body.
# The browser-side copies live in the userscript and in the bridge's injected page check; all
# three are tested against safety-signal-cases.json.
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


# The bridge injects a page check into the note page its share step opened. It is a browser-side
# copy of the rule above, so its source lives here and the bridge only splices it in.
INJECTED_DIALOG_PATTERN_JS = r"(?:验证码|访问频繁|操作频繁|请求频繁|安全限制|300031|captcha)"
INJECTED_STRUCTURED_CODE_PATTERN_JS = (
    r"""["'](?:error[_-]?code|status[_-]?code|code|status)["']\s*[:=]\s*["']?300031\b"""
)


def injected_page_check_js() -> str:
    """JavaScript statements that return a stop result when the note page shows a platform block.

    The caller's scope must provide visible(element); the statements return only on a block.
    """
    return (
        "const challenge=[...document.querySelectorAll("
        "'[class*=\"captcha\" i],[id*=\"captcha\" i],[class*=\"geetest\" i],"
        "[id*=\"geetest\" i],[data-testid*=\"captcha\" i],[data-testid*=\"verify\" i],"
        "iframe[src*=\"captcha\" i]')].some(visible);"
        "const warning=[...document.querySelectorAll("
        "'[role=\"alert\"],[role=\"dialog\"],[aria-modal=\"true\"]')].filter(visible)"
        f".some(e=>/{INJECTED_DIALOG_PATTERN_JS}/i"
        ".test(e.innerText||e.textContent||''));"
        "const structured=[...document.querySelectorAll("
        "'script[type=\"application/json\"],script#__INITIAL_STATE__')]"
        f".some(e=>/{INJECTED_STRUCTURED_CODE_PATTERN_JS}/i.test(e.textContent||''));"
        "if(challenge||warning||structured)"
        "return {found:false,safety:true,location_matches:true};"
    )


def state_contains_safety_limit(value: object) -> bool:
    """True when a parsed page state carries a block code or a block message outside note content."""
    if isinstance(value, list):
        return any(state_contains_safety_limit(item) for item in value)
    if not isinstance(value, dict):
        return False
    for key, child in value.items():
        normalized_key = re.sub(r"[^a-z]", "", str(key).lower())
        if (
            normalized_key in {"code", "status", "errorcode", "statuscode"}
            and str(child).strip() in {"300031", "429"}
        ):
            return True
        if normalized_key in SAFETY_STATE_MESSAGE_KEYS and SAFETY_SIGNAL.search(str(child or "")):
            return True
        if normalized_key in {"note", "notedata", "notedetailmap", "comments", "commentdata"}:
            continue
        if state_contains_safety_limit(child):
            return True
    return False


def stop_path(state_dir: Path | str) -> Path:
    return Path(state_dir) / STOP_FILE_NAME


def record_exists(path: Path | str | None) -> bool:
    """True when anything sits at the stop record's path, readable or not."""
    return path is not None and os.path.lexists(path)


def _parse_time(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.strip())
        except ValueError:
            return None
    else:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _unreadable_stop() -> dict:
    return {
        "stopped_at": None,
        "date": None,
        "phase": "unknown",
        "phase_label": PHASE_LABELS["unknown"],
    }


def read_stop(state_dir: Path | str) -> dict | None:
    """Return the stop record, or None when there is none.

    A record that cannot be read as an ordinary file still counts as a stop: failing safe
    means the platform stays untouched until the operator has looked.
    """
    path = stop_path(state_dir)
    if not os.path.lexists(path):
        return None
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_RECORD_BYTES:
            return _unreadable_stop()
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return _unreadable_stop()
    if not isinstance(value, dict):
        return _unreadable_stop()
    stopped_at = _parse_time(value.get("stopped_at"))
    phase = value.get("phase", "media_or_detail")
    if not isinstance(phase, str) or phase not in PHASE_LABELS or phase == "unknown":
        phase = "unknown"
    return {
        "stopped_at": stopped_at.isoformat() if stopped_at else None,
        "date": stopped_at.astimezone().date().isoformat() if stopped_at else None,
        "phase": phase,
        "phase_label": PHASE_LABELS[phase],
    }


def _in_round(stop: dict | None, round_started_at: object) -> bool:
    if stop is None:
        return False
    started = _parse_time(round_started_at)
    stopped = _parse_time(stop.get("stopped_at"))
    return started is not None and stopped is not None and stopped >= started


def stop_in_round(state_dir: Path | str, round_started_at: object) -> bool:
    """True when a stop was recorded at or after the moment the given round began."""
    return _in_round(read_stop(state_dir), round_started_at)


def legacy_stop(state_dir: Path | str, round_started_at: object) -> dict | None:
    """The stop left by an earlier round, or None.

    round_started_at is when the round now running began; None when no round is running.
    """
    stop = read_stop(state_dir)
    if stop is None or _in_round(stop, round_started_at):
        return None
    return stop


def write_stop(path: Path | str | None, phase: str, *, now: datetime | None = None) -> bool:
    """Record a stop unless one is already recorded. Returns True when this call wrote it."""
    if path is None:
        return False
    if phase not in WRITABLE_PHASES:
        raise ValueError("unsupported safety stop phase")
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return False
    moment = now or datetime.now(timezone.utc)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(
            {"stopped_at": moment.isoformat(), "reason": STOP_REASON, "phase": phase},
            handle,
        )
    return True


def public_view(stop: dict) -> dict:
    """The part of a stop the workbench may show."""
    return {
        "date": stop.get("date"),
        "phase": stop.get("phase", "unknown"),
        "phase_label": stop.get("phase_label", PHASE_LABELS["unknown"]),
    }


def legacy_message(stop: dict) -> str:
    if stop.get("date"):
        return f"{stop['date']} 的安全停止尚未清除"
    return "有一条安全停止尚未清除（记录日期无法读取）"


def clear_stop(state_dir: Path | str, *, now: datetime | None = None) -> dict | None:
    """Archive the stop record by renaming it, keeping its content. Returns what was cleared."""
    stop = read_stop(state_dir)
    if stop is None:
        return None
    path = stop_path(state_dir)
    if stop["date"]:
        stamp = stop["date"].replace("-", "")
    else:
        stamp = (now or datetime.now()).astimezone().strftime("%Y%m%d")
    stem = path.name[: -len(path.suffix)]
    archive = path.with_name(f"{stem}.archived-{stamp}{path.suffix}")
    attempt = 1
    while os.path.lexists(archive):
        attempt += 1
        archive = path.with_name(f"{stem}.archived-{stamp}-{attempt}{path.suffix}")
    os.rename(path, archive)
    return {**public_view(stop), "archived_as": archive.name}
