#!/usr/bin/env python3

"""Loopback-only bridge for user-triggered Xiaohongshu favorites imports."""

from __future__ import annotations

import argparse
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import html
import importlib.util
import inspect
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
from urllib.parse import parse_qs, quote, unquote, urlencode, urlparse
from urllib.request import ProxyHandler, Request, build_opener, urlopen


ORGANIZATION_STATE_PATH = Path(__file__).with_name("organization_state.py")
ORGANIZATION_STATE_SPEC = importlib.util.spec_from_file_location("favsense_organization_state", ORGANIZATION_STATE_PATH)
if ORGANIZATION_STATE_SPEC is None or ORGANIZATION_STATE_SPEC.loader is None:
    raise RuntimeError("organization state reducer is unavailable")
ORGANIZATION_STATE = importlib.util.module_from_spec(ORGANIZATION_STATE_SPEC)
ORGANIZATION_STATE_SPEC.loader.exec_module(ORGANIZATION_STATE)


HOST = "127.0.0.1"
DEFAULT_PORT = 47631
MANAGER_ORIGIN = "http://127.0.0.1:8766"
PROTOCOL_VERSION = 11
MANUAL_START_TIMEOUT_SECONDS = 90
MANUAL_RUN_TIMEOUT_SECONDS = 2 * 60 * 60
MAX_BODY_BYTES = 256 * 1024
MAX_DETAIL_FETCH_BYTES = 32 * 1024 * 1024
MAX_DETAIL_FETCH_ERROR_BYTES = 1024 * 1024
MAX_RUN_BOARD_COUNT = 200
DIANDIAN_RECORD_MAX_BYTES = 512 * 1024
DIANDIAN_REPORT_MAX_BYTES = 8 * 1024 * 1024
NOTE_PATH = re.compile(r"^/(?:explore|discovery/item)/([A-Za-z0-9_-]{1,128})$")
NOTE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
RUN_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
BOARD_ID = re.compile(r"^[a-z0-9]{1,80}$")
TOKEN_QUERY = re.compile(
    r"(?i)([\"']?xsec[\s_-]*token[\"']?\s*[:=]\s*[\"']?)[^\"'&,}\]\s]+"
)
PRIVATE_HEADER = re.compile(
    r"(?i)\b(cookie|set-cookie|authorization|x-xhs-bridge-token|bridge[-_ ]token)"
    r"\s*[:=]\s*[^\r\n]+"
)
PRIVATE_XHS_PATH = re.compile(
    r"(?i)((?:https?://www\.xiaohongshu\.com)?/(?:user/profile|board)/)[A-Za-z0-9_-]+"
)
UNICODE_SURROGATE_ESCAPE = re.compile(
    r"\\u(d[89ab][0-9a-f]{2})\\u(d[cdef][0-9a-f]{2})", re.IGNORECASE
)
UNICODE_CODEPOINT_ESCAPE = re.compile(
    r"\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})", re.IGNORECASE
)
DIANDIAN_CREDENTIAL_KEY = re.compile(
    r"(?i)^(?:cookie|cookies|xsec_token|token|access_token|refresh_token|"
    r"authorization|password|secret)$"
)
DIANDIAN_CREDENTIAL_VALUE = re.compile(
    r"(?i)(?:xsec[\s_-]*token\s*=|"
    r"\b(?:access_token|refresh_token|authorization|cookie|password|secret)\s*[:=]|"
    r"\bBearer\s+[A-Za-z0-9._~+/-]{8,}|"
    r"(?:(?:https?:)?//)?(?:www\.)?xiaohongshu\.com/)"
)
ANY_URL = re.compile(r"(?i)(?:https?://|www\.)")
HF_SPACE_REPOSITORY = re.compile(
    r"^https://huggingface\.co/spaces/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(?:\.git)?$"
)
GIT_BRANCH = re.compile(r"^[A-Za-z0-9._/-]{1,100}$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
USERSCRIPT_INSTALL_PATH = re.compile(
    r"^/install/([a-f0-9]{64})/xhs-favorites\.user\.js$"
)
USERSCRIPT_INSTALL_TTL_SECONDS = 10 * 60
MANUAL_TERMINAL_STATES = frozenset({"completed", "failed", "safety-stopped"})
DIANDIAN_SAFETY_STOP_REASON = "xhs-safety-stop"
PLATFORM_SAFETY_SIGNAL = re.compile(
    r"(?:300031|验证码|滑块(?:验证)?|请完成(?:安全)?验证|访问频繁|操作频繁|"
    r"请求频繁|安全验证|安全限制|captcha|too\s+many\s+requests|"
    r"http(?:/[\d.]+)?\s*429|status[_\s-]*(?:code)?\s*[:=]?\s*429|"
    r"(?:状态码|错误码)\s*[:：=]?\s*429|"
    r"[\"']?(?:code|status)[\"']?\s*[:=]\s*429)",
    re.IGNORECASE,
)
DIANDIAN_LEGACY_HALT_REASONS = {
    "diandian-cdp-failed": "transport-failed",
}
DIANDIAN_HALT_DIAGNOSTICS = {
    "diandian-channel-unavailable": (
        "浏览器无法建立点点 AI 整理通道；核心整理结果已保留。"
        "请确认浏览器允许当前页面通信后重试。"
    ),
    "duplicate-submit": (
        "点点 AI 检测到重复提交风险；核心整理结果已保留。"
        "请检查保留的失败页面后重试。"
    ),
    "invalid-summary": (
        "点点 AI 返回的总结未通过完整性校验；核心整理结果已保留。"
        "请检查保留的失败页面后重试。"
    ),
    "login-required": (
        "点点 AI 需要登录；核心整理结果已保留。"
        "请在保留的失败页面完成登录后重试。"
    ),
    "note-context-mismatch": (
        "点点 AI 的笔记上下文校验失败；核心整理结果已保留。"
        "请检查保留的失败页面后重试。"
    ),
    "note-not-on-board": (
        "点点 AI 计划中的笔记未出现在当前收藏夹；核心整理结果已保留。"
        "请刷新收藏夹后重试。"
    ),
    "page-not-ready": (
        "点点 AI 页面未在时限内准备好；核心整理结果已保留。"
        "请确认保留页面已正常加载后重试。"
    ),
    "run-halted": (
        "点点 AI 整理已停止；核心整理结果已保留。"
        "请从工作台重新开始本次整理。"
    ),
    "share-link-failed": (
        "笔记分享链接复制失败；核心整理结果已保留。"
        "请检查保留的笔记页面后重试。"
    ),
    "share-link-invalid": (
        "笔记页面返回了无效的分享链接；核心整理结果已保留。"
        "请刷新保留的笔记页面后重试。"
    ),
    "share-link-unavailable": (
        "笔记页面没有返回可用的分享链接；核心整理结果已保留。"
        "请确认分享菜单可用后重试。"
    ),
    "share-worker-not-ready": (
        "笔记分享页面未准备好；核心整理结果已保留。"
        "请确认保留页面已正常加载后重试。"
    ),
    "single-note-timeout": (
        "点点 AI 单篇总结超时；核心整理结果已保留。"
        "请检查保留的失败页面后重试。"
    ),
    "stale-reply": (
        "点点 AI 未生成本轮的新回复；核心整理结果已保留。"
        "请检查保留的失败页面后重试。"
    ),
    "stale-target": (
        "点点 AI 浏览器页面已失效；核心整理结果已保留。"
        "请保留失败页面并重试本次整理。"
    ),
    "submit-unconfirmed": (
        "点点 AI 未确认本次提交；核心整理结果已保留。"
        "请检查保留的失败页面后重试。"
    ),
    "transport-failed": (
        "点点 AI 自动整理通道异常；核心整理结果已保留。"
        "请保留失败页面并重试本次整理。"
    ),
    "unexpected-page": (
        "点点 AI 打开了非预期页面；核心整理结果已保留。"
        "请检查保留的失败页面后重试。"
    ),
    "unstable-reply": (
        "点点 AI 的回复在保存前后发生变化；核心整理结果已保留。"
        "请检查保留的失败页面后重试。"
    ),
}
LEGACY_DIANDIAN_HALT_ERROR = (
    "DianDian CDP summarization stopped; core import was preserved."
)
EMPTY_DIAGNOSTIC_ERROR = "No diagnostic output was returned."
MANUAL_SYNC_FALLBACK_ERROR = "请检查 SOP 扫描浏览器的登录状态后再次整理。"
DETAIL_NOTE_FIELDS = frozenset({
    "note_id", "detail_fetched", "comment_evidence_checked", "title",
    "description", "type", "tags", "author", "author_id", "webUrl",
    "published_at", "updated_at", "collected_count", "comment_count",
    "share_count", "liked_count", "comment_evidence",
})
DETAIL_TEXT_LIMITS = {
    "title": 500,
    "description": 20_000,
    "type": 100,
    "tags": 2_000,
    "author": 200,
    "author_id": 256,
    "published_at": 128,
    "updated_at": 128,
    "collected_count": 64,
    "comment_count": 64,
    "share_count": 64,
    "liked_count": 64,
}


class BridgeBusyError(RuntimeError):
    pass


def is_manager_origin(value: str | None) -> bool:
    return value == MANAGER_ORIGIN


def update_board_enabled(config: dict, board_id: str, enabled: bool) -> dict:
    boards = config.get("boards") if isinstance(config, dict) else None
    if config.get("version") != 1 or not isinstance(boards, list):
        raise ValueError("config must use version 1 and contain a boards list")
    matched = None
    for board in boards:
        if isinstance(board, dict) and str(board.get("id", "")) == board_id:
            matched = board
            break
    if matched is None:
        raise ValueError("unknown board_id")
    if not isinstance(enabled, bool):
        raise ValueError("enabled must be a boolean")
    active_enabled = sum(
        board.get("enabled") is True and board.get("available") is not False
        for board in boards if isinstance(board, dict)
    )
    if (
        not enabled
        and matched.get("enabled") is True
        and matched.get("available") is not False
        and active_enabled <= 1
    ):
        raise ValueError("at least one board must remain enabled")
    matched["enabled"] = enabled
    if enabled:
        matched.pop("reason", None)
    else:
        matched["reason"] = "用户在工作台中关闭"
    return config


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the local XHS favorites bridge.")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--skill-dir", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--sop-runtime", required=True)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    return parser.parse_args()


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def restore_file_snapshot(path: Path, snapshot: bytes | None) -> None:
    if snapshot is None:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.{threading.get_ident()}.restore.tmp")
    try:
        temporary.write_bytes(snapshot)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def userscript_install_capability_record(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or value.get("version") != 1:
        return None
    digest = str(value.get("digest", ""))
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        return None
    try:
        issued_at = datetime.fromisoformat(str(value.get("issued_at", "")))
        expires_at = datetime.fromisoformat(str(value.get("expires_at", "")))
    except ValueError:
        return None
    if issued_at.tzinfo is None or expires_at.tzinfo is None:
        return None
    lifetime = expires_at - issued_at
    if lifetime <= timedelta(0) or lifetime > timedelta(seconds=USERSCRIPT_INSTALL_TTL_SECONDS):
        return None
    return value


def userscript_install_version(template_path: Path, state_path: Path) -> str:
    record = userscript_install_capability_record(state_path)
    if record is None:
        raise ValueError("userscript installer state is missing or invalid; run setup-autosync.ps1")
    template = template_path.read_text(encoding="utf-8")
    versions = re.findall(
        r"(?m)^// @version\s+([0-9]+(?:\.[0-9]+){2,})\s*$",
        template,
    )
    if len(versions) != 1:
        raise ValueError("userscript template must contain one numeric @version")
    issued_at = datetime.fromisoformat(str(record["issued_at"])).astimezone(timezone.utc)
    revision = ".".join(str(value) for value in (
        issued_at.year,
        issued_at.month,
        issued_at.day,
        issued_at.hour,
        issued_at.minute,
        issued_at.second,
        issued_at.microsecond,
    ))
    return f"{versions[0]}.{revision}"


def valid_userscript_install_capability(path: Path, candidate: str) -> bool:
    if not re.fullmatch(r"[a-f0-9]{64}", candidate):
        return False
    value = userscript_install_capability_record(path)
    if value is None or value.get("completed_at"):
        return False
    try:
        issued_at = datetime.fromisoformat(str(value["issued_at"]))
        expires_at = datetime.fromisoformat(str(value["expires_at"]))
    except (KeyError, ValueError):
        return False
    now = datetime.now().astimezone()
    if issued_at > now + timedelta(seconds=5) or expires_at <= now:
        return False
    digest = hashlib.sha256(candidate.encode("ascii")).hexdigest()
    return hmac.compare_digest(digest, str(value["digest"]))


def invalidate_userscript_install_capability(path: Path, candidate: str) -> bool:
    if not valid_userscript_install_capability(path, candidate):
        return False
    value = userscript_install_capability_record(path)
    if value is None:
        return False
    value["completed_at"] = datetime.now().astimezone().isoformat()
    atomic_json(path, value)
    return True


def normalize_sensitive_scan(value: object) -> str:
    normalized = str(value or "")
    for _ in range(8):
        decoded = UNICODE_SURROGATE_ESCAPE.sub(
            lambda match: chr(
                0x10000
                + ((int(match.group(1), 16) - 0xD800) << 10)
                + (int(match.group(2), 16) - 0xDC00)
            ),
            normalized,
        )

        def decode_codepoint(match: re.Match) -> str:
            codepoint = int(next(group for group in match.groups() if group is not None), 16)
            if codepoint > 0x10FFFF or 0xD800 <= codepoint <= 0xDFFF:
                return match.group(0)
            return chr(codepoint)

        decoded = UNICODE_CODEPOINT_ESCAPE.sub(decode_codepoint, decoded)
        characters = []
        for character in unicodedata.normalize("NFKC", unquote(html.unescape(decoded))):
            category = unicodedata.category(character)
            if category in {"Cc", "Cf"}:
                if character.isspace():
                    characters.append(" ")
                continue
            characters.append(character)
        next_value = " ".join("".join(characters).split())
        if next_value == normalized:
            break
        normalized = next_value
    return normalized


def sanitize_error(value: str) -> str:
    normalized = normalize_sensitive_scan(value)
    if TOKEN_QUERY.search(normalized) or PRIVATE_HEADER.search(normalized) or PRIVATE_XHS_PATH.search(normalized):
        return "Sensitive diagnostic was [REDACTED]."
    cleaned = TOKEN_QUERY.sub(r"\1[REDACTED]", normalized)
    cleaned = PRIVATE_HEADER.sub(lambda match: f"{match.group(1)}: [REDACTED]", cleaned)
    cleaned = PRIVATE_XHS_PATH.sub(r"\1[REDACTED]", cleaned).strip()
    return cleaned[:1500] if cleaned else EMPTY_DIAGNOSTIC_ERROR


def sanitize_manual_sync_error(value: object) -> str:
    cleaned = sanitize_error(str(value or ""))
    return MANUAL_SYNC_FALLBACK_ERROR if cleaned == EMPTY_DIAGNOSTIC_ERROR else cleaned


def normalize_diandian_halt_reason(value: object) -> str:
    reason = str(value or "").strip()
    reason = DIANDIAN_LEGACY_HALT_REASONS.get(reason, reason)
    if reason not in DIANDIAN_HALT_DIAGNOSTICS:
        raise ValueError("DianDian halt reason is invalid")
    return reason


def contains_diandian_credential_shape(value: object) -> bool:
    if isinstance(value, str):
        return DIANDIAN_CREDENTIAL_VALUE.search(normalize_sensitive_scan(value)) is not None
    if isinstance(value, list):
        return any(contains_diandian_credential_shape(item) for item in value)
    if not isinstance(value, dict):
        return False
    return any(
        DIANDIAN_CREDENTIAL_KEY.fullmatch(normalize_sensitive_scan(key))
        or contains_diandian_credential_shape(child)
        for key, child in value.items()
    )


def valid_diandian_record(value: object, note_id: str) -> bool:
    if isinstance(value, dict) and value.get("version") == 2:
        return bool(
            set(value) == {
                "version", "provider", "prompt", "prompt_version", "note_id", "title",
                "summary", "content_sha256", "request_sha256", "summary_sha256", "captured_at",
            }
            and value.get("provider") == "xiaohongshu-diandian"
            and value.get("prompt") == "总结"
            and value.get("note_id") == note_id
            and isinstance(value.get("title"), str)
            and value["title"].strip()
            and isinstance(value.get("summary"), str)
            and value["summary"].strip()
            and len(value["summary"]) <= 200_000
            and isinstance(value.get("prompt_version"), str)
            and re.fullmatch(r"[a-f0-9]{64}", value["prompt_version"])
            and all(
                isinstance(value.get(key), str)
                and re.fullmatch(r"[a-f0-9]{64}", value[key])
                for key in ("content_sha256", "request_sha256", "summary_sha256")
            )
            and isinstance(value.get("captured_at"), str)
            and not contains_diandian_credential_shape(value)
            and hmac.compare_digest(
                value["summary_sha256"],
                hashlib.sha256(value["summary"].strip().encode("utf-8")).hexdigest(),
            )
        )
    return bool(
        isinstance(value, dict)
        and isinstance(value.get("version"), (int, float))
        and not isinstance(value.get("version"), bool)
        and value.get("version") == 1
        and value.get("provider") == "xiaohongshu-diandian"
        and value.get("prompt") == "总结"
        and value.get("note_id") == note_id
        and isinstance(value.get("title"), str)
        and value["title"].strip()
        and isinstance(value.get("summary"), str)
        and value["summary"].strip()
        and len(value["summary"]) <= 200_000
        and not contains_diandian_credential_shape(value)
    )


def diandian_prompt_version(release: dict, browser_contract: dict) -> str:
    release_version = str(release.get("version", "")).strip()
    if not release_version:
        raise ValueError("DianDian release version is unavailable")
    contract = json.dumps(browser_contract, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(f"{release_version}\0{contract}".encode("utf-8")).hexdigest()


def diandian_result_digest(title: str, summary: str) -> str:
    return hashlib.sha256(f"{title}\0{summary}".encode("utf-8")).hexdigest()


def safe_diandian_fallback_reason(value: str) -> str:
    normalized = normalize_sensitive_scan(value).strip()
    if not normalized:
        raise ValueError("DianDian skip reason must not be empty")
    if contains_diandian_credential_shape(normalized) or ANY_URL.search(normalized):
        return "fallback-required"
    return normalized[:500]


def resolve_workspace_path(workspace: Path, value: str, label: str) -> Path:
    resolved_workspace = workspace.resolve()
    candidate = (resolved_workspace / value).resolve()
    if candidate != resolved_workspace and resolved_workspace not in candidate.parents:
        raise ValueError(f"{label} must stay inside the workspace")
    return candidate


def normalize_publish_config(config: dict) -> dict | None:
    publish = config.get("publish") if isinstance(config, dict) else None
    if not isinstance(publish, dict) or publish.get("enabled") is not True:
        return None
    if publish.get("provider") != "huggingface":
        raise ValueError("publish.provider must be huggingface")
    repository = str(publish.get("repository", "")).strip()
    branch = str(publish.get("branch", "main")).strip()
    if not HF_SPACE_REPOSITORY.fullmatch(repository):
        raise ValueError("publish.repository must be an HTTPS Hugging Face Space repository URL")
    if not GIT_BRANCH.fullmatch(branch) or ".." in branch:
        raise ValueError("publish.branch contains unsupported characters")
    if any(key in publish for key in ("token", "password", "secret")):
        raise ValueError("publish credentials must use the system credential store, not the config file")
    return {"enabled": True, "provider": "huggingface", "repository": repository, "branch": branch}


def normalize_diandian_config(config: dict) -> dict:
    value = config.get("diandian") if isinstance(config, dict) else None
    if value is None:
        return {"enabled": False}
    if not isinstance(value, dict) or not isinstance(value.get("enabled"), bool):
        raise ValueError("diandian.enabled must be a boolean")
    unsupported = set(value) - {"enabled", "skill_path"}
    if unsupported:
        raise ValueError("diandian contains unsupported fields")
    normalized = {"enabled": value["enabled"]}
    if "skill_path" in value:
        skill_path = value["skill_path"]
        if not isinstance(skill_path, str) or not skill_path.strip():
            raise ValueError("diandian.skill_path must be a non-empty path")
        normalized["skill_path"] = skill_path.strip()
    elif value["enabled"]:
        raise ValueError("diandian.skill_path is required when diandian is enabled")
    return normalized


def resolve_diandian_skill_path(workspace: Path, config: dict) -> Path:
    configured = config.get("skill_path")
    if not isinstance(configured, str) or not configured.strip():
        raise ValueError("diandian.skill_path is required when diandian is enabled")
    candidate = Path(configured).expanduser()
    if candidate.is_absolute():
        return candidate.resolve()
    return resolve_workspace_path(workspace, configured, "diandian.skill_path")


def diandian_saver_path(skill_path: Path) -> Path:
    return skill_path / "scripts" / "save_diandian_summary.py"


def diandian_browser_contract_path(skill_path: Path) -> Path:
    return skill_path / "runtime" / "browser-contract.json"


def diandian_cdp_transport_path(skill_path: Path, release: dict) -> Path | None:
    relative_path = release.get("cdp_transport")
    if relative_path is None:
        return None
    if relative_path != "scripts/cdp_transport.py":
        raise ValueError("DianDian CDP transport must use scripts/cdp_transport.py")
    return skill_path / relative_path


def load_diandian_release(skill_path: Path) -> dict:
    release_path = skill_path / "release.json"
    try:
        release = json.loads(release_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("diandian.skill_path is missing a valid release.json") from error
    base_keys = {
        "schema_version", "package", "version", "release_directory",
        "skill_directory", "runtime_contract", "saver", "saver_api", "files",
    }
    if not isinstance(release, dict) or set(release) not in (
        base_keys,
        base_keys | {"cdp_transport"},
    ):
        raise ValueError("DianDian release metadata has an unsupported schema")
    version = str(release.get("version", ""))
    version_match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", version)
    version_parts = tuple(int(part) for part in version_match.groups()) if version_match else ()
    version_family = version_parts[:2]
    expected_keys = (
        base_keys if version_family == (1, 1)
        else base_keys | {"cdp_transport"} if version_family == (1, 2)
        else None
    )
    if expected_keys is None or set(release) != expected_keys:
        raise ValueError("DianDian release metadata has an unsupported version schema")
    cdp_transport = release.get("cdp_transport")
    cdp_release = version_family == (1, 2)
    if (
        release.get("schema_version") != 1
        or release.get("package") != "xhs-diandian-summarize-note"
        or version_match is None
        or release.get("release_directory") != f"xhs-diandian-summarize-note-v{release.get('version')}"
        or release.get("skill_directory") != "xhs-diandian-summarize-note"
        or release.get("runtime_contract") != "runtime/browser-contract.json"
        or release.get("saver") != "scripts/save_diandian_summary.py"
        or release.get("saver_api") != 1
        or not isinstance(release.get("files"), list)
    ):
        raise ValueError("DianDian release metadata does not match the supported runtime contract")
    if cdp_release and (
        cdp_transport != "scripts/cdp_transport.py"
        or cdp_transport not in release["files"]
    ):
        raise ValueError("DianDian CDP transport metadata is invalid")
    return release


def load_diandian_browser_contract(skill_path: Path) -> dict:
    try:
        contract = json.loads(diandian_browser_contract_path(skill_path).read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("DianDian browser contract could not be loaded") from error
    if not isinstance(contract, dict) or set(contract) != {
        "schema_version", "ai_chat_url", "prompt", "selectors", "timings_ms",
        "minimum_summary_chars",
    }:
        raise ValueError("DianDian browser contract has an unsupported schema")
    selectors = contract.get("selectors")
    timings = contract.get("timings_ms")
    expected_selectors = {
        "share_controls", "unlabeled_share_controls", "share_menu_items", "copy_action_text",
        "share_action_text", "input_placeholders", "input_controls",
        "selected_note_card", "assistant_message", "finished_message_class",
    }
    expected_timings = {
        "page_dom_stable", "note_context_stable", "prompt_stable", "reply_text_stable",
        "success_dwell", "between_notes", "share_control_wait", "share_menu_wait",
        "share_worker_wait", "ai_worker_wait", "clipboard_read_wait", "share_result_wait",
        "single_note_wait", "worker_probe_interval", "input_wait", "context_wait",
        "paste_acceptance_wait", "submit_acceptance_wait", "response_wait",
        "reply_settle_wait", "save_ack_wait",
    }
    parsed_url = urlparse(str(contract.get("ai_chat_url", "")))
    string_selectors = (
        isinstance(selectors, dict)
        and set(selectors) == expected_selectors
        and all(
            isinstance(selectors.get(key), str) and 0 < len(selectors[key]) <= 200
            for key in (
                "copy_action_text", "share_action_text", "selected_note_card", "assistant_message",
                "finished_message_class",
            )
        )
        and all(
            isinstance(selectors.get(key), list)
            and 1 <= len(selectors[key]) <= 10
            and all(isinstance(value, str) and 0 < len(value) <= 200 for value in selectors[key])
            for key in (
                "share_controls", "unlabeled_share_controls", "share_menu_items",
                "input_placeholders", "input_controls",
            )
        )
        and all(
            value in selectors["share_controls"]
            for value in selectors["unlabeled_share_controls"]
        )
    )
    numeric_timings = (
        isinstance(timings, dict)
        and set(timings) == expected_timings
        and all(
            isinstance(timings.get(key), int)
            and not isinstance(timings[key], bool)
            and 100 <= timings[key] <= 600_000
            for key in expected_timings
        )
    )
    minimum_single_note_wait = (
        sum(timings.get(key, 0) for key in (
            "input_wait", "paste_acceptance_wait", "context_wait", "prompt_stable",
            "prompt_stable",
            "submit_acceptance_wait", "response_wait", "reply_settle_wait",
            "save_ack_wait", "success_dwell",
        )) + 11_000
        if isinstance(timings, dict)
        else 0
    )
    if not (
        contract.get("schema_version") == 1
        and parsed_url.scheme == "https"
        and parsed_url.hostname == "www.xiaohongshu.com"
        and parsed_url.port in (None, 443)
        and parsed_url.username is None
        and parsed_url.password is None
        and parsed_url.path == "/ai_chat"
        and not parsed_url.params
        and not parsed_url.query
        and not parsed_url.fragment
        and contract.get("prompt") == "总结"
        and string_selectors
        and numeric_timings
        and timings["single_note_wait"] >= minimum_single_note_wait
        and isinstance(contract.get("minimum_summary_chars"), int)
        and not isinstance(contract["minimum_summary_chars"], bool)
        and 1 <= contract["minimum_summary_chars"] <= 10_000
    ):
        raise ValueError("DianDian browser contract contains invalid runtime values")
    return contract


def validate_diandian_skill_path(skill_path: Path) -> Path:
    resolved = skill_path.resolve()
    manifest = resolved / "SKILL.md"
    saver = diandian_saver_path(resolved)
    browser_contract = diandian_browser_contract_path(resolved)
    if not manifest.is_file() or not saver.is_file() or not browser_contract.is_file():
        raise ValueError(
            "diandian.skill_path must contain xhs-diandian-summarize-note "
            "with SKILL.md, release.json, runtime/browser-contract.json and "
            "scripts/save_diandian_summary.py"
        )
    source = manifest.read_text(encoding="utf-8-sig")
    frontmatter = re.match(r"\A---\s*\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", source, re.DOTALL)
    if frontmatter is None or re.search(
        r"(?m)^name:\s*xhs-diandian-summarize-note\s*$",
        frontmatter.group(1),
    ) is None:
        raise ValueError("diandian.skill_path is not xhs-diandian-summarize-note")
    release = load_diandian_release(resolved)
    required_release_files = {
        "SKILL.md", "release.json", "runtime/browser-contract.json",
        "scripts/save_diandian_summary.py",
    }
    cdp_transport = diandian_cdp_transport_path(resolved, release)
    if cdp_transport is not None:
        required_release_files.add("scripts/cdp_transport.py")
    release_files = release.get("files")
    if (
        not all(isinstance(value, str) and value for value in release_files)
        or not required_release_files.issubset(release_files)
        or len(set(release_files)) != len(release_files)
    ):
        raise ValueError("DianDian release file manifest is incomplete")
    for relative_path in release_files:
        candidate = (resolved / relative_path).resolve()
        if (
            candidate != resolved
            and resolved not in candidate.parents
        ) or not candidate.is_file() or candidate.is_symlink():
            raise ValueError("DianDian release file manifest contains an invalid entry")
    load_diandian_browser_contract(resolved)
    if cdp_transport is not None:
        load_diandian_cdp_ask(cdp_transport)
    return resolved


def load_diandian_save_record(path: Path):
    spec = importlib.util.spec_from_file_location("favsense_diandian_store", path)
    if spec is None or spec.loader is None:
        raise ValueError("DianDian summary saver could not be loaded")
    module = importlib.util.module_from_spec(spec)
    previous_bytecode_setting = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous_bytecode_setting
    save_record = getattr(module, "save_record", None)
    if not callable(save_record):
        raise ValueError("DianDian summary saver must export a callable save_record")
    signature = inspect.signature(save_record)
    parameters = list(signature.parameters.values())
    if (
        [parameter.name for parameter in parameters]
        != ["destination", "title", "summary_text", "note_id"]
        or any(
            parameter.kind not in (
                inspect.Parameter.POSITIONAL_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
            )
            or parameter.default is not inspect.Parameter.empty
            for parameter in parameters
        )
    ):
        raise ValueError(
            "DianDian saver API 1 requires save_record(destination, title, summary_text, note_id)"
        )
    return save_record


def load_diandian_cdp_ask(path: Path):
    spec = importlib.util.spec_from_file_location(
        f"favsense_diandian_cdp_{hashlib.sha256(str(path).encode('utf-8')).hexdigest()[:16]}",
        path,
    )
    if spec is None or spec.loader is None:
        raise ValueError("DianDian CDP transport could not be loaded")
    module = importlib.util.module_from_spec(spec)
    previous_bytecode_setting = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        spec.loader.exec_module(module)
    except Exception as error:  # noqa: BLE001 - external module boundary is fail-closed
        raise ValueError("DianDian CDP transport could not be loaded") from error
    finally:
        sys.dont_write_bytecode = previous_bytecode_setting
    ask = getattr(module, "ask", None)
    if not callable(ask):
        raise ValueError("DianDian CDP transport must export a callable ask")
    parameters = list(inspect.signature(ask).parameters.values())
    if (
        [parameter.name for parameter in parameters]
        != ["session", "note_url", "spec", "tries", "sleep"]
        or any(
            parameter.kind not in (
                inspect.Parameter.POSITIONAL_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
            )
            for parameter in parameters
        )
        or parameters[0].default is not inspect.Parameter.empty
        or parameters[1].default is not inspect.Parameter.empty
        or parameters[2].default is not None
        or parameters[3].default != 60
        or not callable(parameters[4].default)
    ):
        raise ValueError(
            "DianDian CDP transport requires ask(session, note_url, spec=None, tries=60, sleep=...)"
        )
    return ask


def runtime_config_fingerprint(
    config_path: Path,
    bridge_path: Path,
    userscript_template: Path,
    diandian_skill_path: Path | None,
) -> str:
    components = [
        ("config", config_path),
        ("bridge", bridge_path),
        ("userscript", userscript_template),
    ]
    if diandian_skill_path is not None:
        release = load_diandian_release(diandian_skill_path)
        components.extend((
            ("diandian-release", diandian_skill_path / "release.json"),
            ("diandian-contract", diandian_browser_contract_path(diandian_skill_path)),
            ("diandian-saver", diandian_saver_path(diandian_skill_path)),
        ))
        transport = diandian_cdp_transport_path(diandian_skill_path, release)
        if transport is not None:
            components.append(("diandian-cdp-transport", transport))
    lines = ["favsense-runtime-v1"]
    for label, path in components:
        try:
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        except OSError as error:
            raise ValueError(f"runtime fingerprint input was not found: {label}") from error
        lines.append(f"{label}:{digest}")
    return hashlib.sha256("\n".join(lines).encode("ascii")).hexdigest()


def parse_board_url(value: str) -> tuple[str, str]:
    parsed = urlparse(value)
    match = re.fullmatch(r"/board/([a-z0-9]{1,80})", parsed.path)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "www.xiaohongshu.com"
        or parsed.port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or not match
    ):
        raise ValueError("--board-url must be an https://www.xiaohongshu.com/board/... URL")
    return value, match.group(1)


def normalize_profile_url(value: object) -> str:
    parsed = urlparse(str(value or "").strip())
    if (
        parsed.scheme != "https"
        or parsed.hostname != "www.xiaohongshu.com"
        or parsed.port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or not re.fullmatch(r"/user/profile/[a-z0-9]{1,128}", parsed.path)
    ):
        raise ValueError("profile_url must be an https://www.xiaohongshu.com/user/profile/... URL")
    query = {"tab": ["fav"], "subTab": ["board"]}
    return parsed._replace(query=urlencode(query, doseq=True)).geturl()


def path_is_reparse_point(path: Path) -> bool:
    candidate = Path(path)
    if candidate.is_symlink():
        return True
    is_junction = getattr(candidate, "is_junction", None)
    if callable(is_junction) and is_junction():
        return True
    try:
        attributes = os.lstat(candidate).st_file_attributes
    except (AttributeError, FileNotFoundError, OSError):
        return False
    return bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def require_plain_directory(path: Path, label: str) -> Path:
    candidate = Path(os.path.abspath(str(path)))
    if path_is_reparse_point(candidate) or not candidate.is_dir():
        raise ValueError(f"{label} is unavailable or redirected")
    return candidate


def require_plain_file(path: Path, label: str) -> Path:
    candidate = Path(os.path.abspath(str(path)))
    if path_is_reparse_point(candidate) or not candidate.is_file():
        raise ValueError(f"{label} is unavailable or redirected")
    return candidate


def require_hex_secret(value: str, label: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{64}", value):
        raise ValueError(f"{label} is missing or invalid; run setup-autosync.ps1")
    return value


class DevToolsEndpoint:
    __slots__ = ("port", "browser_path")

    def __init__(self, port: int, browser_path: str) -> None:
        self.port = port
        self.browser_path = browser_path


class SopBrowserContract:
    __slots__ = ("runtime", "profile", "port_file", "launcher")

    def __init__(self, runtime: Path, profile: Path, port_file: Path, launcher: Path) -> None:
        self.runtime = runtime
        self.profile = profile
        self.port_file = port_file
        self.launcher = launcher


def resolve_sop_browser_contract(runtime: Path) -> SopBrowserContract:
    raw_runtime = Path(os.path.abspath(str(runtime)))
    raw_secrets = raw_runtime / ".secrets"
    raw_browser_profiles = raw_secrets / "browser-profiles"
    raw_profile = raw_browser_profiles / "cdp-chrome"
    raw_scripts = raw_runtime / "scripts"
    raw_port_file = raw_secrets / "cdp-port.txt"
    raw_launcher = raw_scripts / "启动扫描浏览器.bat"
    required_directories = (
        raw_runtime,
        raw_secrets,
        raw_browser_profiles,
        raw_profile,
        raw_scripts,
    )
    required_files = (raw_port_file, raw_launcher)
    if (
        any(path_is_reparse_point(path) for path in (*required_directories, *required_files))
        or not all(path.is_dir() for path in required_directories)
        or not all(path.is_file() for path in required_files)
    ):
        raise ValueError("SOP browser runtime contract is unavailable")
    candidate = raw_runtime.resolve()
    return SopBrowserContract(
        runtime=candidate,
        profile=raw_profile.resolve(),
        port_file=raw_port_file.resolve(),
        launcher=raw_launcher.resolve(),
    )


def normalized_browser_channel_path(path: Path) -> str:
    normalized = os.path.normpath(os.path.abspath(str(path)))
    return normalized.rstrip("\\/").casefold()


def browser_channel_id(runtime: Path) -> str:
    return hashlib.sha256(
        normalized_browser_channel_path(runtime).encode("utf-8")
    ).hexdigest()


class CDPSession:
    def __init__(self, connection) -> None:
        self._connection = connection
        self._next_id = 0
        self._lock = threading.Lock()

    @staticmethod
    def _validate_method(method: str) -> None:
        if (
            not isinstance(method, str)
            or re.fullmatch(r"[A-Za-z]+\.[A-Za-z]+", method) is None
        ):
            raise ValueError("CDP method is invalid")
        if method.startswith("Storage.") or "cookie" in method.casefold():
            raise ValueError("CDP Cookie and Storage commands are forbidden")

    def call(self, method: str, **params):
        self._validate_method(method)
        with self._lock:
            self._next_id += 1
            request_id = self._next_id
            try:
                self._connection.send(json.dumps({
                    "id": request_id,
                    "method": method,
                    "params": params,
                }, separators=(",", ":")))
            except Exception as error:
                raise RuntimeError("CDP connection failed") from error
            deadline = time.monotonic() + 10
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("CDP command timed out")
                try:
                    response = json.loads(self._connection.recv(timeout=remaining))
                except TimeoutError as error:
                    raise RuntimeError("CDP command timed out") from error
                except Exception as error:
                    raise RuntimeError("CDP connection failed") from error
                if not isinstance(response, dict) or response.get("id") != request_id:
                    continue
                if "error" in response:
                    raise RuntimeError("CDP command failed")
                result = response.get("result")
                if not isinstance(result, dict):
                    raise RuntimeError("CDP command returned an invalid result")
                return result

    def evaluate(self, expression: str) -> str:
        if not isinstance(expression, str) or not expression:
            raise ValueError("CDP evaluation expression is invalid")
        response = self.call(
            "Runtime.evaluate",
            expression=expression,
            returnByValue=True,
            awaitPromise=True,
        )
        if response.get("exceptionDetails"):
            raise RuntimeError("CDP page evaluation failed")
        remote = response.get("result")
        if not isinstance(remote, dict):
            raise RuntimeError("CDP page evaluation returned an invalid result")
        value = remote.get("value")
        return "" if value is None else str(value)


def loopback_devtools_json(endpoint: DevToolsEndpoint, path: str, *, method: str = "GET") -> object:
    if not isinstance(path, str) or not path.startswith("/") or "\r" in path or "\n" in path:
        raise ValueError("DevTools request path is invalid")
    try:
        request = Request(f"http://127.0.0.1:{endpoint.port}{path}", method=method)
        with build_opener(ProxyHandler({})).open(request, timeout=5) as response:
            if response.status != HTTPStatus.OK:
                raise RuntimeError("SOP DevTools endpoint rejected the request")
            body = response.read(1024 * 1024 + 1)
    except (OSError, ValueError) as error:
        raise RuntimeError("SOP DevTools endpoint is unavailable") from error
    if len(body) > 1024 * 1024:
        raise RuntimeError("SOP DevTools response is too large")
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise RuntimeError("SOP DevTools response is invalid") from error


def loopback_devtools_action(
    endpoint: DevToolsEndpoint, path: str, *, method: str = "GET"
) -> None:
    if not isinstance(path, str) or not path.startswith("/") or "\r" in path or "\n" in path:
        raise ValueError("DevTools request path is invalid")
    try:
        request = Request(f"http://127.0.0.1:{endpoint.port}{path}", method=method)
        with build_opener(ProxyHandler({})).open(request, timeout=5) as response:
            if response.status != HTTPStatus.OK:
                raise RuntimeError("SOP DevTools endpoint rejected the request")
            if len(response.read(1024 * 1024 + 1)) > 1024 * 1024:
                raise RuntimeError("SOP DevTools response is too large")
    except (OSError, ValueError) as error:
        raise RuntimeError("SOP DevTools endpoint is unavailable") from error


class CDPTarget:
    def __init__(self, endpoint: DevToolsEndpoint, target_id: str, connection) -> None:
        self._endpoint = endpoint
        self._target_id = target_id
        self._connection = connection
        self.session = CDPSession(connection)
        self.closed = False

    def close(self) -> None:
        if self.closed:
            return
        loopback_devtools_action(
            self._endpoint,
            f"/json/close/{quote(self._target_id, safe='')}",
        )
        self._connection.close()
        self.closed = True


def validate_sop_target_response(value: object, endpoint: DevToolsEndpoint) -> tuple[str, str]:
    target_id = value.get("id") if isinstance(value, dict) else None
    websocket_url = value.get("webSocketDebuggerUrl") if isinstance(value, dict) else None
    if (
        not isinstance(target_id, str)
        or re.fullmatch(r"[A-Za-z0-9._-]{1,200}", target_id) is None
        or not isinstance(websocket_url, str)
    ):
        raise RuntimeError("SOP DevTools target response is invalid")
    parsed = urlparse(websocket_url)
    if (
        parsed.scheme != "ws"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or parsed.port != endpoint.port
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != f"/devtools/page/{target_id}"
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("SOP DevTools target websocket is invalid")
    return target_id, parsed._replace(netloc=f"127.0.0.1:{endpoint.port}").geturl()


def open_sop_cdp_target(port_file: Path, initial_url: str = "about:blank") -> CDPTarget:
    if initial_url != "about:blank":
        raise ValueError("new CDP targets must start at about:blank")
    endpoint = read_sop_devtools_endpoint(port_file)
    value = loopback_devtools_json(
        endpoint,
        f"/json/new?{quote(initial_url, safe='')}",
        method="PUT",
    )
    target_id, safe_websocket_url = validate_sop_target_response(value, endpoint)
    try:
        from websockets.sync.client import connect

        connection = connect(
            safe_websocket_url,
            proxy=None,
            open_timeout=5,
            close_timeout=5,
            max_size=1024 * 1024,
        )
    except (ImportError, OSError, RuntimeError) as error:
        raise RuntimeError("SOP DevTools target could not be connected") from error
    return CDPTarget(endpoint, target_id, connection)


def ai_page_state_expression(spec: dict) -> str:
    selectors = spec.get("selectors") if isinstance(spec, dict) else None
    if not isinstance(selectors, dict):
        raise RuntimeError("DianDian CDP selectors are unavailable")
    inputs = selectors.get("input_controls")
    selected = selectors.get("selected_note_card")
    assistant = selectors.get("assistant_message")
    finished_class = selectors.get("finished_message_class")
    if (
        not isinstance(inputs, list)
        or not inputs
        or not all(isinstance(value, str) for value in inputs)
        or not all(isinstance(value, str) for value in (selected, assistant, finished_class))
    ):
        raise RuntimeError("DianDian CDP selectors are unavailable")
    return (
        "JSON.stringify((()=>{"
        f"const inputs={json.dumps(inputs, ensure_ascii=False)};"
        f"const selected={json.dumps(selected, ensure_ascii=False)};"
        f"const assistant={json.dumps(assistant, ensure_ascii=False)};"
        f"const finishedClass={json.dumps(finished_class, ensure_ascii=False)};"
        "const m=[...document.querySelectorAll(assistant)];"
        "const f=m.filter(x=>x.classList.contains(finishedClass));"
        "const t=inputs.flatMap(s=>[...document.querySelectorAll(s)]).find(x=>x.offsetParent);"
        "const safeBody=document.body?.cloneNode(true);"
        "safeBody?.querySelectorAll(assistant).forEach(x=>x.remove());"
        "safeBody?.querySelectorAll(selected).forEach(x=>x.remove());"
        "return {href:location.href,body:(safeBody?.innerText||'').slice(0,200000),"
        "input_ready:!!t,"
        "ready:document.readyState,cards:document.querySelectorAll(selected).length,"
        "msgs:m.length,fin:f.length,val:t?.value||'',last:f.length?f[f.length-1].innerText:''};})())"
    )


def read_ai_page_state(session, expression: str) -> dict:
    try:
        value = json.loads(session.evaluate(expression) or "{}")
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("DianDian page state is invalid") from error
    if not isinstance(value, dict):
        raise RuntimeError("DianDian page state is invalid")
    for key in ("href", "body", "ready", "val", "last"):
        if not isinstance(value.get(key, ""), str):
            raise RuntimeError("DianDian page state is invalid")
    for key in ("cards", "msgs", "fin"):
        if not isinstance(value.get(key, 0), int) or isinstance(value.get(key, 0), bool):
            raise RuntimeError("DianDian page state is invalid")
    if not isinstance(value.get("input_ready"), bool):
        raise RuntimeError("DianDian page state is invalid")
    return {
        "href": value.get("href", ""),
        "body": value.get("body", ""),
        "ready": value.get("ready", ""),
        "input_ready": value["input_ready"],
        "cards": value.get("cards", 0),
        "msgs": value.get("msgs", 0),
        "fin": value.get("fin", 0),
        "val": value.get("val", ""),
        "last": value.get("last", ""),
    }


class DiandianPageStop(RuntimeError):
    def __init__(self, reason: str, *, safety: bool = False) -> None:
        super().__init__(reason)
        self.reason = reason
        self.safety = safety


def validate_ai_page_state(value: dict, expected_url: str) -> None:
    parsed = urlparse(value.get("href", ""))
    expected = urlparse(expected_url)
    if (
        parsed.scheme != expected.scheme
        or parsed.hostname != expected.hostname
        or parsed.port not in (None, 443)
        or parsed.path != expected.path
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise DiandianPageStop("unexpected-page")
    body = normalize_sensitive_scan(value.get("body", ""))
    if PLATFORM_SAFETY_SIGNAL.search(body):
        raise DiandianPageStop("safety-stop", safety=True)
    if re.search(r"(?:请先登录|登录后继续|扫码登录|手机号登录)", body):
        raise DiandianPageStop("login-required")


class GuardedDiandianSession:
    """Enforce exact-note input and a strictly new, stable finished reply."""

    def __init__(
        self,
        session,
        note_url: str,
        prompt: str,
        ai_url: str,
        state_expression: str,
        cancelled,
        *,
        context_wait_seconds: float,
        context_stable_seconds: float,
        context_sleep,
        context_clock=time.monotonic,
        input_gate: threading.Lock | None = None,
    ) -> None:
        self._session = session
        self._note_url = note_url
        self._prompt = prompt
        self._ai_url = ai_url
        self._state_expression = state_expression
        self._cancelled = cancelled
        self._context_wait_seconds = context_wait_seconds
        self._context_stable_seconds = context_stable_seconds
        self._context_sleep = context_sleep
        self._context_clock = context_clock
        self._input_gate = input_gate or threading.Lock()
        self._insert_count = 0
        self._submitted = False
        self._submit_released = False
        self.baseline_msgs = 0
        self.baseline_fin = 0

    def _ensure_active(self) -> None:
        if self._cancelled():
            raise DiandianPageStop("run-halted")

    def evaluate(self, expression: str) -> str:
        self._ensure_active()
        validate_ai_page_state(
            read_ai_page_state(self._session, self._state_expression),
            self._ai_url,
        )
        self._ensure_active()
        return self._session.evaluate(expression)

    def _dispatch_input(self, method: str, params: dict):
        with self._input_gate:
            self._ensure_active()
            return self._session.call(method, **params)

    def call(self, method: str, **params):
        self._ensure_active()
        page_state = read_ai_page_state(self._session, self._state_expression)
        validate_ai_page_state(page_state, self._ai_url)
        self._ensure_active()
        if method.startswith("Input.") and not page_state["input_ready"]:
            raise DiandianPageStop("page-not-ready")
        if method == "Input.insertText":
            text = params.get("text")
            if self._insert_count == 0:
                if text != self._note_url:
                    raise DiandianPageStop("note-context-mismatch")
            elif self._insert_count == 1:
                if text != f" {self._prompt}":
                    raise DiandianPageStop("note-context-mismatch")
                deadline = self._context_clock() + self._context_wait_seconds
                while True:
                    self._ensure_active()
                    if self._context_clock() >= deadline:
                        raise DiandianPageStop("note-context-mismatch")
                    state = read_ai_page_state(self._session, self._state_expression)
                    validate_ai_page_state(state, self._ai_url)
                    selected = state["cards"] == 1 and state["val"] == ""
                    direct = state["cards"] == 0 and state["val"] == self._note_url
                    if selected or direct:
                        expected = (state["cards"], state["val"])
                        remaining = deadline - self._context_clock()
                        if remaining < self._context_stable_seconds:
                            raise DiandianPageStop("note-context-mismatch")
                        self._context_sleep(self._context_stable_seconds)
                        self._ensure_active()
                        if self._context_clock() > deadline:
                            raise DiandianPageStop("note-context-mismatch")
                        confirmed = read_ai_page_state(
                            self._session,
                            self._state_expression,
                        )
                        validate_ai_page_state(confirmed, self._ai_url)
                        if (confirmed["cards"], confirmed["val"]) == expected:
                            break
                    remaining = deadline - self._context_clock()
                    if remaining <= 0:
                        raise DiandianPageStop("note-context-mismatch")
                    self._context_sleep(min(0.5, remaining))
            else:
                raise DiandianPageStop("note-context-mismatch")
            result = self._dispatch_input(method, params)
            self._insert_count += 1
            return result
        if method == "Input.dispatchKeyEvent" and params.get("type") == "keyDown":
            if self._submitted:
                raise DiandianPageStop("duplicate-submit")
            state = read_ai_page_state(self._session, self._state_expression)
            selected = state["cards"] == 1 and state["val"] == self._prompt
            direct = state["cards"] == 0 and state["val"] == f"{self._note_url} {self._prompt}"
            if self._insert_count != 2 or not (selected or direct):
                raise DiandianPageStop("note-context-mismatch")
            self.baseline_msgs = state["msgs"]
            self.baseline_fin = state["fin"]
            result = self._dispatch_input(method, params)
            self._submitted = True
            return result
        elif method == "Input.dispatchKeyEvent" and params.get("type") == "keyUp":
            if not self._submitted or self._submit_released:
                raise DiandianPageStop("duplicate-submit")
            result = self._dispatch_input(method, params)
            self._submit_released = True
            return result
        if method.startswith("Input."):
            return self._dispatch_input(method, params)
        return self._session.call(method, **params)

    def verify_new_reply(self, reply: str, stable_sleep, stable_seconds: float) -> str:
        if not self._submitted or not self._submit_released:
            raise DiandianPageStop("submit-unconfirmed")
        self._ensure_active()
        first = read_ai_page_state(self._session, self._state_expression)
        if (
            first["msgs"] <= self.baseline_msgs
            or first["fin"] <= self.baseline_fin
            or first["last"].strip() != reply.strip()
        ):
            raise DiandianPageStop("stale-reply")
        stable_sleep(stable_seconds)
        self._ensure_active()
        second = read_ai_page_state(self._session, self._state_expression)
        if (
            second["msgs"] != first["msgs"]
            or second["fin"] != first["fin"]
            or second["last"].strip() != reply.strip()
        ):
            raise DiandianPageStop("unstable-reply")
        return reply.strip()


def read_sop_devtools_endpoint(port_file: Path) -> DevToolsEndpoint:
    if path_is_reparse_point(port_file):
        raise RuntimeError("SOP CDP port registry is invalid")
    try:
        lines = Path(port_file).read_text(encoding="ascii").splitlines()
        port = int(lines[0])
    except (OSError, UnicodeError, ValueError, IndexError) as error:
        raise RuntimeError("SOP CDP port registry is unavailable") from error
    if len(lines) != 1 or not 1024 <= port <= 65535:
        raise RuntimeError("SOP CDP port registry is invalid")
    provisional = DevToolsEndpoint(port=port, browser_path="/devtools/browser/pending")
    value = loopback_devtools_json(provisional, "/json/version")
    websocket_url = value.get("webSocketDebuggerUrl") if isinstance(value, dict) else None
    parsed = urlparse(websocket_url) if isinstance(websocket_url, str) else None
    if (
        parsed is None
        or parsed.scheme != "ws"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or parsed.port != port
        or parsed.username is not None
        or parsed.password is not None
        or re.fullmatch(r"/devtools/browser/[A-Za-z0-9._-]{1,160}", parsed.path) is None
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("SOP DevTools websocket is invalid")
    browser_path = parsed.path
    return DevToolsEndpoint(port=port, browser_path=browser_path)


def validate_xiaohongshu_browser_url(value: str) -> str:
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "www.xiaohongshu.com"
        or parsed.port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise ValueError("shared SOP browser can only open an HTTPS Xiaohongshu URL")
    return value


def note_id_from_url(value: str) -> str:
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
        raise ValueError("payload contains a non-Xiaohongshu or unsupported note URL")
    return match.group(1)


def canonical_signed_note_url(value: str, expected_note_id: str) -> str:
    if not isinstance(value, str) or len(value) > 8_192:
        raise ValueError("signed note URL is invalid")
    parsed = urlparse(value)
    match = re.fullmatch(r"/discovery/item/([A-Za-z0-9_-]{1,128})", parsed.path)
    query = parse_qs(parsed.query, keep_blank_values=True)
    tokens = query.get("xsec_token", [])
    if (
        parsed.scheme != "https"
        or parsed.hostname != "www.xiaohongshu.com"
        or parsed.port not in (None, 443)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.params
        or parsed.fragment
        or match is None
        or match.group(1) != expected_note_id
        or len(tokens) != 1
        or not isinstance(tokens[0], str)
        or not tokens[0]
        or len(tokens[0]) > 2_048
    ):
        raise ValueError("signed note URL does not match the planned note")
    # The external Skill contract accepts only the stable, query-free note URL.
    return f"https://www.xiaohongshu.com/discovery/item/{expected_note_id}"


def read_catalog_ids(path: Path) -> set[str]:
    if not path.exists():
        return set()
    catalog = json.loads(path.read_text(encoding="utf-8-sig"))
    notes = catalog.get("notes") if isinstance(catalog, dict) else None
    if not isinstance(catalog, dict) or catalog.get("version") != 1 or not isinstance(notes, dict):
        raise ValueError("catalog has an unsupported format")
    return set(notes)


def media_urls_to_cache(unique: dict[str, str], curated_ids: set[str], media_dir: Path) -> list[str]:
    urls = []
    for note_id, url in unique.items():
        if note_id in curated_ids:
            continue
        if any(media_dir.glob(f"{note_id}.*")) or any(media_dir.glob(f"{note_id}_*.*")):
            continue
        urls.append(url)
    return urls


def normalize_published_since(value: object) -> str | None:
    if value in (None, ""):
        return None
    date = str(value).strip()
    if not ISO_DATE.fullmatch(date):
        raise ValueError("published_since must use YYYY-MM-DD")
    datetime.strptime(date, "%Y-%m-%d")
    return date


def filter_media_candidates(
    unique: dict[str, str], notes: dict[str, dict], published_since: str | None
) -> dict[str, str]:
    if published_since is None:
        return dict(unique)
    selected = {}
    for note_id, url in unique.items():
        note = notes.get(note_id)
        published = str(note.get("published_at") or "").strip()[:10] if isinstance(note, dict) else ""
        if ISO_DATE.fullmatch(published) and published >= published_since:
            selected[note_id] = url
    return selected


def valid_fetch_note(note: object) -> bool:
    if not isinstance(note, dict) or not set(note).issubset(DETAIL_NOTE_FIELDS):
        return False
    note_id = note.get("note_id")
    if not isinstance(note_id, str) or not NOTE_ID.fullmatch(note_id):
        return False
    if note.get("detail_fetched") is not True or note.get("comment_evidence_checked") is not True:
        return False
    for key, limit in DETAIL_TEXT_LIMITS.items():
        value = note.get(key)
        if value is not None and (not isinstance(value, str) or len(value) > limit):
            return False
    web_url = note.get("webUrl")
    if web_url is not None and web_url != f"https://www.xiaohongshu.com/explore/{note_id}":
        return False
    comments = note.get("comment_evidence")
    if comments is not None:
        if not isinstance(comments, list) or len(comments) > 30:
            return False
        for comment in comments:
            if (
                not isinstance(comment, dict)
                or not set(comment).issubset({"text", "reply", "liked_count"})
                or not isinstance(comment.get("text"), str)
                or not comment["text"]
                or len(comment["text"]) > 500
                or not isinstance(comment.get("reply"), bool)
            ):
                return False
            likes = comment.get("liked_count")
            if likes is not None and (not isinstance(likes, str) or len(likes) > 64):
                return False
    return True


def parse_fetch_payload(
    value: str, expected_ids: set[str] | None = None
) -> tuple[list[dict], list[dict]]:
    """Validate the detail fetcher's private subprocess contract."""
    if len(value.encode("utf-8")) > MAX_DETAIL_FETCH_BYTES:
        raise ValueError("detail fetcher returned an oversized payload")
    try:
        payload = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError("detail fetcher returned invalid JSON") from error
    if not isinstance(payload, dict) or set(payload) != {"notes", "failures"}:
        raise ValueError("detail fetcher returned an invalid payload")
    notes = payload.get("notes")
    failures = payload.get("failures")
    maximum_results = len(expected_ids) if expected_ids is not None else 1000
    if not isinstance(notes, list) or len(notes) > maximum_results or not all(
        valid_fetch_note(note) for note in notes
    ):
        raise ValueError("detail fetcher returned invalid notes")
    if not isinstance(failures, list) or not all(
        isinstance(item, dict)
        and set(item) == {"note_id", "reason"}
        and isinstance(item.get("note_id"), str)
        and NOTE_ID.fullmatch(item["note_id"])
        and item.get("reason") in {"detail unavailable", "request failed", "safety stop"}
        for item in failures
    ):
        raise ValueError("detail fetcher returned invalid failures")
    note_ids = [note["note_id"] for note in notes]
    failure_ids = [item["note_id"] for item in failures]
    all_ids = note_ids + failure_ids
    if len(set(all_ids)) != len(all_ids):
        raise ValueError("detail fetcher returned duplicate note results")
    if expected_ids is not None and set(all_ids) != expected_ids:
        raise ValueError("detail fetcher results did not match the requested notes")
    return notes, failures


def run_bounded_subprocess(
    command: list[str],
    *,
    input_text: str,
    cwd: Path,
    env: dict[str, str] | None,
    timeout: float,
    stdout_limit: int,
    stderr_limit: int,
) -> subprocess.CompletedProcess[str]:
    """Capture a child process without allowing either output pipe to grow unbounded."""
    if stdout_limit < 1 or stderr_limit < 1:
        raise ValueError("subprocess output limits must be positive")
    process = subprocess.Popen(
        command,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        env=env,
        start_new_session=os.name != "nt",
    )
    if process.stdin is None or process.stdout is None or process.stderr is None:
        process.kill()
        process.wait()
        raise RuntimeError("detail fetcher pipes are unavailable")

    stdout_chunks = bytearray()
    stderr_chunks = bytearray()
    overflow = threading.Event()
    stop_lock = threading.Lock()
    reader_errors: list[OSError] = []
    windows_job = None
    windows_job_closed = False

    if os.name == "nt":
        import ctypes  # pylint: disable=import-outside-toplevel
        from ctypes import wintypes  # pylint: disable=import-outside-toplevel

        class JobBasicLimitInformation(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IoCounters(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class JobExtendedLimitInformation(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JobBasicLimitInformation),
                ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        windows_job = kernel32.CreateJobObjectW(None, None)
        try:
            if not windows_job:
                raise ctypes.WinError(ctypes.get_last_error())
            job_info = JobExtendedLimitInformation()
            job_info.BasicLimitInformation.LimitFlags = 0x2000  # KILL_ON_JOB_CLOSE
            if not kernel32.SetInformationJobObject(
                windows_job, 9, ctypes.byref(job_info), ctypes.sizeof(job_info)
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            if not kernel32.AssignProcessToJobObject(windows_job, wintypes.HANDLE(process._handle)):
                raise ctypes.WinError(ctypes.get_last_error())
        except Exception:
            if windows_job:
                kernel32.CloseHandle(windows_job)
                windows_job = None
            process.kill()
            process.wait()
            raise RuntimeError("detail fetcher could not be placed in a bounded process job")

    def stop_process() -> None:
        nonlocal windows_job_closed
        with stop_lock:
            if windows_job is not None and not windows_job_closed:
                kernel32.CloseHandle(windows_job)
                windows_job_closed = True
            elif os.name != "nt":
                try:
                    os.killpg(process.pid, 9)
                except OSError:
                    pass
            elif process.poll() is None:
                try:
                    process.kill()
                except OSError:
                    pass

    def read_stream(stream, limit: int, destination: bytearray) -> None:
        remaining = limit
        try:
            while True:
                chunk = os.read(stream.fileno(), min(64 * 1024, max(1, remaining + 1)))
                if not chunk:
                    break
                kept = chunk[:remaining]
                if kept:
                    destination.extend(kept)
                    remaining -= len(kept)
                if len(kept) != len(chunk):
                    overflow.set()
                    stop_process()
        except OSError as error:
            if process.poll() is None and not overflow.is_set():
                reader_errors.append(error)
                stop_process()
        finally:
            try:
                stream.close()
            except OSError:
                pass

    def write_input() -> None:
        try:
            process.stdin.write(input_text.encode("utf-8"))
            process.stdin.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass

    stdout_thread = threading.Thread(
        target=read_stream,
        args=(process.stdout, stdout_limit, stdout_chunks),
        daemon=True,
    )
    stderr_thread = threading.Thread(
        target=read_stream,
        args=(process.stderr, stderr_limit, stderr_chunks),
        daemon=True,
    )
    input_thread = threading.Thread(target=write_input, daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    input_thread.start()

    timed_out = False
    deadline = time.monotonic() + timeout
    try:
        returncode = process.wait(timeout=max(0.001, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        timed_out = True
        stop_process()
        try:
            returncode = process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            returncode = process.poll() if process.poll() is not None else -9
    finally:
        threads = (input_thread, stdout_thread, stderr_thread)
        for thread in threads:
            thread.join(timeout=max(0.0, deadline - time.monotonic()))
        if any(thread.is_alive() for thread in threads):
            timed_out = True
            stop_process()
            cleanup_deadline = time.monotonic() + 0.5
            for thread in threads:
                thread.join(timeout=max(0.0, cleanup_deadline - time.monotonic()))

    if windows_job is not None and not windows_job_closed:
        kernel32.CloseHandle(windows_job)
        windows_job_closed = True

    if timed_out:
        raise subprocess.TimeoutExpired(command, timeout)
    if overflow.is_set():
        raise ValueError("detail fetcher exceeded its output limit")
    if reader_errors:
        raise RuntimeError("detail fetcher output could not be read") from reader_errors[0]
    return subprocess.CompletedProcess(
        command,
        returncode,
        stdout_chunks.decode("utf-8", errors="replace"),
        stderr_chunks.decode("utf-8", errors="replace"),
    )


class Bridge:
    def __init__(
        self,
        workspace: Path,
        skill_dir: Path,
        config_path: Path,
        sop_runtime: Path,
        port: int,
    ) -> None:
        raw_workspace = require_plain_directory(workspace, "workspace")
        raw_skill_dir = require_plain_directory(skill_dir, "Skill directory")
        raw_config_path = require_plain_file(config_path, "configuration")
        self.workspace = raw_workspace.resolve()
        self.skill_dir = raw_skill_dir.resolve()
        self.config_path = raw_config_path.resolve()
        ORGANIZATION_STATE._contract()
        self.organization_status_v2_enabled = True
        config = json.loads(self.config_path.read_text(encoding="utf-8-sig"))
        self.profile_url = normalize_profile_url(config.get("profile_url"))
        self.all_boards = []
        self.boards = {}
        self.board_order = []
        self.refresh_boards(config)
        self.published_since = normalize_published_since(config.get("published_since"))
        self.video_analysis_enabled = (
            isinstance(config.get("video_analysis"), dict)
            and config["video_analysis"].get("enabled") is True
        )
        self.diandian_config = normalize_diandian_config(config)
        self.diandian_enabled = self.diandian_config["enabled"]
        self.knowledge_base = resolve_workspace_path(self.workspace, str(config.get("knowledge_base", "knowledge-base")), "knowledge_base")
        self.port = port
        self.state_dir = self.workspace / ".xhs-favorites"
        self.sop_browser = resolve_sop_browser_contract(sop_runtime)
        self.sop_port_file = self.sop_browser.port_file
        self.browser_channel_id = browser_channel_id(self.sop_browser.runtime)
        self.token_path = self.state_dir / "bridge-token"
        self.status_path = self.state_dir / "bridge-status.json"
        self.manual_sync_path = self.state_dir / "manual-sync.json"
        self.catalog_path = self.state_dir / "catalog.json"
        self.diandian_dir = self.state_dir / "diandian-summaries"
        self.diandian_report_path = self.state_dir / "diandian-rerun-report.json"
        self.xhs_dir = self.workspace / ".xhs-tools" / "XHS-Downloader"
        self.python = self.xhs_dir / ".venv" / "Scripts" / "python.exe"
        self.fetcher = self.skill_dir / "scripts" / "fetch-xhs-details.py"
        self.media_fetcher = self.skill_dir / "scripts" / "download-pending-media.py"
        self.media_dir = self.state_dir / "media"
        self.run_dir = self.state_dir / "runs"
        self.organizer = self.skill_dir / "scripts" / "organize.mjs"
        self.builder = self.skill_dir / "scripts" / "build-knowledge-base.mjs"
        self.public_builder = self.skill_dir / "scripts" / "build-public-site.mjs"
        self.publisher = self.skill_dir / "scripts" / "publish-huggingface.mjs"
        self.publish_config = normalize_publish_config(config)
        self.curation = resolve_workspace_path(self.workspace, str(config.get("curation_file", "skills/xhs-favorites-organizer/references/skills-board-curation.json")), "curation_file")
        self.profile = resolve_workspace_path(self.workspace, str(config.get("domain_profile", "config/domain-profiles/software.json")), "domain_profile")
        self.resource_registry = None
        self.userscript = self.state_dir / "xhs-favorites.user.js"
        self.userscript_install_state = self.state_dir / "userscript-install.json"
        self.userscript_install_capability_path = self.state_dir / "userscript-install-capability"
        self.userscript_template = self.skill_dir / "assets" / "xhs-favorites.user.js.template"
        private_directories = [
            self.state_dir,
            self.workspace / ".xhs-tools",
            self.xhs_dir,
            self.xhs_dir / ".venv",
            self.xhs_dir / ".venv" / "Scripts",
        ]
        for private_directory in private_directories:
            require_plain_directory(private_directory, "private runtime directory")
        require_plain_file(self.token_path, "bridge token")
        require_plain_file(
            self.userscript_install_capability_path,
            "userscript installer capability",
        )
        self.diandian_skill_path = None
        self.diandian_saver_path = None
        self.diandian_release = None
        self.diandian_cdp_transport_path = None
        self.diandian_cdp_ask = None
        self.diandian_cdp_enabled = False
        self.diandian_cdp_spec = None
        self.diandian_browser_contract = {"enabled": False}
        if self.diandian_enabled:
            self.diandian_skill_path = validate_diandian_skill_path(
                resolve_diandian_skill_path(
                    self.workspace,
                    self.diandian_config,
                )
            )
            self.diandian_release = load_diandian_release(self.diandian_skill_path)
            self.diandian_saver_path = diandian_saver_path(self.diandian_skill_path)
            self.diandian_cdp_transport_path = diandian_cdp_transport_path(
                self.diandian_skill_path,
                self.diandian_release,
            )
            self.diandian_cdp_spec = load_diandian_browser_contract(
                self.diandian_skill_path
            )
            if self.diandian_cdp_transport_path is not None:
                self.diandian_cdp_ask = load_diandian_cdp_ask(
                    self.diandian_cdp_transport_path
                )
                self.diandian_cdp_enabled = True
            self.diandian_browser_contract = {
                "enabled": True,
                "cdp_enabled": self.diandian_cdp_enabled,
                **self.diandian_cdp_spec,
            }
        self.diandian_save_record = None
        self.token = require_hex_secret(
            self.token_path.read_text(encoding="utf-8"),
            "bridge token",
        )
        self.install_capability = require_hex_secret(
            self.userscript_install_capability_path.read_text(encoding="utf-8"),
            "userscript installer",
        )
        required_files = [
            self.python,
            self.fetcher,
            self.media_fetcher,
            self.organizer,
            self.builder,
            self.public_builder,
            self.curation,
            self.profile,
            self.userscript_template,
            self.userscript_install_state,
        ]
        if self.publish_config is not None:
            required_files.append(self.publisher)
        if self.diandian_enabled:
            required_files.append(self.diandian_saver_path)
            required_files.append(diandian_browser_contract_path(self.diandian_skill_path))
            if self.diandian_cdp_transport_path is not None:
                required_files.append(self.diandian_cdp_transport_path)
        if self.profile.is_file():
            profile_config = json.loads(self.profile.read_text(encoding="utf-8-sig"))
            resource_index = profile_config.get("resource_index", {})
            if profile_config.get("features", {}).get("resource_index") is True:
                self.resource_registry = resolve_workspace_path(
                    self.workspace,
                    str(resource_index.get("registry_file", "skills/xhs-favorites-organizer/references/software-resources.json")),
                    "resource_registry",
                )
                required_files.append(self.resource_registry)
        for required in required_files:
            require_plain_file(required, f"required file {required}")
        if self.diandian_enabled:
            self.diandian_save_record = load_diandian_save_record(self.diandian_saver_path)
        self.userscript_install_version = userscript_install_version(
            self.userscript_template,
            self.userscript_install_state,
        )
        self.regenerate_userscript()
        self.config_id = hashlib.sha256(self.token.encode("utf-8")).hexdigest()
        self.runtime_id = runtime_config_fingerprint(
            self.config_path,
            Path(__file__).resolve(),
            self.userscript_template,
            self.diandian_skill_path,
        )
        self.processing_lock = threading.Lock()
        self.trigger_lock = threading.Lock()
        self._manual_sync_lock = threading.RLock()
        self.summary_plans: dict[str, set[str]] = {}
        self.summary_locks: dict[str, threading.RLock] = {}
        self.summary_locks_guard = threading.Lock()
        self._summary_report_lock = threading.RLock()
        self.summary_finalizing: set[str] = set()
        self.summary_finalized: set[str] = set()
        self.summary_halted: set[str] = set()
        self.summary_publish_claimed: set[str] = set()
        self.summary_finalization_threads: dict[str, threading.Thread] = {}
        self.diandian_cdp_guard = threading.Lock()
        self.diandian_cdp_active: set[tuple[str, str]] = set()
        self.diandian_cdp_results: dict[tuple[str, str], dict] = {}
        self.diandian_cdp_cancellations: dict[
            tuple[str, str], tuple[threading.Lock, threading.Event]
        ] = {}
        self.diandian_cdp_run_cancellations: dict[
            str, tuple[threading.Lock, threading.Event]
        ] = {}
        self.diandian_sleep = time.sleep

    @staticmethod
    def manual_run_id(batch: str, board_id: str) -> str:
        value = re.sub(r"[^A-Za-z0-9_-]", "", f"{batch}_{board_id}")
        if len(value) <= 80:
            return value
        digest = hashlib.sha256(f"{batch}\0{board_id}".encode("utf-8")).hexdigest()[:16]
        return f"{value[:63]}_{digest}"

    def single_note_run_target(self, note_id: object) -> tuple[str, str]:
        if not isinstance(note_id, str) or not NOTE_ID.fullmatch(note_id):
            raise ValueError("single-note validation note_id is invalid")
        if not getattr(self, "diandian_cdp_enabled", False):
            raise ValueError("DianDian CDP summarization is unavailable")
        if not self.catalog_path.is_file():
            raise ValueError("catalog is unavailable")
        try:
            catalog = json.loads(self.catalog_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError("catalog is unavailable") from error
        if not isinstance(catalog, dict):
            raise ValueError("catalog has an unsupported format")
        notes = catalog.get("notes")
        if catalog.get("version") != 1 or not isinstance(notes, dict):
            raise ValueError("catalog has an unsupported format")
        note = notes.get(note_id)
        if not isinstance(note, dict) or note.get("note_id") != note_id:
            raise ValueError("note is not a stable catalog member")
        source_ids = note.get("source_board_ids")
        if (
            not isinstance(source_ids, list)
            or not source_ids
            or not all(isinstance(board_id, str) and BOARD_ID.fullmatch(board_id) for board_id in source_ids)
        ):
            raise ValueError("note has no eligible source board")
        board_id = next((candidate for candidate in source_ids if candidate in self.boards), None)
        if board_id is None:
            raise ValueError("note has no enabled and available source board")
        return note_id, board_id

    def normalize_manual_sync_request(
        self, payload: dict | None
    ) -> tuple[list[str] | None, str, str | None]:
        request = {} if payload is None else payload
        if not isinstance(request, dict) or set(request) - {"board_ids", "mode", "note_id"}:
            raise ValueError("manual organization request contains unsupported fields")
        if "note_id" in request:
            if set(request) != {"note_id"}:
                raise ValueError("single-note validation request must contain only note_id")
            note_id, board_id = self.single_note_run_target(request["note_id"])
            return [board_id], "history", note_id
        mode = request.get("mode", "incremental")
        if not isinstance(mode, str) or mode not in {"incremental", "history"}:
            raise ValueError("manual organization mode is invalid")
        if "board_ids" not in request:
            return None, mode, None
        board_ids = request["board_ids"]
        if (
            not isinstance(board_ids, list)
            or not 1 <= len(board_ids) <= MAX_RUN_BOARD_COUNT
            or not all(isinstance(board_id, str) and BOARD_ID.fullmatch(board_id) for board_id in board_ids)
            or len(set(board_ids)) != len(board_ids)
        ):
            raise ValueError("board_ids must contain unique supported board identifiers")
        if any(board_id not in self.boards for board_id in board_ids):
            raise ValueError("requested board is not enabled or available")
        return list(board_ids), mode, None

    def run_board_order(self, batch: str) -> list[str]:
        state = self.read_manual_sync()
        if not RUN_ID.fullmatch(batch) or state.get("batch") != batch:
            raise ValueError("invalid organization batch")
        scoped = state.get("run_board_ids")
        if scoped is None:
            return list(getattr(self, "board_order", self.boards))
        if (
            not isinstance(scoped, list)
            or not scoped
            or len(scoped) > MAX_RUN_BOARD_COUNT
            or not all(isinstance(board_id, str) and board_id in self.boards for board_id in scoped)
            or len(set(scoped)) != len(scoped)
        ):
            raise ValueError("manual organization scope is invalid")
        return list(scoped)

    def read_manual_sync(self) -> dict:
        if not self.manual_sync_path.exists():
            return {"state": "idle"}
        try:
            value = json.loads(self.manual_sync_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            return {"state": "idle"}
        return value if isinstance(value, dict) else {"state": "idle"}

    def get_manual_sync_lock(self) -> threading.RLock:
        lock = getattr(self, "_manual_sync_lock", None)
        if lock is None:
            lock = threading.RLock()
            self._manual_sync_lock = lock
        return lock

    def manual_state_owns_run(
        self,
        state: dict,
        run_id: str,
        board_id: str,
    ) -> bool:
        batch = str(state.get("batch", ""))
        scoped = state.get("run_board_ids")
        return bool(
            batch
            and board_id in getattr(self, "boards", {})
            and run_id == self.manual_run_id(batch, board_id)
            and (scoped is None or isinstance(scoped, list) and board_id in scoped)
        )

    def require_active_manual_run_state(
        self,
        state: dict,
        run_id: str,
        board_id: str,
    ) -> None:
        halted_runs = state.get("summary_halted_run_ids")
        if (
            not self.manual_state_owns_run(state, run_id, board_id)
            or state.get("state") not in {"starting", "running"}
            or isinstance(halted_runs, list) and run_id in halted_runs
        ):
            raise ValueError("manual organization batch does not match")

    def manual_run_ids_for_state(self, state: dict) -> set[str]:
        batch = str(state.get("batch", ""))
        if not batch or not RUN_ID.fullmatch(batch):
            return set()
        run_ids = {
            self.manual_run_id(batch, board_id)
            for board_id in getattr(self, "boards", {})
            if self.manual_state_owns_run(
                {**state, "run_board_ids": state.get("run_board_ids")},
                self.manual_run_id(batch, board_id),
                board_id,
            )
        }
        processed = state.get("processed_run_ids")
        if isinstance(processed, list):
            run_ids.update(
                value for value in processed
                if isinstance(value, str) and RUN_ID.fullmatch(value)
            )
        plans = getattr(self, "summary_plans", {})
        run_ids.update(
            run_id for run_id in plans
            if any(
                run_id == self.manual_run_id(batch, board_id)
                for board_id in getattr(self, "boards", {})
            )
        )
        return run_ids

    def expire_manual_run(self, state: dict, error: str) -> dict:
        run_ids = self.manual_run_ids_for_state(state)
        halted_runs = state.get("summary_halted_run_ids")
        if not isinstance(halted_runs, list):
            halted_runs = []
        for run_id in sorted(run_ids):
            if run_id not in halted_runs:
                halted_runs.append(run_id)
        pending = sum(
            len(getattr(self, "summary_plans", {}).get(run_id, set()))
            for run_id in run_ids
        )
        state.update({
            "state": "failed",
            "completed_at": datetime.now().astimezone().isoformat(),
            "error": error,
            "summary_pending": 0,
            "summary_plan_pending": False,
            "summary_finalizing": False,
            "summary_halted_run_ids": halted_runs,
        })
        if pending:
            state["summary_failed"] = int(state.get("summary_failed", 0) or 0) + pending
        guard = getattr(self, "summary_locks_guard", None)
        if guard is None:
            guard = threading.Lock()
            self.summary_locks_guard = guard
        with guard:
            halted = getattr(self, "summary_halted", None)
            if halted is None:
                halted = set()
                self.summary_halted = halted
            halted.update(run_ids)
        for run_id in run_ids:
            getattr(self, "summary_plans", {}).pop(run_id, None)
        return state

    def manual_sync_status(self) -> dict:
        with self.get_manual_sync_lock():
            value = self.read_manual_sync()
            processing_active = bool(
                getattr(self, "processing_lock", None)
                and self.processing_lock.locked()
            )
            if value.get("state") == "starting":
                try:
                    started = datetime.fromisoformat(str(value.get("started_at", "")))
                    age_seconds = (datetime.now().astimezone() - started).total_seconds()
                except (TypeError, ValueError):
                    age_seconds = MANUAL_START_TIMEOUT_SECONDS + 1
                if age_seconds > MANUAL_START_TIMEOUT_SECONDS and not processing_active:
                    value = self.expire_manual_run(
                        value,
                        "Chrome 已打开，但未检测到 Tampermonkey 响应；请确认脚本已启用后重试。",
                    )
                    atomic_json(self.manual_sync_path, value)
            elif value.get("state") == "running":
                try:
                    started = datetime.fromisoformat(str(value.get("started_at", "")))
                    age_seconds = (datetime.now().astimezone() - started).total_seconds()
                except (TypeError, ValueError):
                    age_seconds = None
                if (
                    age_seconds is not None
                    and age_seconds > MANUAL_RUN_TIMEOUT_SECONDS
                    and not processing_active
                ):
                    value = self.expire_manual_run(
                        value,
                        "上一次整理未正常结束，已自动解除锁定；请重新点击一键整理。",
                    )
                    atomic_json(self.manual_sync_path, value)
        allowed = {
            "state", "started_at", "completed_at", "board_count", "processed_boards",
            "current_board", "scanned", "new", "error", "publish_status",
            "summarized", "summary_total", "summary_pending", "summary_failed",
            "summary_plan_pending", "summary_finalizing", "summary_finalize_error",
            "core_completed", "summary_halt_reason",
        }
        public = {key: value[key] for key in allowed if key in value}
        if "error" in public:
            public["error"] = sanitize_manual_sync_error(public["error"])
        if (
            public.get("state") == "failed"
            and public.get("error") == LEGACY_DIANDIAN_HALT_ERROR
        ):
            public.update({
                "core_completed": True,
                "summary_halt_reason": "transport-failed",
                "error": DIANDIAN_HALT_DIAGNOSTICS["transport-failed"],
            })
        if "summary_finalize_error" in public:
            public["summary_finalize_error"] = sanitize_error(
                public["summary_finalize_error"]
            )
        if "core_completed" in public and not isinstance(
            public["core_completed"], bool
        ):
            public.pop("core_completed")
        if "summary_halt_reason" in public:
            try:
                public["summary_halt_reason"] = normalize_diandian_halt_reason(
                    public["summary_halt_reason"]
                )
            except ValueError:
                public.pop("summary_halt_reason")
        if getattr(self, "organization_status_v2_enabled", False) and value.get("state") != "idle":
            projection = ORGANIZATION_STATE.project_legacy_manual_state(value)
            if value.get("state") == "completed":
                projection["state"] = "completed_with_warnings"
            return projection
        return public

    def open_sop_browser_page(self, url: str, *, activate: bool = True) -> dict:
        destination = validate_xiaohongshu_browser_url(url)
        endpoint = read_sop_devtools_endpoint(self.sop_port_file)
        value = loopback_devtools_json(
            endpoint,
            f"/json/new?{quote(destination, safe='')}",
            method="PUT",
        )
        target_id, _ = validate_sop_target_response(value, endpoint)
        if activate:
            loopback_devtools_action(
                endpoint,
                f"/json/activate/{quote(target_id, safe='')}",
            )
        return {"id": target_id}

    def browser_session_ready(self) -> bool:
        try:
            read_sop_devtools_endpoint(self.sop_port_file)
        except RuntimeError:
            return False
        return True

    def trigger_manual_sync(self, payload: dict | None = None) -> dict:
        if not self.trigger_lock.acquire(blocking=False):
            raise BridgeBusyError("a manual organization request is already starting")
        try:
            requested_board_ids, mode, target_note_id = self.normalize_manual_sync_request(payload)
            self.manual_sync_status()
            current = self.read_manual_sync()
            if current.get("state") in {"starting", "running"}:
                try:
                    started = datetime.fromisoformat(str(current.get("started_at", "")))
                    age_seconds = (datetime.now().astimezone() - started).total_seconds()
                except (TypeError, ValueError):
                    age_seconds = 0
                if age_seconds < MANUAL_RUN_TIMEOUT_SECONDS:
                    raise BridgeBusyError("organization is already running in Chrome")
            if self.processing_lock.locked():
                raise BridgeBusyError("organization is already processing a collection")

            batch = f"manual{datetime.now().astimezone():%Y%m%d%H%M%S%f}"
            run_board_ids = requested_board_ids or list(self.board_order)
            state = {
                "batch": batch,
                "state": "starting",
                "started_at": datetime.now().astimezone().isoformat(),
                "board_count": len(run_board_ids),
                "processed_boards": 0,
                "current_board": "正在刷新收藏夹",
                "scanned": 0,
                "new": 0,
                "summarized": 0,
                "summary_total": 0,
                "summary_pending": 0,
                "summary_failed": 0,
                "summary_plan_pending": False,
                "summary_finalizing": False,
                "processed_run_ids": [],
                "run_board_ids": run_board_ids,
                "run_mode": mode,
            }
            if requested_board_ids is not None:
                state["requested_board_ids"] = requested_board_ids
            if target_note_id is not None:
                state["target_note_id"] = target_note_id
                state["local_only"] = True
            with self.get_manual_sync_lock():
                atomic_json(self.manual_sync_path, state)
            parsed_profile = urlparse(self.profile_url)
            query = parse_qs(parsed_profile.query)
            query.update({
                "xhs_kb_sync": ["1"],
                "xhs_kb_batch": [batch],
                "xhs_kb_mode": [mode],
            })
            url = parsed_profile._replace(query=urlencode(query, doseq=True)).geturl()
            try:
                self.open_sop_browser_page(url)
            except (RuntimeError, ValueError) as error:
                state.update({
                    "state": "failed",
                    "completed_at": datetime.now().astimezone().isoformat(),
                    "error": sanitize_error(str(error)),
                })
                with self.get_manual_sync_lock():
                    current = self.read_manual_sync()
                    if current.get("batch") == batch:
                        atomic_json(self.manual_sync_path, state)
                raise RuntimeError(state["error"]) from error
            return self.manual_sync_status()
        finally:
            self.trigger_lock.release()

    def record_manual_result(self, run_id: str, board_id: str, result: dict) -> None:
        with self.get_manual_sync_lock():
            state = self.read_manual_sync()
            if not self.manual_state_owns_run(state, run_id, board_id):
                return
            if state.get("state") in MANUAL_TERMINAL_STATES:
                return
            processed = state.get("processed_run_ids")
            if not isinstance(processed, list):
                processed = []
            if run_id in processed:
                return
            processed.append(run_id)
            state["scanned"] = int(state.get("scanned", 0) or 0) + int(result.get("scanned", 0) or 0)
            state["new"] = int(state.get("new", 0) or 0) + int(result.get("new", 0) or 0)
            state["processed_run_ids"] = processed
            state["processed_boards"] = len(processed)
            summary_pending = bool(getattr(self, "summary_plans", {}).get(run_id))
            resolved_plans = state.get("summary_plan_resolved_run_ids")
            if not isinstance(resolved_plans, list):
                resolved_plans = []
            summary_plan_pending = bool(
                getattr(self, "diandian_enabled", False)
                and run_id not in resolved_plans
                and run_id not in getattr(self, "summary_plans", {})
            )
            state["summary_plan_pending"] = summary_plan_pending
            if result.get("state") == "failed":
                state.update({
                    "state": "failed",
                    "completed_at": result.get("completed_at") or datetime.now().astimezone().isoformat(),
                    "error": sanitize_error(str(result.get("error") or "organization failed")),
                    "summary_plan_pending": False,
                })
            elif result.get("state") == "safety-stopped":
                state.update({
                    "state": "safety-stopped",
                    "completed_at": result.get("completed_at") or datetime.now().astimezone().isoformat(),
                    "error": sanitize_error(str(
                        result.get("error") or "小红书触发安全限制，已停止本轮且不会继续重试"
                    )),
                    "current_board": "",
                    "summary_plan_pending": False,
                })
            elif result.get("state") == "completed" and (summary_pending or summary_plan_pending):
                state.update({
                    "state": "running",
                    "current_board": (
                        f"{self.boards[board_id]}：等待点点 AI 计划"
                        if summary_plan_pending
                        else f"{self.boards[board_id]}：点点 AI 深度整理"
                    ),
                })
            elif result.get("state") == "completed":
                self.apply_core_result_to_manual_state(state, run_id, board_id, result)
            atomic_json(self.manual_sync_path, state)

    def apply_core_result_to_manual_state(
        self,
        state: dict,
        run_id: str,
        board_id: str,
        result: dict,
    ) -> None:
        if result.get("state") != "completed":
            raise ValueError("core organization result is not completed")
        state["summary_plan_pending"] = False
        publish = result.get("publish") if isinstance(result.get("publish"), dict) else None
        if publish:
            state["publish_status"] = str(publish.get("status") or "")
        next_board_id = result.get("next_board_id")
        if next_board_id is None:
            state.update({
                "state": "completed",
                "completed_at": result.get("completed_at") or datetime.now().astimezone().isoformat(),
                "current_board": "",
            })
            return
        if not isinstance(next_board_id, str) or next_board_id not in self.boards:
            raise ValueError("core organization result has an invalid next board")
        processed = state.get("processed_run_ids")
        next_run_id = self.manual_run_id(str(state.get("batch", "")), next_board_id)
        if not isinstance(processed, list) or next_run_id not in processed:
            state.update({
                "state": "running",
                "current_board": self.boards[next_board_id],
            })
            state.pop("completed_at", None)

    def read_completed_core_result(self, run_id: str) -> dict:
        status_path = self.state_dir / "runs" / f"{run_id}.json"
        try:
            result = json.loads(status_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError("completed core organization result is unavailable") from error
        if (
            not isinstance(result, dict)
            or result.get("run_id") != run_id
            or result.get("state") != "completed"
        ):
            raise ValueError("completed core organization result is unavailable")
        return result

    def record_manual_started(self, run_id: str, board_id: str) -> None:
        with self.get_manual_sync_lock():
            state = self.read_manual_sync()
            if not self.manual_state_owns_run(state, run_id, board_id):
                raise ValueError("manual organization batch does not match")
            if state.get("state") in MANUAL_TERMINAL_STATES:
                raise ValueError("manual organization batch does not match")
            processed = state.get("processed_run_ids")
            if isinstance(processed, list) and run_id in processed:
                return
            state.update({
                "state": "running",
                "current_board": self.boards[board_id],
                "summary_plan_pending": False,
            })
            atomic_json(self.manual_sync_path, state)

    def validate_manual_board_run(self, run_id: str, board_id: str) -> None:
        with self.get_manual_sync_lock():
            state = self.read_manual_sync()
            batch = str(state.get("batch", ""))
            if (
                not RUN_ID.fullmatch(run_id)
                or board_id not in self.boards
                or not batch
                or run_id != self.manual_run_id(batch, board_id)
            ):
                raise ValueError("manual organization batch does not match")
            halted_runs = state.get("summary_halted_run_ids")
            if (
                state.get("state") not in {"starting", "running"}
                or isinstance(halted_runs, list) and run_id in halted_runs
            ):
                raise ValueError("manual organization batch does not match")
            if board_id not in self.run_board_order(batch):
                raise ValueError("board is outside this run scope")

    @staticmethod
    def require_manual_discovery_state(state: dict, batch: str) -> None:
        if not RUN_ID.fullmatch(batch) or state.get("batch") != batch:
            raise ValueError("invalid discovery batch")
        if state.get("state") not in {"starting", "running"}:
            raise ValueError("manual organization is not awaiting board discovery")

    def single_note_target_for_run(self, run_id: str, board_id: str) -> str | None:
        state = self.read_manual_sync()
        batch = str(state.get("batch", ""))
        if not batch or run_id != self.manual_run_id(batch, board_id):
            raise ValueError("manual organization batch does not match")
        if state.get("local_only") is not True and "target_note_id" not in state:
            return None
        target_note_id = state.get("target_note_id")
        if (
            state.get("local_only") is not True
            or state.get("run_mode") != "history"
            or state.get("run_board_ids") != [board_id]
            or not isinstance(target_note_id, str)
            or not NOTE_ID.fullmatch(target_note_id)
        ):
            raise ValueError("single-note run target state is invalid")
        return target_note_id

    def summary_run_lock(self, run_id: str) -> threading.RLock:
        guard = getattr(self, "summary_locks_guard", None)
        if guard is None:
            guard = threading.Lock()
            self.summary_locks_guard = guard
        with guard:
            locks = getattr(self, "summary_locks", None)
            if locks is None:
                locks = {}
                self.summary_locks = locks
            return locks.setdefault(run_id, threading.RLock())

    def summary_report_path(self) -> Path:
        path = getattr(self, "diandian_report_path", None)
        if isinstance(path, Path):
            return path
        state_dir = getattr(self, "state_dir", None)
        if isinstance(state_dir, Path):
            path = state_dir / "diandian-rerun-report.json"
        else:
            diandian_dir = getattr(self, "diandian_dir", None)
            if not isinstance(diandian_dir, Path):
                raise RuntimeError("DianDian report path is unavailable")
            path = diandian_dir.parent / "diandian-rerun-report.json"
        self.diandian_report_path = path
        return path

    def get_summary_report_lock(self) -> threading.RLock:
        lock = getattr(self, "_summary_report_lock", None)
        if lock is None:
            lock = threading.RLock()
            self._summary_report_lock = lock
        return lock

    def read_diandian_report(self) -> dict:
        path = self.summary_report_path()
        try:
            if path.stat().st_size > DIANDIAN_REPORT_MAX_BYTES:
                raise ValueError("DianDian rerun report is too large")
            value = json.loads(path.read_text(encoding="utf-8-sig"))
        except FileNotFoundError:
            value = None
        succeeded_source = value.get("succeeded_note_ids") if isinstance(value, dict) else None
        succeeded_note_ids: list[str] = []
        if isinstance(succeeded_source, list):
            for note_id in succeeded_source:
                if (
                    isinstance(note_id, str)
                    and NOTE_ID.fullmatch(note_id)
                    and note_id not in succeeded_note_ids
                ):
                    succeeded_note_ids.append(note_id)

        unresolved_source = value.get("unresolved") if isinstance(value, dict) else None
        if isinstance(unresolved_source, dict):
            unresolved_source = [
                {**entry, "note_id": note_id}
                for note_id, entry in unresolved_source.items()
                if isinstance(entry, dict)
            ]
        unresolved_by_id: dict[str, dict[str, str]] = {}
        if isinstance(unresolved_source, list):
            for entry in unresolved_source:
                if not isinstance(entry, dict):
                    continue
                note_id = entry.get("note_id")
                if not isinstance(note_id, str) or not NOTE_ID.fullmatch(note_id):
                    continue
                reason = entry.get("reason")
                if not isinstance(reason, str) or not reason.strip():
                    reason = "fallback-required"
                unresolved_by_id[note_id] = {
                    "note_id": note_id,
                    "status": "unresolved",
                    "reason": safe_diandian_fallback_reason(reason),
                }
        succeeded_note_ids = [
            note_id for note_id in succeeded_note_ids
            if note_id not in unresolved_by_id
        ]
        return {
            "version": 1,
            "updated_at": str(value.get("updated_at", "")) if isinstance(value, dict) else "",
            "succeeded_note_ids": succeeded_note_ids,
            "unresolved": list(unresolved_by_id.values()),
        }

    def unresolved_diandian_note(self, note_id: str) -> bool:
        with self.get_summary_report_lock():
            return any(
                entry.get("note_id") == note_id
                and entry.get("status") == "unresolved"
                for entry in self.read_diandian_report()["unresolved"]
            )

    def record_diandian_succeeded(self, note_id: str) -> None:
        self.record_diandian_succeeded_batch({note_id})

    def record_diandian_succeeded_batch(self, note_ids: set[str]) -> None:
        if not note_ids:
            return
        if not all(NOTE_ID.fullmatch(note_id) for note_id in note_ids):
            raise ValueError("DianDian report note_id is invalid")
        with self.get_summary_report_lock():
            report = self.read_diandian_report()
            report["unresolved"] = [
                entry for entry in report["unresolved"]
                if entry.get("note_id") not in note_ids
            ]
            succeeded = report["succeeded_note_ids"]
            succeeded.extend(
                note_id for note_id in sorted(note_ids)
                if note_id not in succeeded
            )
            report["updated_at"] = datetime.now().astimezone().isoformat()
            atomic_json(self.summary_report_path(), report)

    def record_diandian_unresolved(self, note_id: str, reason: str) -> None:
        self.record_diandian_unresolved_batch({note_id}, reason)

    def record_diandian_unresolved_batch(self, note_ids: set[str], reason: str) -> None:
        if not note_ids:
            return
        if not all(NOTE_ID.fullmatch(note_id) for note_id in note_ids):
            raise ValueError("DianDian report note_id is invalid")
        with self.get_summary_report_lock():
            report = self.read_diandian_report()
            now = datetime.now().astimezone().isoformat()
            report["updated_at"] = now
            safe_reason = safe_diandian_fallback_reason(reason)
            report["succeeded_note_ids"] = [
                note_id for note_id in report["succeeded_note_ids"]
                if note_id not in note_ids
            ]
            unresolved_by_id = {
                entry["note_id"]: entry for entry in report["unresolved"]
            }
            for note_id in sorted(note_ids):
                unresolved_by_id[note_id] = {
                    "note_id": note_id,
                    "status": "unresolved",
                    "reason": safe_reason,
                }
            report["unresolved"] = list(unresolved_by_id.values())
            atomic_json(self.summary_report_path(), report)

    def clear_diandian_unresolved(self, note_id: str) -> None:
        path = getattr(self, "diandian_report_path", None)
        if not isinstance(path, Path):
            state_dir = getattr(self, "state_dir", None)
            diandian_dir = getattr(self, "diandian_dir", None)
            if not isinstance(state_dir, Path) and not isinstance(diandian_dir, Path):
                return
        with self.get_summary_report_lock():
            report = self.read_diandian_report()
            remaining = [
                entry for entry in report["unresolved"]
                if entry.get("note_id") != note_id
            ]
            if len(remaining) == len(report["unresolved"]):
                return
            report["unresolved"] = remaining
            report["updated_at"] = datetime.now().astimezone().isoformat()
            atomic_json(self.summary_report_path(), report)

    def saved_diandian_record(self, note_id: str) -> dict | None:
        if not isinstance(note_id, str) or not NOTE_ID.fullmatch(note_id):
            return None
        path = self.diandian_dir / f"{note_id}.json"
        try:
            if path_is_reparse_point(self.diandian_dir) or path_is_reparse_point(path):
                return None
            metadata = path.stat()
            if not path.is_file() or metadata.st_size > DIANDIAN_RECORD_MAX_BYTES:
                return None
            value = json.loads(path.read_text(encoding="utf-8"))
            if not valid_diandian_record(value, note_id) or value.get("version") != 2:
                return None
            expected_content = self.trusted_content_sha256(note_id)
            expected_prompt = diandian_prompt_version(self.diandian_release, self.diandian_browser_contract)
            if not hmac.compare_digest(value["content_sha256"], expected_content):
                return None
            if not hmac.compare_digest(value["prompt_version"], expected_prompt):
                return None
            return value
        except (OSError, ValueError, TypeError, json.JSONDecodeError, RecursionError):
            return None

    def trusted_content_sha256(self, note_id: str) -> str:
        catalog = json.loads(self.catalog_path.read_text(encoding="utf-8-sig"))
        notes = catalog.get("notes") if isinstance(catalog, dict) else None
        note = notes.get(note_id) if isinstance(notes, dict) else None
        content_sha256 = note.get("content_sha256") if isinstance(note, dict) else None
        if not isinstance(content_sha256, str) or re.fullmatch(r"[a-f0-9]{64}", content_sha256) is None:
            raise ValueError("Current catalog content revision is unavailable")
        return content_sha256

    def persist_diandian_v2(self, note_id: str, title: str, summary: str) -> dict:
        if not NOTE_ID.fullmatch(note_id):
            raise ValueError("DianDian result note_id is invalid")
        if self.diandian_save_record is None:
            raise RuntimeError("DianDian summary saver is unavailable")
        self.diandian_dir.mkdir(parents=True, exist_ok=True)
        if path_is_reparse_point(self.diandian_dir):
            raise ValueError("DianDian summary root is unsafe")
        staging_parent = self.diandian_dir.parent / ".diandian-transactions"
        staging_parent.mkdir(parents=True, exist_ok=True)
        if path_is_reparse_point(staging_parent):
            raise ValueError("DianDian transaction root is unsafe")
        with tempfile.TemporaryDirectory(prefix="point-v2-", dir=staging_parent) as temporary:
            staging_root = Path(temporary) / ".xhs-favorites" / "diandian-summaries"
            staging_root.mkdir(parents=True)
            destination = staging_root / f"{note_id}.json"
            self.diandian_save_record(destination, title, summary, note_id)
            try:
                staged = json.loads(destination.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as error:
                raise RuntimeError("DianDian summary saver did not persist expected record") from error
            if not valid_diandian_record(staged, note_id) or staged.get("version") != 1:
                raise RuntimeError("DianDian summary saver did not persist expected staging record")
            cleaned_summary = staged["summary"].strip()
            complete = {
                "version": 2,
                "provider": "xiaohongshu-diandian",
                "prompt": "总结",
                "prompt_version": diandian_prompt_version(self.diandian_release, self.diandian_browser_contract),
                "note_id": note_id,
                "title": staged["title"].strip(),
                "summary": cleaned_summary,
                "content_sha256": self.trusted_content_sha256(note_id),
                "request_sha256": diandian_result_digest(title, summary),
                "summary_sha256": hashlib.sha256(cleaned_summary.encode("utf-8")).hexdigest(),
                "captured_at": datetime.now(timezone.utc).isoformat(),
            }
            if not valid_diandian_record(complete, note_id):
                raise RuntimeError("DianDian v2 record validation failed")
            destination = self.diandian_dir / f"{note_id}.json"
            atomic_json(destination, complete)
            return complete

    def update_diandian_progress(
        self,
        run_id: str,
        board_id: str,
        *,
        summarized_delta: int = 0,
        failed_delta: int = 0,
    ) -> None:
        with self.get_manual_sync_lock():
            state = self.read_manual_sync()
            self.require_active_manual_run_state(state, run_id, board_id)
            state["summarized"] = int(state.get("summarized", 0) or 0) + summarized_delta
            state["summary_failed"] = int(state.get("summary_failed", 0) or 0) + failed_delta
            state["summary_pending"] = len(self.summary_plans.get(run_id, set()))
            atomic_json(self.manual_sync_path, state)

    def finalization_is_active(self, run_id: str) -> bool:
        guard = getattr(self, "summary_locks_guard", None)
        if guard is None:
            return False
        with guard:
            return run_id in getattr(self, "summary_finalizing", set())

    def diandian_is_halted(self, run_id: str) -> bool:
        guard = getattr(self, "summary_locks_guard", None)
        if guard is not None:
            with guard:
                if run_id in getattr(self, "summary_halted", set()):
                    return True
        halted_runs = self.read_manual_sync().get("summary_halted_run_ids")
        return isinstance(halted_runs, list) and run_id in halted_runs

    def claim_diandian_publish(self, run_id: str, board_id: str) -> bool:
        """Linearize the finalizer's publish start against a halt for the same run."""
        with self.summary_run_lock(run_id):
            with self.get_manual_sync_lock():
                state = self.read_manual_sync()
                halted_runs = state.get("summary_halted_run_ids")
                if (
                    not self.manual_state_owns_run(state, run_id, board_id)
                    or state.get("state") != "running"
                    or state.get("summary_finalizing") is not True
                    or isinstance(halted_runs, list) and run_id in halted_runs
                ):
                    return False
                guard = getattr(self, "summary_locks_guard", None)
                if guard is None:
                    guard = threading.Lock()
                    self.summary_locks_guard = guard
                with guard:
                    if run_id in getattr(self, "summary_halted", set()):
                        return False
                    claimed = getattr(self, "summary_publish_claimed", None)
                    if claimed is None:
                        claimed = set()
                        self.summary_publish_claimed = claimed
                    if run_id in claimed:
                        return False
                    claimed.add(run_id)
                    return True

    def start_diandian_finalization(self, run_id: str, board_id: str) -> bool:
        with self.summary_run_lock(run_id):
            return self._start_diandian_finalization(run_id, board_id)

    def _start_diandian_finalization(self, run_id: str, board_id: str) -> bool:
        if self.summary_plans.get(run_id):
            raise BridgeBusyError("DianDian summary plan is still pending")
        if self.diandian_is_halted(run_id):
            return False
        state_dir = getattr(self, "state_dir", None)
        status_path = state_dir / "runs" / f"{run_id}.json" if isinstance(state_dir, Path) else None
        if status_path is None or not status_path.is_file():
            self.summary_plans.pop(run_id, None)
            guard = getattr(self, "summary_locks_guard", None)
            if guard is not None:
                with guard:
                    finalized = getattr(self, "summary_finalized", None)
                    if finalized is None:
                        finalized = set()
                        self.summary_finalized = finalized
                    finalized.add(run_id)
            return False

        guard = getattr(self, "summary_locks_guard", None)
        if guard is None:
            self.summary_locks_guard = threading.Lock()
            guard = self.summary_locks_guard
        with guard:
            finalizing = getattr(self, "summary_finalizing", None)
            if finalizing is None:
                finalizing = set()
                self.summary_finalizing = finalizing
            finalized = getattr(self, "summary_finalized", None)
            if finalized is None:
                finalized = set()
                self.summary_finalized = finalized
            if run_id in finalizing or run_id in finalized:
                return run_id in finalizing
            finalizing.add(run_id)

        with self.get_manual_sync_lock():
            state = self.read_manual_sync()
            try:
                self.require_active_manual_run_state(state, run_id, board_id)
            except ValueError:
                with guard:
                    finalizing.discard(run_id)
                return False
            state_snapshot = self.manual_sync_path.read_bytes() if self.manual_sync_path.exists() else None
            state.update({
                "state": "running",
                "current_board": f"{self.boards[board_id]}：正在更新点点 AI 结果",
                "summary_plan_pending": False,
                "summary_finalizing": True,
            })
            state.pop("summary_finalize_error", None)
            atomic_json(self.manual_sync_path, state)
        threads = getattr(self, "summary_finalization_threads", None)
        if threads is None:
            threads = {}
            self.summary_finalization_threads = threads
        try:
            thread = threading.Thread(
                target=self.run_diandian_finalization,
                args=(run_id, board_id),
                name="favsense-diandian-finalize",
                daemon=True,
            )
            threads[run_id] = thread
            thread.start()
        except Exception:
            threads.pop(run_id, None)
            with guard:
                finalizing.discard(run_id)
            with self.get_manual_sync_lock():
                current = self.read_manual_sync()
                if (
                    self.manual_state_owns_run(current, run_id, board_id)
                    and current.get("state") == "running"
                    and current.get("summary_finalizing") is True
                ):
                    restore_file_snapshot(self.manual_sync_path, state_snapshot)
            raise
        return True

    def complete_manual_after_diandian(
        self,
        run_id: str,
        board_id: str,
        result: dict,
        publish: dict | None,
        error: str,
    ) -> None:
        with self.summary_run_lock(run_id):
            with self.get_manual_sync_lock():
                state = self.read_manual_sync()
                if (
                    not self.manual_state_owns_run(state, run_id, board_id)
                    or self.diandian_is_halted(run_id)
                    or state.get("state") in {"failed", "safety-stopped"}
                ):
                    return
                batch = str(state.get("batch", ""))
                state["summary_finalizing"] = False
                state["summary_plan_pending"] = False
                if error:
                    state["summary_finalize_error"] = error
                else:
                    state.pop("summary_finalize_error", None)
                if result.get("state") == "completed":
                    next_board_id = str(result.get("next_board_id") or "")
                    if not next_board_id:
                        state.update({
                            "state": "completed",
                            "completed_at": result.get("completed_at") or datetime.now().astimezone().isoformat(),
                            "current_board": "",
                        })
                    else:
                        processed = state.get("processed_run_ids")
                        next_run_id = self.manual_run_id(batch, next_board_id)
                        old_board = self.boards[board_id]
                        if (
                            (not isinstance(processed, list) or next_run_id not in processed)
                            and state.get("state") != "completed"
                            and str(state.get("current_board", "")).startswith(old_board)
                        ):
                            state.update({
                                "state": "running",
                                "current_board": self.boards.get(next_board_id, "下一个收藏夹"),
                            })
                if publish:
                    state["publish_status"] = str(publish.get("status") or "")
                if not self.manual_state_owns_run(state, run_id, board_id):
                    return
                guard = getattr(self, "summary_locks_guard", None)
                if guard is None:
                    guard = threading.Lock()
                    self.summary_locks_guard = guard
                with guard:
                    halted_runs = state.get("summary_halted_run_ids")
                    if (
                        run_id in getattr(self, "summary_halted", set())
                        or isinstance(halted_runs, list) and run_id in halted_runs
                    ):
                        return
                    atomic_json(self.manual_sync_path, state)

    def run_diandian_finalization(self, run_id: str, board_id: str) -> None:
        result: dict = {}
        publish = None
        error_message = ""
        try:
            with self.processing_lock:
                if self.diandian_is_halted(run_id):
                    return
                status_path = self.state_dir / "runs" / f"{run_id}.json"
                result = json.loads(status_path.read_text(encoding="utf-8-sig"))
                if self.diandian_is_halted(run_id):
                    return
                self.rebuild_knowledge_base()
                if self.diandian_is_halted(run_id):
                    return
                publish = self.publish_after_board(
                    board_id,
                    run_id,
                    require_finalization_claim=True,
                )
                if publish is not None:
                    result["publish"] = publish
                    self.write_status(result)
                if not self.diandian_is_halted(run_id):
                    self.complete_manual_after_diandian(run_id, board_id, result, publish, "")
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
            error_message = sanitize_error(str(error))
            self.complete_manual_after_diandian(run_id, board_id, result, None, error_message)
        finally:
            with self.summary_run_lock(run_id):
                self.summary_plans.pop(run_id, None)
                guard = self.summary_locks_guard
                with guard:
                    self.summary_finalizing.discard(run_id)
                    self.summary_finalized.add(run_id)

    def diandian_completion_state(self, run_id: str, board_id: str) -> dict:
        plan_complete = not self.summary_plans.get(run_id)
        active = False
        if plan_complete:
            active = self.start_diandian_finalization(run_id, board_id)
        return {
            "plan_complete": plan_complete,
            "finalization_started": active,
        }

    @staticmethod
    def append_unique_state_value(state: dict, key: str, value: str) -> bool:
        values = state.get(key)
        if not isinstance(values, list):
            values = []
        if value in values:
            state[key] = values
            return False
        values.append(value)
        state[key] = values
        return True

    def complete_empty_diandian_plan(
        self,
        run_id: str,
        board_id: str,
        *,
        abandoned: bool,
        enabled: bool,
    ) -> dict:
        state = self.read_manual_sync()
        pending = set(self.summary_plans.get(run_id, set())) if abandoned else set()
        already_abandoned = not self.append_unique_state_value(
            state, "summary_plan_abandoned_run_ids", run_id
        ) if abandoned else False
        if abandoned and pending and not already_abandoned:
            self.record_diandian_unresolved_batch(pending, "summary-plan-abandoned")
            state["summary_failed"] = (
                int(state.get("summary_failed", 0) or 0) + len(pending)
            )
        self.append_unique_state_value(state, "summary_plan_resolved_run_ids", run_id)
        state.update({
            "summary_plan_pending": False,
            "summary_pending": 0,
            "summary_finalizing": False,
        })
        must_restore_core = abandoned or state.get("state") == "completed"
        if must_restore_core or getattr(self, "state_dir", None) is not None:
            try:
                result = self.read_completed_core_result(run_id)
            except ValueError:
                if must_restore_core:
                    raise
            else:
                self.apply_core_result_to_manual_state(state, run_id, board_id, result)
        atomic_json(self.manual_sync_path, state)
        self.summary_plans.pop(run_id, None)
        response = {"enabled": enabled, "note_ids": []}
        if abandoned:
            response["abandoned"] = True
        return response

    def diandian_summary_plan(self, payload: dict) -> dict:
        if set(payload) != {"run_id", "board_id", "note_ids"}:
            raise ValueError("DianDian plan contains unsupported fields")
        run_id = payload.get("run_id")
        board_id = payload.get("board_id")
        note_ids = payload.get("note_ids")
        if not isinstance(run_id, str) or not isinstance(board_id, str):
            raise ValueError("DianDian plan run_id and board_id must be strings")
        if (
            not isinstance(note_ids, list)
            or len(note_ids) > 200
            or not all(isinstance(value, str) and NOTE_ID.fullmatch(value) for value in note_ids)
            or len(set(note_ids)) != len(note_ids)
        ):
            raise ValueError("note_ids must contain unique supported note identifiers")
        with self.summary_run_lock(run_id):
            with self.get_manual_sync_lock():
                state = self.read_manual_sync()
                abandoned_runs = state.get("summary_plan_abandoned_run_ids")
                if (
                    self.manual_state_owns_run(state, run_id, board_id)
                    and isinstance(abandoned_runs, list)
                    and run_id in abandoned_runs
                ):
                    self.summary_plans.pop(run_id, None)
                    return {
                        "enabled": False,
                        "note_ids": [],
                        "abandoned": True,
                    }
                self.validate_manual_board_run(run_id, board_id)
                state = self.read_manual_sync()
                if not self.manual_state_owns_run(state, run_id, board_id):
                    raise ValueError("manual organization batch does not match")
                target_note_id = self.single_note_target_for_run(run_id, board_id)
                if target_note_id is not None and note_ids and set(note_ids) != {target_note_id}:
                    raise ValueError("single-note summary plan must contain exactly the run target")
                if self.diandian_is_halted(run_id):
                    return {"enabled": False, "note_ids": []}
                if not note_ids:
                    return self.complete_empty_diandian_plan(
                        run_id, board_id, abandoned=True, enabled=False
                    )
                if run_id in self.summary_plans:
                    current = self.summary_plans[run_id]
                    return {
                        "enabled": self.diandian_enabled,
                        "note_ids": [note_id for note_id in note_ids if note_id in current],
                    }
                if not self.diandian_enabled:
                    self.summary_plans[run_id] = set()
                    if state.get("summary_plan_pending") is True:
                        return self.complete_empty_diandian_plan(
                            run_id, board_id, abandoned=False, enabled=False
                        )
                    return {"enabled": False, "note_ids": []}

                if target_note_id is not None:
                    planned = [target_note_id]
                    already_saved: set[str] = set()
                else:
                    planned = [
                        note_id for note_id in note_ids
                        if self.saved_diandian_record(note_id) is None
                    ]
                    already_saved = set(note_ids) - set(planned)
                self.record_diandian_succeeded_batch(already_saved)
                state = self.read_manual_sync()
                if not self.manual_state_owns_run(state, run_id, board_id):
                    raise ValueError("manual organization batch does not match")
                state["summary_total"] = int(state.get("summary_total", 0) or 0) + len(planned)
                state["summary_pending"] = len(planned)
                state["summary_plan_pending"] = False
                state["summary_finalizing"] = False
                state.pop("summary_finalize_error", None)
                self.append_unique_state_value(
                    state, "summary_plan_resolved_run_ids", run_id
                )
                if planned:
                    state.update({
                        "state": "running",
                        "current_board": f"{self.boards[board_id]}：点点 AI 深度整理",
                    })
                    state.pop("completed_at", None)
                else:
                    return self.complete_empty_diandian_plan(
                        run_id, board_id, abandoned=False, enabled=True
                    )
                atomic_json(self.manual_sync_path, state)
                self.summary_plans[run_id] = set(planned)
                return {"enabled": True, "note_ids": planned}

    def open_cdp_target(self, initial_url: str = "about:blank") -> CDPTarget:
        return open_sop_cdp_target(self.sop_port_file, initial_url)

    def revoke_diandian_cdp_inputs(self, run_id: str) -> None:
        guard = getattr(self, "diandian_cdp_guard", None)
        if guard is None:
            guard = threading.Lock()
            self.diandian_cdp_guard = guard
        with guard:
            run_controls = getattr(self, "diandian_cdp_run_cancellations", None)
            if run_controls is None:
                run_controls = {}
                self.diandian_cdp_run_cancellations = run_controls
            control = run_controls.get(run_id)
            if control is None:
                control = (threading.Lock(), threading.Event())
                run_controls[run_id] = control
            input_gate, cancelled = control
            with input_gate:
                cancelled.set()

    def halt_diandian_cdp_run(
        self,
        run_id: str,
        board_id: str,
        *,
        reason: str,
        safety: bool,
    ) -> dict:
        if not safety:
            reason = normalize_diandian_halt_reason(reason)
        self.revoke_diandian_cdp_inputs(run_id)
        guard = getattr(self, "summary_locks_guard", None)
        if guard is None:
            guard = threading.Lock()
            self.summary_locks_guard = guard
        with self.summary_run_lock(run_id):
            with self.get_manual_sync_lock():
                state = self.read_manual_sync()
                owns_run = self.manual_state_owns_run(state, run_id, board_id)
                effective_safety = safety or (
                    owns_run and state.get("state") == "safety-stopped"
                )
                halted_runs = state.get("summary_halted_run_ids")
                if not isinstance(halted_runs, list):
                    halted_runs = []
                already_halted = run_id in halted_runs
                if not owns_run or state.get("state") not in {
                    "starting", "running", "completed", "safety-stopped",
                }:
                    self.summary_plans.pop(run_id, None)
                    return {
                        "saved": False,
                        "halted": True,
                        "reason": DIANDIAN_SAFETY_STOP_REASON if effective_safety else reason,
                    }
                if already_halted:
                    with guard:
                        getattr(self, "summary_halted", set()).add(run_id)
                    if effective_safety and state.get("core_completed") is not True:
                        state["core_completed"] = True
                        atomic_json(self.manual_sync_path, state)
                    self.summary_plans.pop(run_id, None)
                    return {
                        "saved": False,
                        "halted": True,
                        "reason": (
                            DIANDIAN_SAFETY_STOP_REASON
                            if effective_safety
                            else state.get("summary_halt_reason", reason)
                        ),
                    }
                pending = set(self.summary_plans.get(run_id, set()))
                report_reason = "safety-halt" if effective_safety else reason
                self.record_diandian_unresolved_batch(pending, report_reason)
                if run_id not in halted_runs:
                    halted_runs.append(run_id)
                    state["summary_failed"] = (
                        int(state.get("summary_failed", 0) or 0) + len(pending)
                    )
                state.update({
                    "state": "safety-stopped" if effective_safety else "failed",
                    "completed_at": datetime.now().astimezone().isoformat(),
                    "current_board": "",
                    "summary_pending": 0,
                    "summary_plan_pending": False,
                    "summary_finalizing": False,
                    "summary_halted_run_ids": halted_runs,
                    "core_completed": True,
                    "error": (
                        "Xiaohongshu safety stop detected; core import was preserved."
                        if effective_safety
                        else DIANDIAN_HALT_DIAGNOSTICS[reason]
                    ),
                })
                if not effective_safety:
                    state["summary_halt_reason"] = reason
                with guard:
                    halted = getattr(self, "summary_halted", None)
                    if halted is None:
                        halted = set()
                        self.summary_halted = halted
                    halted.add(run_id)
                    atomic_json(self.manual_sync_path, state)
                self.summary_plans.pop(run_id, None)
                return {
                    "saved": False,
                    "halted": True,
                    "reason": DIANDIAN_SAFETY_STOP_REASON if effective_safety else reason,
                }

    def run_diandian_cdp(self, payload: dict) -> dict:
        if set(payload) != {"run_id", "board_id", "note_id", "title", "url"}:
            raise ValueError("DianDian CDP request contains unsupported fields")
        run_id = payload.get("run_id")
        board_id = payload.get("board_id")
        note_id = payload.get("note_id")
        title = payload.get("title")
        signed_url = payload.get("url")
        if not all(
            isinstance(value, str)
            for value in (run_id, board_id, note_id, title, signed_url)
        ):
            raise ValueError("DianDian CDP request fields must be strings")
        if not NOTE_ID.fullmatch(note_id):
            raise ValueError("DianDian CDP request note_id is invalid")
        if not title.strip() or len(title.strip()) > 200:
            raise ValueError("DianDian CDP request title is invalid")
        canonical_url = canonical_signed_note_url(signed_url, note_id)
        if not getattr(self, "diandian_cdp_enabled", False) or not callable(
            getattr(self, "diandian_cdp_ask", None)
        ):
            raise ValueError("DianDian CDP summarization is unavailable")
        key = (run_id, note_id)
        guard = getattr(self, "diandian_cdp_guard", None)
        if guard is None:
            guard = threading.Lock()
            self.diandian_cdp_guard = guard
        with guard:
            completed = getattr(self, "diandian_cdp_results", None)
            if completed is None:
                completed = {}
                self.diandian_cdp_results = completed
            if key in completed:
                return dict(completed[key])
        try:
            self.validate_manual_board_run(run_id, board_id)
        except ValueError:
            with guard:
                if key in completed:
                    return dict(completed[key])
            raise
        target_note_id = self.single_note_target_for_run(run_id, board_id)
        if target_note_id is not None and target_note_id != note_id:
            raise ValueError("DianDian CDP request does not match the run target")

        with guard:
            if key in completed:
                return dict(completed[key])
            active = getattr(self, "diandian_cdp_active", None)
            if active is None:
                active = set()
                self.diandian_cdp_active = active
            if key in active:
                raise BridgeBusyError("DianDian CDP request is already running")
            run_cancellations = getattr(self, "diandian_cdp_run_cancellations", None)
            if run_cancellations is None:
                run_cancellations = {}
                self.diandian_cdp_run_cancellations = run_cancellations
            control = run_cancellations.get(run_id)
            if control is None:
                control = (threading.Lock(), threading.Event())
                run_cancellations[run_id] = control
            transport_input_gate, transport_cancelled = control
            cancellations = getattr(self, "diandian_cdp_cancellations", None)
            if cancellations is None:
                cancellations = {}
                self.diandian_cdp_cancellations = cancellations
            cancellations[key] = control
            active.add(key)

        target = None
        saved_committed = False
        note_started = time.monotonic()
        cancellation_registered = True

        def ensure_run_active() -> None:
            if self.diandian_is_halted(run_id):
                raise DiandianPageStop("run-halted")

        try:
            with self.summary_run_lock(run_id):
                if self.diandian_is_halted(run_id):
                    result = {"saved": False, "halted": True, "reason": "run-halted"}
                    with guard:
                        completed[key] = result
                    return dict(result)
                pending = self.summary_plans.get(run_id)
                if pending is None or note_id not in pending:
                    raise ValueError("note_id was not planned for DianDian summarization")

            target = self.open_cdp_target("about:blank")
            session = target.session
            spec = getattr(self, "diandian_cdp_spec", None)
            if not isinstance(spec, dict):
                raise RuntimeError("DianDian CDP browser contract is unavailable")
            ai_url = str(spec.get("ai_chat_url", ""))
            state_expression = ai_page_state_expression(spec)
            ensure_run_active()
            session.call("Page.navigate", url=ai_url)
            timings = spec.get("timings_ms")
            if not isinstance(timings, dict):
                raise RuntimeError("DianDian CDP browser timings are unavailable")
            single_note_wait = int(timings.get("single_note_wait", 480_000)) / 1000
            deadline = note_started + single_note_wait
            sleep = getattr(self, "diandian_sleep", time.sleep)
            ready_state = None
            ready_tries = max(1, min(120, int(timings.get("input_wait", 30_000)) // 500))
            for attempt in range(ready_tries):
                ensure_run_active()
                ready_state = read_ai_page_state(session, state_expression)
                validate_ai_page_state(ready_state, ai_url)
                if ready_state["ready"] == "complete" and ready_state["input_ready"]:
                    break
                if attempt + 1 < ready_tries:
                    sleep(0.5)
            if (
                ready_state is None
                or ready_state["ready"] != "complete"
                or not ready_state["input_ready"]
            ):
                raise DiandianPageStop("page-not-ready")
            if (
                ready_state["cards"] != 0
                or ready_state["msgs"] != 0
                or ready_state["fin"] != 0
                or ready_state["last"]
            ):
                raise DiandianPageStop("stale-target")
            ensure_run_active()
            sleep(int(timings.get("page_dom_stable", 1_500)) / 1000)
            ensure_run_active()
            stable_empty_state = read_ai_page_state(session, state_expression)
            validate_ai_page_state(stable_empty_state, ai_url)
            if (
                not stable_empty_state["input_ready"]
                or stable_empty_state["ready"] != "complete"
                or stable_empty_state["cards"] != 0
                or stable_empty_state["msgs"] != 0
                or stable_empty_state["fin"] != 0
                or stable_empty_state["last"]
            ):
                raise DiandianPageStop("stale-target")

            guarded = GuardedDiandianSession(
                session,
                canonical_url,
                str(spec["prompt"]),
                ai_url,
                state_expression,
                lambda: (
                    transport_cancelled.is_set()
                    or time.monotonic() >= deadline
                    or self.diandian_is_halted(run_id)
                ),
                context_wait_seconds=int(timings.get("context_wait", 30_000)) / 1000,
                context_stable_seconds=int(timings.get("note_context_stable", 2_000)) / 1000,
                context_sleep=sleep,
                input_gate=transport_input_gate,
            )
            response_wait = int(timings.get("response_wait", 180_000))
            tries = max(1, min(200, (response_wait + 2_999) // 3_000))
            transport_done = threading.Event()
            transport_result: dict[str, object] = {}

            def invoke_transport() -> None:
                try:
                    transport_result["summary"] = self.diandian_cdp_ask(
                        guarded,
                        canonical_url,
                        spec=spec,
                        tries=tries,
                        sleep=sleep,
                    )
                except Exception as error:
                    transport_result["error"] = error
                finally:
                    transport_done.set()

            if time.monotonic() >= deadline:
                with transport_input_gate:
                    transport_cancelled.set()
                raise DiandianPageStop("single-note-timeout")
            transport_thread = threading.Thread(
                target=invoke_transport,
                name="favsense-diandian-transport",
                daemon=True,
            )
            transport_thread.start()
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not transport_done.wait(remaining):
                with transport_input_gate:
                    transport_cancelled.set()
                raise DiandianPageStop("single-note-timeout")
            transport_error = transport_result.get("error")
            if isinstance(transport_error, DiandianPageStop):
                raise transport_error
            if isinstance(transport_error, Exception):
                raise RuntimeError("DianDian CDP transport failed") from transport_error
            summary = transport_result.get("summary")
            if not isinstance(summary, str):
                raise DiandianPageStop("invalid-summary")
            summary = guarded.verify_new_reply(
                summary,
                sleep,
                int(timings.get("reply_text_stable", 2_000)) / 1000,
            )
            minimum = int(spec.get("minimum_summary_chars", 20))
            if not minimum <= len(summary) <= 100_000:
                raise DiandianPageStop("invalid-summary")
            before_save = read_ai_page_state(session, state_expression)
            if self.diandian_is_halted(run_id):
                raise DiandianPageStop("run-halted")
            validate_ai_page_state(before_save, ai_url)
            if before_save["last"].strip() != summary:
                raise DiandianPageStop("unstable-reply")

            saved = self.save_diandian_result({
                "run_id": run_id,
                "board_id": board_id,
                "note_id": note_id,
                "title": title,
                "summary": summary,
            }, defer_finalization=True)
            saved_committed = saved["saved"] is True
            sleep(int(timings.get("success_dwell", 1_500)) / 1000)
            if self.diandian_is_halted(run_id):
                raise DiandianPageStop("run-halted")
            final_state = read_ai_page_state(session, state_expression)
            validate_ai_page_state(final_state, ai_url)
            if final_state["last"].strip() != summary:
                raise DiandianPageStop("unstable-reply")
            target.close()
            completion = self.diandian_completion_state(run_id, board_id)
            result = {"saved": saved["saved"], **completion, "halted": False}
            with guard:
                completed[key] = result
            return dict(result)
        except DiandianPageStop as error:
            result = self.halt_diandian_cdp_run(
                run_id,
                board_id,
                reason=error.reason,
                safety=error.safety,
            )
            if saved_committed:
                result["saved"] = True
            with guard:
                completed[key] = result
            return dict(result)
        except (OSError, RuntimeError, TimeoutError, KeyError, json.JSONDecodeError):
            result = self.halt_diandian_cdp_run(
                run_id,
                board_id,
                reason="transport-failed",
                safety=False,
            )
            if saved_committed:
                result["saved"] = True
            with guard:
                completed[key] = result
            return dict(result)
        except ValueError:
            if target is None:
                raise
            result = self.halt_diandian_cdp_run(
                run_id,
                board_id,
                reason="invalid-summary",
                safety=False,
            )
            if saved_committed:
                result["saved"] = True
            with guard:
                completed[key] = result
            return dict(result)
        except Exception:
            if target is None:
                raise
            result = self.halt_diandian_cdp_run(
                run_id,
                board_id,
                reason="transport-failed",
                safety=False,
            )
            if saved_committed:
                result["saved"] = True
            with guard:
                completed[key] = result
            return dict(result)
        finally:
            with guard:
                getattr(self, "diandian_cdp_active", set()).discard(key)
                if cancellation_registered:
                    getattr(self, "diandian_cdp_cancellations", {}).pop(key, None)

    def save_diandian_result(
        self,
        payload: dict,
        *,
        defer_finalization: bool = False,
    ) -> dict:
        if set(payload) != {"run_id", "board_id", "note_id", "title", "summary"}:
            raise ValueError("DianDian result contains unsupported source fields")
        run_id = payload.get("run_id")
        board_id = payload.get("board_id")
        note_id = payload.get("note_id")
        title_value = payload.get("title")
        summary_value = payload.get("summary")
        if not all(isinstance(value, str) for value in (run_id, board_id, note_id, title_value, summary_value)):
            raise ValueError("DianDian result fields must be strings")
        if not NOTE_ID.fullmatch(note_id):
            raise ValueError("DianDian result note_id is invalid")
        self.validate_manual_board_run(run_id, board_id)
        title = title_value.strip()
        summary = summary_value.strip()
        if not title or len(title) > 200:
            raise ValueError("DianDian result title is empty or too long")
        if not 20 <= len(summary) <= 100_000:
            raise ValueError("DianDian result summary is empty or too long")
        if contains_diandian_credential_shape({"title": title, "summary": summary}):
            raise ValueError("DianDian result contains private source data")
        with self.summary_run_lock(run_id):
            with self.get_manual_sync_lock():
                state = self.read_manual_sync()
                self.require_active_manual_run_state(state, run_id, board_id)
                pending = self.summary_plans.get(run_id)
                if pending is None or note_id not in pending:
                    saved = self.saved_diandian_record(note_id)
                    expected_digest = diandian_result_digest(title, summary)
                    saved_digest = saved.get("request_sha256") if saved is not None else None
                    if saved is not None and (
                        (
                            isinstance(saved_digest, str)
                            and hmac.compare_digest(saved_digest, expected_digest)
                        )
                        or (
                            saved.get("title") == title
                            and saved.get("summary") == summary
                        )
                    ):
                        self.record_diandian_succeeded(note_id)
                        completion = (
                            {"plan_complete": not self.summary_plans.get(run_id), "finalization_started": False}
                            if defer_finalization
                            else self.diandian_completion_state(run_id, board_id)
                        )
                        return {"saved": True, **completion}
                    raise ValueError("note_id was not planned for DianDian summarization")
                self.persist_diandian_v2(note_id, title, summary)
                saved = self.saved_diandian_record(note_id)
                expected_digest = diandian_result_digest(title, summary)
                saved_digest = saved.get("request_sha256") if saved is not None else None
                if (
                    saved is None
                    or saved.get("title") != title
                    or not isinstance(saved_digest, str)
                    or not hmac.compare_digest(saved_digest, expected_digest)
                ):
                    raise RuntimeError("DianDian summary saver did not persist expected record")
                self.record_diandian_succeeded(note_id)
                pending.remove(note_id)
                try:
                    self.update_diandian_progress(
                        run_id,
                        board_id,
                        summarized_delta=1,
                    )
                except OSError:
                    pending.add(note_id)
                    raise
                completion = (
                    {"plan_complete": not self.summary_plans.get(run_id), "finalization_started": False}
                    if defer_finalization
                    else self.diandian_completion_state(run_id, board_id)
                )
                return {"saved": True, **completion}

    def skip_diandian_result(self, payload: dict) -> dict:
        if set(payload) != {"run_id", "board_id", "note_id", "reason"}:
            raise ValueError("DianDian skip must contain run_id, board_id, note_id and reason")
        run_id = payload.get("run_id")
        board_id = payload.get("board_id")
        note_id = payload.get("note_id")
        reason = payload.get("reason")
        if not all(isinstance(value, str) for value in (run_id, board_id, note_id, reason)):
            raise ValueError("DianDian skip fields must be strings")
        if not NOTE_ID.fullmatch(note_id):
            raise ValueError("DianDian skip note_id is invalid")
        self.validate_manual_board_run(run_id, board_id)
        safe_reason = safe_diandian_fallback_reason(reason)
        if safe_reason == DIANDIAN_SAFETY_STOP_REASON:
            raise ValueError("DianDian safety stops must use the halt endpoint")
        with self.summary_run_lock(run_id):
            with self.get_manual_sync_lock():
                state = self.read_manual_sync()
                self.require_active_manual_run_state(state, run_id, board_id)
                pending = self.summary_plans.get(run_id)
                if pending is None or note_id not in pending:
                    if self.unresolved_diandian_note(note_id):
                        return {"skipped": True, **self.diandian_completion_state(run_id, board_id)}
                    if self.saved_diandian_record(note_id) is not None:
                        return {"skipped": False, "saved": True, **self.diandian_completion_state(run_id, board_id)}
                    raise ValueError("note_id was not planned for DianDian summarization")
                self.record_diandian_unresolved(note_id, safe_reason)
                pending.remove(note_id)
                try:
                    self.update_diandian_progress(run_id, board_id, failed_delta=1)
                except OSError:
                    pending.add(note_id)
                    raise
                return {"skipped": True, **self.diandian_completion_state(run_id, board_id)}

    def halt_diandian_run(self, payload: dict) -> dict:
        if set(payload) != {"run_id", "board_id", "reason"}:
            raise ValueError("DianDian halt must contain run_id, board_id and reason")
        run_id = payload.get("run_id")
        board_id = payload.get("board_id")
        reason = payload.get("reason")
        if not all(isinstance(value, str) for value in (run_id, board_id, reason)):
            raise ValueError("DianDian halt fields must be strings")
        safety = reason == DIANDIAN_SAFETY_STOP_REASON
        if not safety:
            reason = normalize_diandian_halt_reason(reason)
        with self.get_manual_sync_lock():
            state = self.read_manual_sync()
            halted_runs = state.get("summary_halted_run_ids")
            already_halted = bool(
                self.manual_state_owns_run(state, run_id, board_id)
                and state.get("state") in MANUAL_TERMINAL_STATES
                and isinstance(halted_runs, list)
                and run_id in halted_runs
            )
        if not already_halted:
            self.validate_manual_board_run(run_id, board_id)
        if not safety:
            return self.halt_diandian_cdp_run(
                run_id,
                board_id,
                reason=reason,
                safety=False,
            )
        self.halt_diandian_cdp_run(
            run_id,
            board_id,
            reason=DIANDIAN_SAFETY_STOP_REASON,
            safety=True,
        )
        return {
            "halted": True,
            "reason": DIANDIAN_SAFETY_STOP_REASON,
            "plan_complete": True,
            "finalization_started": False,
        }

    def finish_diandian_plan(self, run_id: str, board_id: str) -> dict:
        with self.summary_run_lock(run_id):
            return self.diandian_completion_state(run_id, board_id)

    def open_original_note(self, note_id: str) -> dict:
        if not NOTE_ID.fullmatch(note_id):
            raise ValueError("invalid note_id")
        if not self.catalog_path.is_file():
            raise ValueError("catalog is unavailable")
        catalog = json.loads(self.catalog_path.read_text(encoding="utf-8-sig"))
        note = catalog.get("notes", {}).get(note_id)
        if not isinstance(note, dict):
            raise ValueError("unknown note_id")
        source_ids = note.get("source_board_ids")
        if not isinstance(source_ids, list):
            raise ValueError("note has no source board")
        available_ids = {
            item.get("id") for item in self.all_boards
            if isinstance(item, dict) and item.get("available") is not False
        }
        board_id = next((value for value in source_ids if value in available_ids), None)
        if board_id is None or not BOARD_ID.fullmatch(str(board_id)):
            raise ValueError("note source board is unavailable")

        query = urlencode({"source": "web_user_page", "xhs_kb_open_note": note_id})
        self.open_sop_browser_page(
            f"https://www.xiaohongshu.com/board/{board_id}?{query}"
        )
        return {"status": "opened"}

    def record_manual_failure(self, payload: dict) -> dict:
        run_id = str(payload.get("run_id", ""))
        board_id = str(payload.get("board_id", ""))
        if (
            getattr(self, "processing_lock", None)
            and self.processing_lock.locked()
        ):
            return self.manual_sync_status()
        with self.get_manual_sync_lock():
            state = self.read_manual_sync()
            batch = str(state.get("batch", ""))
            if not RUN_ID.fullmatch(run_id) or not batch:
                raise ValueError("manual organization batch does not match")
            if board_id:
                if (
                    board_id not in self.boards
                    or run_id != self.manual_run_id(batch, board_id)
                ):
                    raise ValueError("manual organization batch does not match")
                if board_id not in self.run_board_order(batch):
                    raise ValueError("board is outside this run scope")
            elif run_id != batch:
                raise ValueError("manual organization batch does not match")
            processed = state.get("processed_run_ids")
            if (
                state.get("state") in MANUAL_TERMINAL_STATES
                or isinstance(processed, list) and run_id in processed
            ):
                return self.manual_sync_status()
            if not board_id and state.get("state") not in {"starting", "running"}:
                raise ValueError("manual organization batch does not match")
            reported_error = normalize_sensitive_scan(
                payload.get("error") or "Chrome could not finish the collection"
            )
            safety_stopped = reported_error == DIANDIAN_SAFETY_STOP_REASON
            state.update({
                "state": "safety-stopped" if safety_stopped else "failed",
                "completed_at": datetime.now().astimezone().isoformat(),
                "error": (
                    "小红书页面触发安全限制；本轮已停止且不会继续重试。"
                    if safety_stopped
                    else sanitize_manual_sync_error(reported_error)
                ),
                "summary_plan_pending": False,
            })
            remaining = getattr(self, "summary_plans", {}).pop(run_id, set())
            if remaining:
                state["summary_failed"] = int(state.get("summary_failed", 0) or 0) + len(remaining)
                state["summary_pending"] = 0
            atomic_json(self.manual_sync_path, state)
        return self.manual_sync_status()

    def cache_missing_media(self, unique: dict[str, str]) -> dict:
        if not self.video_analysis_enabled:
            return {
                "queued": 0,
                "downloaded": 0,
                "safety_stopped": False,
                "state": "disabled",
            }
        safety_stop = self.state_dir / "media-download-safety-stop.json"
        if safety_stop.exists():
            return {
                "queued": 0,
                "downloaded": 0,
                "safety_stopped": True,
                "state": "safety-stopped",
            }
        curation = json.loads(self.curation.read_text(encoding="utf-8-sig"))
        curated_ids = set(curation) if isinstance(curation, dict) else set()
        urls = media_urls_to_cache(unique, curated_ids, self.media_dir)
        if not urls:
            return {"queued": 0, "downloaded": 0, "safety_stopped": False}
        report = self.run_dir / f"media-{datetime.now().astimezone():%Y%m%d-%H%M%S-%f}.json"
        try:
            completed = run_bounded_subprocess(
                [
                    str(self.python), "-X", "utf8", str(self.media_fetcher),
                    "--signed-urls-stdin",
                    "--xhs-dir", str(self.xhs_dir),
                    "--media-dir", str(self.media_dir),
                    "--report", str(report),
                    "--lock-file", str(self.state_dir / "platform-request.lock"),
                    "--safety-stop-file", str(safety_stop),
                    "--max-items", str(len(urls)),
                    "--delay", "3",
                ],
                input_text="\n".join(urls),
                cwd=self.workspace,
                env={**os.environ, "PYTHONUTF8": "1"},
                timeout=max(60, len(urls) * 30),
                stdout_limit=64 * 1024,
                stderr_limit=64 * 1024,
            )
        except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
            raise RuntimeError("media downloader could not complete safely") from error
        try:
            outcome = json.loads(completed.stdout.strip())
        except json.JSONDecodeError as error:
            raise RuntimeError("media downloader returned an invalid result") from error
        if not isinstance(outcome, dict):
            raise RuntimeError("media downloader returned an invalid result")
        if outcome.get("state") == "busy":
            raise RuntimeError("another platform request worker is already active")
        safety_stopped = safety_stop.exists() or outcome.get("safety_stopped") is True
        if completed.returncode not in ({2} if safety_stopped else {0}):
            raise RuntimeError("media downloader failed")
        downloaded = outcome.get("downloaded", 0)
        if not isinstance(downloaded, int) or isinstance(downloaded, bool) or downloaded < 0:
            raise RuntimeError("media downloader returned an invalid result")
        return {
            "queued": len(urls),
            "downloaded": downloaded,
            "safety_stopped": safety_stopped,
            "state": "safety-stopped" if safety_stopped else "completed",
        }

    def refresh_boards(self, config: dict) -> None:
        all_boards, enabled_boards = self.normalize_boards(config)
        self.all_boards = all_boards
        self.boards = enabled_boards
        self.board_order = list(enabled_boards)

    @staticmethod
    def normalize_boards(config: dict) -> tuple[list[dict], dict[str, str]]:
        configured_boards = config.get("boards") if isinstance(config, dict) else None
        if config.get("version") != 1 or not isinstance(configured_boards, list):
            raise ValueError("config must use version 1 and contain a boards list")
        all_boards = []
        enabled_boards = {}
        for board in configured_boards:
            board_id = str(board.get("id", "")) if isinstance(board, dict) else ""
            name = str(board.get("name", "")).strip() if isinstance(board, dict) else ""
            if not BOARD_ID.fullmatch(board_id) or not name:
                raise ValueError("board entries require a valid id and name")
            normalized = {
                "id": board_id,
                "name": name,
                "enabled": board.get("enabled") is True,
                "available": board.get("available") is not False,
                "advertised_count": max(0, int(board.get("advertised_count", 0) or 0)),
            }
            all_boards.append(normalized)
            if normalized["enabled"] and normalized["available"]:
                enabled_boards[board_id] = name
        return all_boards, enabled_boards

    def board_settings(self) -> list[dict]:
        captured = {}
        try:
            if self.catalog_path.exists():
                catalog = json.loads(self.catalog_path.read_text(encoding="utf-8-sig"))
                for note in catalog.get("notes", {}).values():
                    for board_id in note.get("source_board_ids", []) if isinstance(note, dict) else []:
                        captured[board_id] = captured.get(board_id, 0) + 1
        except (OSError, json.JSONDecodeError, ValueError, AttributeError):
            # Counts are informative. A damaged or temporarily unavailable catalog must not
            # turn a successfully committed board setting into an apparent failure.
            captured = {}
        return [
            {**board, "captured_count": captured.get(board["id"], 0)}
            for board in self.all_boards
        ]

    def userscript_content(self, all_boards: list[dict] | None = None) -> str:
        source_boards = self.all_boards if all_boards is None else all_boards
        diandian_contract = getattr(self, "diandian_browser_contract", {"enabled": False})
        board_map = {
            board["id"]: {"name": board["name"], "count": board["advertised_count"]}
            for board in source_boards if board["enabled"]
        }
        template = self.userscript_template.read_text(encoding="utf-8")
        install_version = getattr(self, "userscript_install_version", "")
        if install_version:
            template, version_count = re.subn(
                r"(?m)^// @version\s+[0-9]+(?:\.[0-9]+){2,}\s*$",
                f"// @version      {install_version}",
                template,
                count=1,
            )
            if version_count != 1:
                raise ValueError("userscript template must contain one numeric @version")
        userscript = (
            template.replace(
                "__DIANDIAN_MATCH_LINE__",
                (
                    f"// @match        {diandian_contract['ai_chat_url']}*"
                    if (
                        diandian_contract.get("enabled") is True
                        and diandian_contract.get("cdp_enabled") is not True
                    )
                    else ""
                ),
            )
            .replace("__PORT__", str(self.port))
            .replace("__TOKEN__", self.token)
            .replace("__INSTALL_CAPABILITY__", self.install_capability)
            .replace("__BOARDS__", json.dumps(board_map, ensure_ascii=False, separators=(",", ":")))
            .replace(
                "__DIANDIAN_CONTRACT__",
                json.dumps(diandian_contract, ensure_ascii=False, separators=(",", ":")),
            )
        )
        if any(placeholder in userscript for placeholder in (
            "__PORT__", "__TOKEN__", "__INSTALL_CAPABILITY__", "__BOARDS__",
            "__DIANDIAN_CONTRACT__", "__DIANDIAN_MATCH_LINE__",
        )):
            raise ValueError("userscript template contains unresolved placeholders")
        return userscript

    def regenerate_userscript(self) -> None:
        userscript = self.userscript_content()
        temporary = self.userscript.with_name(f"{self.userscript.name}.{os.getpid()}.tmp")
        try:
            temporary.write_text(userscript, encoding="utf-8")
            temporary.replace(self.userscript)
        finally:
            temporary.unlink(missing_ok=True)

    def update_board(self, board_id: str, enabled: bool) -> list[dict]:
        if not self.processing_lock.acquire(blocking=False):
            raise BridgeBusyError("organization is running; retry after it finishes")
        try:
            config = json.loads(self.config_path.read_text(encoding="utf-8-sig"))
            original = copy.deepcopy(config)
            updated = update_board_enabled(copy.deepcopy(config), board_id, enabled)
            all_boards, enabled_boards = self.normalize_boards(updated)
            userscript = self.userscript_content(all_boards)
            temporary = self.userscript.with_name(f"{self.userscript.name}.{os.getpid()}.{threading.get_ident()}.tmp")
            try:
                temporary.write_text(userscript, encoding="utf-8")
                atomic_json(self.config_path, updated)
                try:
                    temporary.replace(self.userscript)
                except OSError:
                    atomic_json(self.config_path, original)
                    raise
            finally:
                temporary.unlink(missing_ok=True)
            self.all_boards = all_boards
            self.boards = enabled_boards
            self.board_order = list(enabled_boards)
            return self.board_settings()
        finally:
            self.processing_lock.release()

    def update_catalog_board_names(self, renamed: dict[str, tuple[str, str]]) -> None:
        if not renamed or not self.catalog_path.exists():
            return
        catalog = json.loads(self.catalog_path.read_text(encoding="utf-8-sig"))
        changed = False
        for note in catalog.get("notes", {}).values():
            if not isinstance(note, dict):
                continue
            ids = note.get("source_board_ids")
            names = note.get("source_boards")
            if not isinstance(ids, list) or not isinstance(names, list):
                continue
            for index, board_id in enumerate(ids):
                if board_id not in renamed or index >= len(names):
                    continue
                old_name, new_name = renamed[board_id]
                if names[index] == old_name:
                    names[index] = new_name
                    changed = True
        if changed:
            atomic_json(self.catalog_path, catalog)

    def discover_boards(self, payload: dict) -> list[dict]:
        batch = str(payload.get("batch", ""))
        discovered = payload.get("boards")
        with self.get_manual_sync_lock():
            self.require_manual_discovery_state(self.read_manual_sync(), batch)
        if not isinstance(discovered, list) or not 1 <= len(discovered) <= 200:
            raise ValueError("board discovery must contain between 1 and 200 boards")

        normalized = []
        seen = set()
        for item in discovered:
            board_id = str(item.get("id", "")) if isinstance(item, dict) else ""
            name = " ".join(str(item.get("name", "")).split()).strip() if isinstance(item, dict) else ""
            if not BOARD_ID.fullmatch(board_id) or not name or len(name) > 100 or board_id in seen:
                raise ValueError("board discovery contained an invalid board")
            seen.add(board_id)
            try:
                count = max(0, min(100000, int(item.get("advertised_count", 0) or 0)))
            except (TypeError, ValueError):
                count = 0
            normalized.append({"id": board_id, "name": name, "advertised_count": count})

        if not self.processing_lock.acquire(blocking=False):
            raise BridgeBusyError("organization is running; retry after it finishes")
        try:
            with self.get_manual_sync_lock():
                state = self.read_manual_sync()
                self.require_manual_discovery_state(state, batch)
                if state.get("local_only") is True:
                    run_board_ids = state.get("run_board_ids")
                    target_note_id = state.get("target_note_id")
                    if (
                        state.get("run_mode") != "history"
                        or not isinstance(run_board_ids, list)
                        or len(run_board_ids) != 1
                        or run_board_ids[0] not in self.boards
                        or run_board_ids[0] not in seen
                        or not isinstance(target_note_id, str)
                        or not NOTE_ID.fullmatch(target_note_id)
                    ):
                        raise ValueError("single-note validation scope is unavailable after discovery")
                    board_id = run_board_ids[0]
                    state.update({
                        "state": "running",
                        "board_count": 1,
                        "current_board": self.boards[board_id],
                    })
                    atomic_json(self.manual_sync_path, state)
                    return [{"id": board_id, "name": self.boards[board_id]}]

            config = json.loads(self.config_path.read_text(encoding="utf-8-sig"))
            original = copy.deepcopy(config)
            existing = {
                str(board.get("id", "")): board
                for board in config.get("boards", []) if isinstance(board, dict)
            }
            renamed = {}
            for item in normalized:
                board = existing.get(item["id"])
                if board is None:
                    board = {
                        "id": item["id"],
                        "name": item["name"],
                        "enabled": True,
                        "advertised_count": item["advertised_count"],
                    }
                    config["boards"].append(board)
                    existing[item["id"]] = board
                else:
                    old_name = str(board.get("name", "")).strip()
                    if old_name != item["name"]:
                        renamed[item["id"]] = (old_name, item["name"])
                        board["name"] = item["name"]
                    board["advertised_count"] = item["advertised_count"]
                board["available"] = True
            for board_id, board in existing.items():
                if board_id not in seen:
                    board["available"] = False

            all_boards, enabled_boards = self.normalize_boards(config)
            if not enabled_boards:
                raise ValueError("没有可整理的已启用收藏夹")
            userscript = self.userscript_content(all_boards)
            temporary = self.userscript.with_name(
                f"{self.userscript.name}.{os.getpid()}.{threading.get_ident()}.tmp"
            )
            try:
                temporary.write_text(userscript, encoding="utf-8")
                atomic_json(self.config_path, config)
                try:
                    temporary.replace(self.userscript)
                except OSError:
                    atomic_json(self.config_path, original)
                    raise
            finally:
                temporary.unlink(missing_ok=True)
            self.all_boards = all_boards
            self.boards = enabled_boards
            self.board_order = list(enabled_boards)
            self.update_catalog_board_names(renamed)
            with self.get_manual_sync_lock():
                state = self.read_manual_sync()
                self.require_manual_discovery_state(state, batch)
                requested_board_ids = state.get("requested_board_ids")
                if requested_board_ids is None:
                    run_board_ids = list(self.board_order)
                elif (
                    not isinstance(requested_board_ids, list)
                    or not requested_board_ids
                    or len(requested_board_ids) > MAX_RUN_BOARD_COUNT
                    or len(set(requested_board_ids)) != len(requested_board_ids)
                    or any(board_id not in self.boards for board_id in requested_board_ids)
                ):
                    raise ValueError("requested board is not available after discovery")
                else:
                    run_board_ids = list(requested_board_ids)
                state.update({
                    "state": "running",
                    "board_count": len(run_board_ids),
                    "current_board": self.boards[run_board_ids[0]],
                    "run_board_ids": run_board_ids,
                })
                atomic_json(self.manual_sync_path, state)
            return [
                {"id": board_id, "name": self.boards[board_id]}
                for board_id in run_board_ids
            ]
        finally:
            self.processing_lock.release()

    def write_status(self, value: dict) -> None:
        run_id = value.get("run_id")
        if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
            raise ValueError("status is missing a valid run_id")
        atomic_json(self.status_path, value)

        atomic_json(self.state_dir / "runs" / f"{run_id}.json", value)

    def prepare_import(self, payload: dict) -> tuple[str, dict[str, str]]:
        run_id = payload.get("run_id")
        board_id = payload.get("board_id")
        urls = payload.get("urls")
        if not isinstance(run_id, str) or not RUN_ID.fullmatch(run_id):
            raise ValueError("invalid run_id")
        if board_id not in self.boards or not BOARD_ID.fullmatch(str(board_id)):
            raise ValueError("unexpected board_id")
        self.validate_manual_board_run(run_id, str(board_id))
        if not isinstance(urls, list) or not 1 <= len(urls) <= 200 or not all(isinstance(v, str) for v in urls):
            raise ValueError("urls must contain between 1 and 200 strings")

        unique: dict[str, str] = {}
        for value in urls:
            note_id = note_id_from_url(value)
            unique.setdefault(note_id, value)
        target_note_id = self.single_note_target_for_run(run_id, str(board_id))
        if target_note_id is not None and set(unique) != {target_note_id}:
            raise ValueError("single-note import must contain exactly the run target")
        return run_id, unique

    def import_sync(self, payload: dict) -> tuple[int, dict]:
        with self.processing_lock:
            run_id, unique = self.prepare_import(payload)
            board_id = payload["board_id"]
            self.record_manual_started(run_id, board_id)
            run_status_path = self.state_dir / "runs" / f"{run_id}.json"
            if run_status_path.exists():
                existing = json.loads(run_status_path.read_text(encoding="utf-8-sig"))
                self.record_manual_result(run_id, board_id, existing)
                ok = existing.get("state") == "completed"
                return (HTTPStatus.OK if ok else HTTPStatus.CONFLICT), {"ok": ok, **existing}
            self.process_import(run_id, board_id, unique)
            result = json.loads(run_status_path.read_text(encoding="utf-8-sig"))
            self.record_manual_result(run_id, board_id, result)
            if not self.summary_plans.get(run_id):
                self.summary_plans.pop(run_id, None)
            ok = result.get("state") == "completed"
            status = (
                HTTPStatus.OK
                if ok
                else HTTPStatus.CONFLICT
                if result.get("state") == "safety-stopped"
                else HTTPStatus.INTERNAL_SERVER_ERROR
            )
            return status, {"ok": ok, **result}

    def next_board_id(self, board_id: str, run_id: str | None = None) -> str | None:
        order = list(self.board_order)
        if run_id is not None:
            state = self.read_manual_sync()
            batch = str(state.get("batch", ""))
            if not batch or run_id != self.manual_run_id(batch, board_id):
                raise ValueError("manual organization batch does not match")
            order = self.run_board_order(batch)
        if board_id not in order:
            raise ValueError("board is outside this run scope")
        index = order.index(board_id)
        return order[index + 1] if index + 1 < len(order) else None

    def board_context(self, batch: str, board_id: str) -> dict:
        scope = self.run_board_order(batch)
        if board_id not in scope:
            raise ValueError("board is outside this run scope")
        board = next(item for item in self.all_boards if item["id"] == board_id)
        context = {
            "id": board_id,
            "name": board["name"],
            "advertised_count": board["advertised_count"],
        }
        state = self.read_manual_sync()
        target_note_id = state.get("target_note_id")
        if (
            len(scope) == 1
            and scope[0] == board_id
            and isinstance(target_note_id, str)
            and NOTE_ID.fullmatch(target_note_id)
        ):
            context["target_note_id"] = target_note_id
        return context

    def publish_public_site(self) -> dict:
        if self.publish_config is None:
            return {"ok": True, "status": "disabled"}
        try:
            published = run_bounded_subprocess(
                [
                    "node", str(self.publisher),
                    "--workspace", str(self.workspace),
                    "--repository", self.publish_config["repository"],
                    "--branch", self.publish_config["branch"],
                ],
                input_text="",
                cwd=self.workspace,
                env=None,
                timeout=180,
                stdout_limit=1024 * 1024,
                stderr_limit=1024 * 1024,
            )
        except subprocess.TimeoutExpired:
            return {
                "ok": False,
                "status": "failed",
                "error": "Hugging Face publication timed out after 180 seconds",
            }
        except (OSError, RuntimeError, ValueError) as error:
            return {
                "ok": False,
                "status": "failed",
                "error": sanitize_error(f"publisher could not start: {error}"),
            }
        if published.returncode != 0:
            return {
                "ok": False,
                "status": "failed",
                "error": sanitize_error(published.stderr),
            }
        try:
            result = json.loads(published.stdout)
        except json.JSONDecodeError:
            return {
                "ok": False,
                "status": "failed",
                "error": "publisher returned invalid JSON",
            }
        if not isinstance(result, dict) or result.get("status") not in {"published", "unchanged"}:
            return {
                "ok": False,
                "status": "failed",
                "error": "publisher returned an unsupported result",
            }
        return result

    def publish_after_board(
        self,
        board_id: str,
        run_id: str | None = None,
        *,
        require_finalization_claim: bool = False,
    ) -> dict | None:
        if run_id is not None:
            if self.summary_plans.get(run_id):
                return None
            state = self.read_manual_sync()
            batch = str(state.get("batch", ""))
            if (
                state.get("local_only") is True
                and batch
                and run_id == self.manual_run_id(batch, board_id)
            ):
                return None
        if self.publish_config is None or self.next_board_id(board_id, run_id) is not None:
            return None
        if require_finalization_claim:
            if run_id is None or not self.claim_diandian_publish(run_id, board_id):
                return None
        # The per-run claim above is the short critical section. The external
        # publisher may take minutes, so it must execute after releasing run locks.
        return self.publish_public_site()

    def tag_catalog_sources(self, board_id: str, note_ids: set[str]) -> None:
        if not self.catalog_path.exists():
            return
        catalog = json.loads(self.catalog_path.read_text(encoding="utf-8-sig"))
        changed = False
        for note_id in note_ids:
            note = catalog.get("notes", {}).get(note_id)
            if not isinstance(note, dict):
                continue
            ids = note.get("source_board_ids") if isinstance(note.get("source_board_ids"), list) else []
            names = note.get("source_boards") if isinstance(note.get("source_boards"), list) else []
            if board_id not in ids:
                ids.append(board_id)
                changed = True
            board_name = self.boards[board_id]
            if board_name not in names:
                names.append(board_name)
                changed = True
            note["source_board_ids"] = ids
            note["source_boards"] = names
        if changed:
            atomic_json(self.catalog_path, catalog)

    def rebuild_knowledge_base(self) -> None:
        public_output = self.workspace / "site" / "data" / "knowledge.json"
        public_snapshot = public_output.read_bytes() if public_output.exists() else None
        public_builder_args = [
            "node", str(self.public_builder),
            "--config", str(self.config_path),
            "--catalog", str(self.catalog_path),
            "--curation", str(self.curation),
            "--summaries", str(self.knowledge_base / "05-Skills成果" / "Skills面板逐篇总结与总汇.md"),
            "--diandian-dir", str(self.diandian_dir),
            "--output", str(public_output),
        ]
        if self.resource_registry is not None:
            public_builder_args.extend(["--resources", str(self.resource_registry)])
        try:
            public_site = subprocess.run(
                public_builder_args,
                text=True,
                encoding="utf-8",
                capture_output=True,
                cwd=self.workspace,
                timeout=120,
                check=False,
            )
            if public_site.returncode != 0:
                raise RuntimeError(f"public site build failed: {sanitize_error(public_site.stderr)}")

            built = subprocess.run(
                [
                    "node", str(self.builder),
                    "--catalog", str(self.catalog_path),
                    "--config", str(self.config_path),
                    "--curation", str(self.curation),
                    "--profile", str(self.profile),
                    "--diandian-dir", str(self.diandian_dir),
                    "--output", str(self.knowledge_base),
                ],
                text=True,
                encoding="utf-8",
                capture_output=True,
                cwd=self.workspace,
                timeout=120,
                check=False,
            )
            if built.returncode != 0:
                raise RuntimeError(f"knowledge base build failed: {sanitize_error(built.stderr)}")
        except Exception:
            restore_file_snapshot(public_output, public_snapshot)
            raise

    def process_import(self, run_id: str, board_id: str, unique: dict[str, str]) -> None:
        started_at = datetime.now().astimezone().isoformat()
        try:
            baseline = not self.catalog_path.exists()
            known = read_catalog_ids(self.catalog_path)
            existing_notes = {}
            if self.catalog_path.exists():
                existing_catalog = json.loads(self.catalog_path.read_text(encoding="utf-8-sig"))
                existing_notes = existing_catalog.get("notes", {})
            pending = [
                (note_id, value) for note_id, value in unique.items()
                if note_id not in known
                or not isinstance(existing_notes.get(note_id), dict)
                or existing_notes[note_id].get("comment_evidence_checked") is not True
            ]
            status = {
                "run_id": run_id,
                "state": "running",
                "started_at": started_at,
                "scanned": len(unique),
                "pending": len(pending),
                "board_id": board_id,
                "board_name": self.boards[board_id],
            }
            self.write_status(status)

            safety_stop_path = self.state_dir / "media-download-safety-stop.json"
            if safety_stop_path.exists():
                result = {
                    **status,
                    "state": "safety-stopped",
                    "completed_at": datetime.now().astimezone().isoformat(),
                    "new": 0,
                    "baseline": baseline,
                    "report": None,
                    "media": {
                        "queued": 0,
                        "downloaded": 0,
                        "safety_stopped": True,
                        "state": "safety-stopped",
                    },
                    "next_board_id": None,
                    "error": "小红书触发安全限制，已停止本轮且不会继续重试",
                }
                self.write_status(result)
                return

            if not pending:
                catalog_snapshot = self.catalog_path.read_bytes()
                try:
                    self.tag_catalog_sources(board_id, set(unique))
                    self.rebuild_knowledge_base()
                except Exception:
                    restore_file_snapshot(self.catalog_path, catalog_snapshot)
                    raise
                catalog = json.loads(self.catalog_path.read_text(encoding="utf-8-sig"))
                media = self.cache_missing_media(filter_media_candidates(
                    unique, catalog.get("notes", {}), self.published_since
                ))
                safety_stopped = bool(media.get("safety_stopped"))
                next_board_id = None if safety_stopped else self.next_board_id(board_id, run_id)
                publish = None if safety_stopped else self.publish_after_board(board_id, run_id)
                result = {
                    **status,
                    "state": "safety-stopped" if safety_stopped else "completed",
                    "completed_at": datetime.now().astimezone().isoformat(),
                    "new": 0,
                    "baseline": False,
                    "report": None,
                    "media": media,
                    "next_board_id": next_board_id,
                }
                if safety_stopped:
                    result["error"] = "小红书触发安全限制，已停止本轮且不会继续重试"
                if publish is not None:
                    result["publish"] = publish
                self.write_status(result)
                return

            if safety_stop_path.exists():
                result = {
                    **status,
                    "state": "safety-stopped",
                    "completed_at": datetime.now().astimezone().isoformat(),
                    "new": 0,
                    "baseline": baseline,
                    "report": None,
                    "media": {
                        "queued": 0,
                        "downloaded": 0,
                        "safety_stopped": True,
                        "state": "safety-stopped",
                    },
                    "next_board_id": None,
                    "error": "小红书触发安全限制，已停止本轮且不会继续重试",
                }
                self.write_status(result)
                return

            fetch = run_bounded_subprocess(
                [
                    str(self.python), "-X", "utf8", str(self.fetcher),
                    "--xhs-dir", str(self.xhs_dir), "--max-items", str(len(pending)),
                    "--lock-file", str(self.state_dir / "platform-request.lock"),
                    "--safety-stop-file", str(safety_stop_path),
                ],
                input_text="\n".join(value for _, value in pending),
                cwd=self.xhs_dir,
                env={**os.environ, "PYTHONUTF8": "1"},
                timeout=max(120, len(pending) * 20),
                stdout_limit=MAX_DETAIL_FETCH_BYTES,
                stderr_limit=MAX_DETAIL_FETCH_ERROR_BYTES,
            )
            if fetch.returncode != 0:
                raise RuntimeError(f"detail fetch failed: {sanitize_error(fetch.stderr)}")

            fetched_notes, failures = parse_fetch_payload(
                fetch.stdout, {note_id for note_id, _ in pending}
            )
            safety_stopped = any(
                failure.get("reason") == "safety stop" for failure in failures
            )
            if safety_stopped:
                atomic_json(safety_stop_path, {
                    "stopped_at": datetime.now(timezone.utc).isoformat(),
                    "reason": "platform-safety-limit",
                })

            catalog_notes = dict(existing_notes)
            catalog_notes.update({note["note_id"]: note for note in fetched_notes})
            media_candidates = filter_media_candidates(
                unique, catalog_notes, self.published_since
            )
            media = (
                {
                    "queued": 0,
                    "downloaded": 0,
                    "safety_stopped": True,
                    "state": "safety-stopped",
                }
                if safety_stopped
                else None
            )

            report = self.workspace / "xhs-favorites" / f"{datetime.now().astimezone():%Y-%m-%d}.md"
            organize_args = [
                "node", str(self.organizer), "--input", "-", "--catalog", str(self.catalog_path),
                "--output", str(report), "--date", f"{datetime.now().astimezone():%Y-%m-%d}",
            ]
            if baseline:
                organize_args.append("--baseline")
            fetched_ids = {
                note["note_id"] for note in fetched_notes
                if isinstance(note.get("note_id"), str)
            }
            should_commit = bool(fetched_notes or not safety_stopped)
            if should_commit:
                catalog_snapshot = self.catalog_path.read_bytes() if self.catalog_path.exists() else None
                report_snapshot = report.read_bytes() if report.exists() else None
                try:
                    organized = subprocess.run(
                        organize_args,
                        input=json.dumps({"notes": fetched_notes}, ensure_ascii=False),
                        text=True,
                        encoding="utf-8",
                        capture_output=True,
                        cwd=self.workspace,
                        timeout=120,
                        check=False,
                    )
                    if organized.returncode != 0:
                        raise RuntimeError(f"organizer failed: {sanitize_error(organized.stderr)}")
                    self.tag_catalog_sources(board_id, (known & set(unique)) | fetched_ids)
                    self.rebuild_knowledge_base()
                except Exception:
                    restore_file_snapshot(self.catalog_path, catalog_snapshot)
                    restore_file_snapshot(report, report_snapshot)
                    raise
            if not safety_stopped:
                media = self.cache_missing_media(media_candidates)
                safety_stopped = bool(media.get("safety_stopped"))
            next_board_id = None if safety_stopped else self.next_board_id(board_id, run_id)
            publish = None if safety_stopped else self.publish_after_board(board_id, run_id)

            result = {
                **status,
                "state": "safety-stopped" if safety_stopped else "completed",
                "completed_at": datetime.now().astimezone().isoformat(),
                "new": 0 if baseline else len(fetched_ids - known),
                "skipped": len(failures),
                "failures": failures,
                "baseline": baseline,
                "report": str(report) if fetched_notes or not safety_stopped else None,
                "media": media,
                "next_board_id": next_board_id,
            }
            if safety_stopped:
                result["error"] = "小红书触发安全限制，已停止本轮且不会继续重试"
            if publish is not None:
                result["publish"] = publish
            self.write_status(result)
            return
        except Exception as error:  # noqa: BLE001
            result = {
                "run_id": run_id,
                "state": "failed",
                "started_at": started_at,
                "completed_at": datetime.now().astimezone().isoformat(),
                "error": sanitize_error(str(error)),
            }
            self.write_status(result)
            return


def make_handler(bridge: Bridge):
    class Handler(BaseHTTPRequestHandler):
        server_version = "XHSFavoritesBridge/1.0"

        def log_message(self, format_string: str, *args) -> None:
            # Never log request URLs because they may contain temporary XHS tokens.
            return

        def valid_host(self) -> bool:
            return self.headers.get("Host") == f"{HOST}:{bridge.port}"

        def authorized(self) -> bool:
            supplied = self.headers.get("X-XHS-Bridge-Token", "")
            return hmac.compare_digest(supplied, bridge.token)

        def send_json(self, status: int, value: dict) -> None:
            body = json.dumps(value, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            origin = self.headers.get("Origin")
            if is_manager_origin(origin):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:  # noqa: N802
            if not self.valid_host() or not is_manager_origin(self.headers.get("Origin")):
                self.send_json(HTTPStatus.FORBIDDEN, {"ok": False})
                return
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-XHS-Bridge-Token")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Vary", "Origin")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            if not self.valid_host():
                self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False})
                return
            parsed = urlparse(self.path)
            install_match = USERSCRIPT_INSTALL_PATH.fullmatch(parsed.path)
            if install_match:
                if parsed.query or not valid_userscript_install_capability(
                    bridge.userscript_install_state,
                    install_match.group(1),
                ):
                    self.send_json(HTTPStatus.NOT_FOUND, {"ok": False})
                    return
                body = bridge.userscript.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/javascript; charset=utf-8")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Content-Disposition", 'inline; filename="xhs-favorites.user.js"')
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Referrer-Policy", "no-referrer")
                self.end_headers()
                self.wfile.write(body)
                return
            if parsed.path == "/health":
                if not self.authorized():
                    self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False})
                    return
                self.send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "protocol_version": PROTOCOL_VERSION,
                        "board_ids": bridge.board_order,
                        "config_id": bridge.config_id,
                        "runtime_id": bridge.runtime_id,
                        "browser_channel_id": bridge.browser_channel_id,
                        "diandian_available": bool(getattr(bridge, "diandian_cdp_enabled", False)),
                    },
                )
                return
            if parsed.path == "/boards":
                if not self.authorized() or not is_manager_origin(self.headers.get("Origin")):
                    self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False})
                    return
                boards = bridge.board_settings()
                self.send_json(HTTPStatus.OK, {
                    "ok": True,
                    "boards": boards,
                    "diandian_available": bool(getattr(bridge, "diandian_cdp_enabled", False)),
                })
                return
            if parsed.path == "/sync/board-context" and self.authorized():
                query = parse_qs(parsed.query)
                try:
                    context = bridge.board_context(
                        query.get("batch", [""])[0],
                        query.get("board_id", [""])[0],
                    )
                except ValueError as error:
                    self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": sanitize_error(str(error))})
                    return
                self.send_json(HTTPStatus.OK, {"ok": True, "board": context})
                return
            if parsed.path == "/sync/status":
                if not self.authorized() or not is_manager_origin(self.headers.get("Origin")):
                    self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False})
                    return
                self.send_json(HTTPStatus.OK, {"ok": True, **bridge.manual_sync_status()})
                return
            if parsed.path == "/local-session":
                if not is_manager_origin(self.headers.get("Origin")):
                    self.send_json(HTTPStatus.FORBIDDEN, {"ok": False})
                    return
                self.send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "protocol_version": PROTOCOL_VERSION,
                        "token": bridge.token,
                        "browser_session": {
                            "owner": "sop-cdp",
                            "ready": bridge.browser_session_ready(),
                        },
                        "diandian_available": bool(getattr(bridge, "diandian_cdp_enabled", False)),
                    },
                )
                return
            if parsed.path == "/status" and self.authorized():
                run_id = parse_qs(parsed.query).get("run_id", [""])[0]
                if not RUN_ID.fullmatch(run_id):
                    self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": "invalid run_id"})
                    return
                status_path = bridge.state_dir / "runs" / f"{run_id}.json"
                if not status_path.exists():
                    self.send_json(HTTPStatus.NOT_FOUND, {"ok": False, "state": "not_started"})
                    return
                status = json.loads(status_path.read_text(encoding="utf-8-sig"))
                self.send_json(HTTPStatus.OK, {"ok": True, **status})
                return
            self.send_json(HTTPStatus.NOT_FOUND, {"ok": False})

        def do_POST(self) -> None:  # noqa: N802
            if not self.valid_host():
                self.send_json(HTTPStatus.NOT_FOUND, {"ok": False})
                return
            if self.path not in {
                "/import-sync", "/boards", "/sync/start", "/sync/failure", "/sync/discover",
                "/sync/summary-plan", "/sync/diandian-result", "/sync/diandian-skip",
                "/sync/diandian-halt", "/sync/diandian-cdp", "/notes/open",
                "/install/complete",
            }:
                self.send_json(HTTPStatus.NOT_FOUND, {"ok": False})
                return
            if not self.authorized():
                self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False})
                return
            if self.path in {"/boards", "/sync/start", "/notes/open"} and not is_manager_origin(self.headers.get("Origin")):
                self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > MAX_BODY_BYTES:
                    raise ValueError("invalid request size")
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                if not isinstance(payload, dict):
                    raise ValueError("request body must be a JSON object")
                if self.path == "/boards":
                    boards = bridge.update_board(str(payload.get("board_id", "")), payload.get("enabled"))
                    self.send_json(HTTPStatus.OK, {"ok": True, "boards": boards})
                    return
                if self.path == "/sync/start":
                    self.send_json(HTTPStatus.ACCEPTED, {"ok": True, **bridge.trigger_manual_sync(payload)})
                    return
                if self.path == "/install/complete":
                    if set(payload) != {"capability"}:
                        raise ValueError("install completion body must contain only capability")
                    self.send_json(HTTPStatus.OK, {
                        "ok": True,
                        "invalidated": invalidate_userscript_install_capability(
                            bridge.userscript_install_state,
                            str(payload.get("capability", "")),
                        ),
                    })
                    return
                if self.path == "/sync/discover":
                    boards = bridge.discover_boards(payload)
                    self.send_json(HTTPStatus.OK, {"ok": True, "boards": boards})
                    return
                if self.path == "/sync/failure":
                    self.send_json(HTTPStatus.OK, {"ok": True, **bridge.record_manual_failure(payload)})
                    return
                if self.path == "/sync/summary-plan":
                    self.send_json(HTTPStatus.OK, {"ok": True, **bridge.diandian_summary_plan(payload)})
                    return
                if self.path == "/sync/diandian-result":
                    self.send_json(HTTPStatus.OK, {"ok": True, **bridge.save_diandian_result(payload)})
                    return
                if self.path == "/sync/diandian-skip":
                    self.send_json(HTTPStatus.OK, {"ok": True, **bridge.skip_diandian_result(payload)})
                    return
                if self.path == "/sync/diandian-halt":
                    self.send_json(HTTPStatus.OK, {"ok": True, **bridge.halt_diandian_run(payload)})
                    return
                if self.path == "/sync/diandian-cdp":
                    self.send_json(HTTPStatus.OK, {"ok": True, **bridge.run_diandian_cdp(payload)})
                    return
                if self.path == "/notes/open":
                    if set(payload) != {"note_id"}:
                        raise ValueError("open request must contain only note_id")
                    self.send_json(
                        HTTPStatus.ACCEPTED,
                        {"ok": True, **bridge.open_original_note(str(payload.get("note_id", "")))},
                    )
                    return
                status, result = bridge.import_sync(payload)
                self.send_json(status, result)
            except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
                self.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": sanitize_error(str(error))})
            except BridgeBusyError as error:
                self.send_json(HTTPStatus.CONFLICT, {"ok": False, "error": sanitize_error(str(error))})
            except RuntimeError as error:
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": sanitize_error(str(error))})
            except OSError as error:
                self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": sanitize_error(str(error))})

    return Handler


def main() -> None:
    args = parse_args()
    if not 1024 <= args.port <= 65535:
        raise ValueError("--port must be between 1024 and 65535")
    bridge = Bridge(
        Path(args.workspace),
        Path(args.skill_dir),
        Path(args.config),
        Path(args.sop_runtime),
        args.port,
    )
    server = ThreadingHTTPServer((HOST, args.port), make_handler(bridge))
    server.daemon_threads = True
    print(f"XHS favorites bridge listening on {HOST}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print(f"xhs-favorites-bridge: {sanitize_error(str(error))}", file=sys.stderr)
        raise SystemExit(1) from error
