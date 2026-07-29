#!/usr/bin/env python3

"""Loopback-only bridge for user-triggered Xiaohongshu favorites imports."""

from __future__ import annotations

import argparse
import copy
from datetime import datetime
import hashlib
import hmac
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import threading
from urllib.parse import parse_qs, urlparse


HOST = "127.0.0.1"
DEFAULT_PORT = 47631
MANAGER_ORIGIN = "http://127.0.0.1:8766"
PROTOCOL_VERSION = 5
MANUAL_START_TIMEOUT_SECONDS = 90
MAX_BODY_BYTES = 256 * 1024
NOTE_PATH = re.compile(r"^/(?:explore|discovery/item)/([A-Za-z0-9_-]{1,128})$")
NOTE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
RUN_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
BOARD_ID = re.compile(r"^[a-z0-9]{1,80}$")
TOKEN_QUERY = re.compile(r"(?i)(xsec_token=)[^&\s]+")
HF_SPACE_REPOSITORY = re.compile(
    r"^https://huggingface\.co/spaces/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(?:\.git)?$"
)
GIT_BRANCH = re.compile(r"^[A-Za-z0-9._/-]{1,100}$")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


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
    if not enabled and sum(board.get("enabled") is True for board in boards) <= 1 and matched.get("enabled") is True:
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


def sanitize_error(value: str) -> str:
    cleaned = TOKEN_QUERY.sub(r"\1[REDACTED]", value).strip()
    return cleaned[:1500] if cleaned else "No diagnostic output was returned."


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


def parse_fetch_payload(
    value: str, expected_ids: set[str] | None = None
) -> tuple[list[dict], list[dict]]:
    """Validate the detail fetcher's private subprocess contract."""
    try:
        payload = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError("detail fetcher returned invalid JSON") from error
    if not isinstance(payload, dict):
        raise ValueError("detail fetcher returned an invalid payload")
    notes = payload.get("notes")
    failures = payload.get("failures", [])
    if not isinstance(notes, list) or not all(
        isinstance(note, dict)
        and isinstance(note.get("note_id"), str)
        and NOTE_ID.fullmatch(note["note_id"])
        for note in notes
    ):
        raise ValueError("detail fetcher returned invalid notes")
    if not isinstance(failures, list) or not all(
        isinstance(item, dict)
        and isinstance(item.get("note_id"), str)
        and NOTE_ID.fullmatch(item["note_id"])
        and item.get("reason") in {"detail unavailable", "request failed"}
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


class Bridge:
    def __init__(self, workspace: Path, skill_dir: Path, config_path: Path, port: int) -> None:
        self.workspace = workspace.resolve()
        self.skill_dir = skill_dir.resolve()
        self.config_path = config_path.resolve()
        config = json.loads(self.config_path.read_text(encoding="utf-8-sig"))
        self.all_boards = []
        self.boards = {}
        self.board_order = []
        self.refresh_boards(config)
        self.published_since = normalize_published_since(config.get("published_since"))
        self.video_analysis_enabled = (
            isinstance(config.get("video_analysis"), dict)
            and config["video_analysis"].get("enabled") is True
        )
        self.knowledge_base = resolve_workspace_path(self.workspace, str(config.get("knowledge_base", "knowledge-base")), "knowledge_base")
        self.port = port
        self.state_dir = self.workspace / ".xhs-favorites"
        self.token_path = self.state_dir / "bridge-token"
        self.status_path = self.state_dir / "bridge-status.json"
        self.manual_sync_path = self.state_dir / "manual-sync.json"
        self.catalog_path = self.state_dir / "catalog.json"
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
        self.userscript_template = self.skill_dir / "assets" / "xhs-favorites.user.js.template"
        self.token = self.token_path.read_text(encoding="utf-8").strip()
        if len(self.token) < 32:
            raise ValueError("bridge token is missing or invalid; run setup-autosync.ps1")
        required_files = [
            self.python,
            self.fetcher,
            self.media_fetcher,
            self.organizer,
            self.builder,
            self.public_builder,
            self.curation,
            self.profile,
            self.userscript,
            self.userscript_template,
        ]
        if self.publish_config is not None:
            required_files.append(self.publisher)
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
            if not required.is_file():
                raise ValueError(f"required file was not found: {required}")
        self.config_id = hashlib.sha256(self.token.encode("utf-8")).hexdigest()
        self.processing_lock = threading.Lock()
        self.trigger_lock = threading.Lock()

    @staticmethod
    def manual_run_id(batch: str, board_id: str) -> str:
        return re.sub(r"[^A-Za-z0-9_-]", "", f"{batch}_{board_id}")[:80]

    def read_manual_sync(self) -> dict:
        if not self.manual_sync_path.exists():
            return {"state": "idle"}
        try:
            value = json.loads(self.manual_sync_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            return {"state": "idle"}
        return value if isinstance(value, dict) else {"state": "idle"}

    def manual_sync_status(self) -> dict:
        value = self.read_manual_sync()
        if value.get("state") == "starting":
            try:
                started = datetime.fromisoformat(str(value.get("started_at", "")))
                age_seconds = (datetime.now().astimezone() - started).total_seconds()
            except (TypeError, ValueError):
                age_seconds = MANUAL_START_TIMEOUT_SECONDS + 1
            if age_seconds > MANUAL_START_TIMEOUT_SECONDS:
                value.update({
                    "state": "failed",
                    "completed_at": datetime.now().astimezone().isoformat(),
                    "error": "Chrome 已打开，但未检测到 Tampermonkey 响应；请确认脚本已启用后重试。",
                })
                atomic_json(self.manual_sync_path, value)
        allowed = {
            "state", "started_at", "completed_at", "board_count", "processed_boards",
            "current_board", "scanned", "new", "error", "publish_status",
        }
        return {key: value[key] for key in allowed if key in value}

    def trigger_manual_sync(self) -> dict:
        if not self.trigger_lock.acquire(blocking=False):
            raise BridgeBusyError("a manual organization request is already starting")
        try:
            if not self.board_order:
                raise ValueError("请至少开启一个收藏夹")
            self.manual_sync_status()
            current = self.read_manual_sync()
            if current.get("state") in {"starting", "running"}:
                try:
                    started = datetime.fromisoformat(str(current.get("started_at", "")))
                    age_seconds = (datetime.now().astimezone() - started).total_seconds()
                except (TypeError, ValueError):
                    age_seconds = 0
                if age_seconds < 2 * 60 * 60:
                    raise BridgeBusyError("organization is already running in Chrome")
            if self.processing_lock.locked():
                raise BridgeBusyError("organization is already processing a collection")

            batch = f"manual{datetime.now().astimezone():%Y%m%d%H%M%S%f}"
            state = {
                "batch": batch,
                "state": "starting",
                "started_at": datetime.now().astimezone().isoformat(),
                "board_count": len(self.board_order),
                "processed_boards": 0,
                "current_board": self.boards[self.board_order[0]],
                "scanned": 0,
                "new": 0,
                "processed_run_ids": [],
            }
            atomic_json(self.manual_sync_path, state)
            chrome_candidates = [
                Path(os.environ.get("ProgramFiles", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
                Path(os.environ.get("ProgramFiles(x86)", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
                Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "Application" / "chrome.exe",
            ]
            chrome = next((candidate for candidate in chrome_candidates if candidate.is_file()), None)
            if chrome is None:
                state.update({
                    "state": "failed",
                    "completed_at": datetime.now().astimezone().isoformat(),
                    "error": "Google Chrome was not found",
                })
                atomic_json(self.manual_sync_path, state)
                raise RuntimeError(state["error"])
            first_board_id = self.board_order[0]
            url = (
                f"https://www.xiaohongshu.com/board/{first_board_id}"
                f"?source=web_user_page&xhs_kb_sync=1&xhs_kb_batch={batch}&xhs_kb_mode=incremental"
            )
            try:
                subprocess.Popen(
                    [str(chrome), url],
                    cwd=self.workspace,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            except OSError as error:
                state.update({
                    "state": "failed",
                    "completed_at": datetime.now().astimezone().isoformat(),
                    "error": sanitize_error(f"could not open Chrome: {error}"),
                })
                atomic_json(self.manual_sync_path, state)
                raise RuntimeError(state["error"]) from error
            return self.manual_sync_status()
        finally:
            self.trigger_lock.release()

    def record_manual_result(self, run_id: str, board_id: str, result: dict) -> None:
        state = self.read_manual_sync()
        batch = str(state.get("batch", ""))
        if not batch or run_id != self.manual_run_id(batch, board_id):
            return
        processed = state.get("processed_run_ids")
        if not isinstance(processed, list):
            processed = []
        if run_id not in processed:
            processed.append(run_id)
            state["scanned"] = int(state.get("scanned", 0) or 0) + int(result.get("scanned", 0) or 0)
            state["new"] = int(state.get("new", 0) or 0) + int(result.get("new", 0) or 0)
        state["processed_run_ids"] = processed
        state["processed_boards"] = len(processed)
        if result.get("state") == "failed":
            state.update({
                "state": "failed",
                "completed_at": result.get("completed_at") or datetime.now().astimezone().isoformat(),
                "error": sanitize_error(str(result.get("error") or "organization failed")),
            })
        elif result.get("state") == "completed" and result.get("next_board_id") is None:
            publish = result.get("publish") if isinstance(result.get("publish"), dict) else None
            state.update({
                "state": "completed",
                "completed_at": result.get("completed_at") or datetime.now().astimezone().isoformat(),
                "current_board": "",
            })
            if publish:
                state["publish_status"] = str(publish.get("status") or "")
        elif result.get("state") == "completed":
            next_board_id = str(result.get("next_board_id") or "")
            state.update({
                "state": "running",
                "current_board": self.boards.get(next_board_id, "下一个收藏夹"),
            })
        atomic_json(self.manual_sync_path, state)

    def record_manual_started(self, run_id: str, board_id: str) -> None:
        state = self.read_manual_sync()
        batch = str(state.get("batch", ""))
        if not batch or run_id != self.manual_run_id(batch, board_id):
            return
        state.update({"state": "running", "current_board": self.boards[board_id]})
        atomic_json(self.manual_sync_path, state)

    def record_manual_failure(self, payload: dict) -> dict:
        run_id = str(payload.get("run_id", ""))
        board_id = str(payload.get("board_id", ""))
        if not RUN_ID.fullmatch(run_id) or board_id not in self.boards:
            raise ValueError("invalid manual organization failure payload")
        state = self.read_manual_sync()
        batch = str(state.get("batch", ""))
        if not batch or run_id != self.manual_run_id(batch, board_id):
            raise ValueError("manual organization batch does not match")
        state.update({
            "state": "failed",
            "completed_at": datetime.now().astimezone().isoformat(),
            "error": sanitize_error(str(payload.get("error") or "Chrome could not finish the collection")),
        })
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
        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            process = subprocess.Popen(
            [
                str(self.python), "-X", "utf8", str(self.media_fetcher),
                "--signed-urls-stdin",
                "--xhs-dir", str(self.xhs_dir),
                "--media-dir", str(self.media_dir),
                "--report", str(report),
                "--lock-file", str(self.state_dir / "media-download.lock"),
                "--safety-stop-file", str(safety_stop),
                "--max-items", str(len(urls)),
                "--delay", "3",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            cwd=self.workspace,
            env={**os.environ, "PYTHONUTF8": "1"},
            creationflags=creation_flags,
            )
            if process.stdin is None:
                raise RuntimeError("media downloader stdin is unavailable")
            process.stdin.write("\n".join(urls))
            process.stdin.close()
        except (OSError, RuntimeError):
            return {
                "queued": len(urls),
                "downloaded": 0,
                "safety_stopped": False,
                "state": "not-started",
            }
        return {
            "queued": len(urls),
            "downloaded": 0,
            "safety_stopped": False,
            "state": "scheduled",
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
                "advertised_count": max(0, int(board.get("advertised_count", 0) or 0)),
            }
            all_boards.append(normalized)
            if normalized["enabled"]:
                enabled_boards[board_id] = name
        if not enabled_boards:
            raise ValueError("config does not contain any enabled boards")
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
        board_map = {
            board["id"]: {"name": board["name"], "count": board["advertised_count"]}
            for board in source_boards if board["enabled"]
        }
        template = self.userscript_template.read_text(encoding="utf-8")
        userscript = (
            template.replace("__PORT__", str(self.port))
            .replace("__TOKEN__", self.token)
            .replace("__BOARDS__", json.dumps(board_map, ensure_ascii=False, separators=(",", ":")))
        )
        if "__PORT__" in userscript or "__TOKEN__" in userscript or "__BOARDS__" in userscript:
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
        if not isinstance(urls, list) or not 1 <= len(urls) <= 200 or not all(isinstance(v, str) for v in urls):
            raise ValueError("urls must contain between 1 and 200 strings")

        unique: dict[str, str] = {}
        for value in urls:
            note_id = note_id_from_url(value)
            unique.setdefault(note_id, value)
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
            ok = result.get("state") == "completed"
            return (HTTPStatus.OK if ok else HTTPStatus.INTERNAL_SERVER_ERROR), {"ok": ok, **result}

    def next_board_id(self, board_id: str) -> str | None:
        index = self.board_order.index(board_id)
        return self.board_order[index + 1] if index + 1 < len(self.board_order) else None

    def publish_public_site(self) -> dict:
        if self.publish_config is None:
            return {"ok": True, "status": "disabled"}
        try:
            published = subprocess.run(
                [
                    "node", str(self.publisher),
                    "--workspace", str(self.workspace),
                    "--repository", self.publish_config["repository"],
                    "--branch", self.publish_config["branch"],
                ],
                text=True,
                encoding="utf-8",
                capture_output=True,
                cwd=self.workspace,
                timeout=180,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return {
                "ok": False,
                "status": "failed",
                "error": "Hugging Face publication timed out after 180 seconds",
            }
        except OSError as error:
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

    def publish_after_board(self, board_id: str) -> dict | None:
        if self.publish_config is None or self.next_board_id(board_id) is not None:
            return None
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
        built = subprocess.run(
            [
                "node", str(self.builder),
                "--catalog", str(self.catalog_path),
                "--config", str(self.config_path),
                "--curation", str(self.curation),
                "--profile", str(self.profile),
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

        public_builder_args = [
            "node", str(self.public_builder),
            "--config", str(self.config_path),
            "--catalog", str(self.catalog_path),
            "--curation", str(self.curation),
            "--summaries", str(self.knowledge_base / "05-Skills成果" / "Skills面板逐篇总结与总汇.md"),
            "--output", str(self.workspace / "site" / "data" / "knowledge.json"),
        ]
        if self.resource_registry is not None:
            public_builder_args.extend(["--resources", str(self.resource_registry)])
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

    def process_import(self, run_id: str, board_id: str, unique: dict[str, str]) -> None:
        started_at = datetime.now().astimezone().isoformat()
        try:
            baseline = not self.catalog_path.exists()
            known = read_catalog_ids(self.catalog_path)
            pending = [(note_id, value) for note_id, value in unique.items() if note_id not in known]
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

            if not pending:
                catalog = json.loads(self.catalog_path.read_text(encoding="utf-8-sig"))
                media = self.cache_missing_media(filter_media_candidates(
                    unique, catalog.get("notes", {}), self.published_since
                ))
                self.tag_catalog_sources(board_id, set(unique))
                self.rebuild_knowledge_base()
                next_board_id = self.next_board_id(board_id)
                publish = self.publish_after_board(board_id)
                result = {
                    **status,
                    "state": "completed",
                    "completed_at": datetime.now().astimezone().isoformat(),
                    "new": 0,
                    "baseline": False,
                    "report": None,
                    "media": media,
                    "next_board_id": next_board_id,
                }
                if publish is not None:
                    result["publish"] = publish
                self.write_status(result)
                return

            fetch = subprocess.run(
                [
                    str(self.python), "-X", "utf8", str(self.fetcher),
                    "--xhs-dir", str(self.xhs_dir), "--max-items", str(len(pending)),
                ],
                input="\n".join(value for _, value in pending),
                text=True,
                encoding="utf-8",
                capture_output=True,
                cwd=self.xhs_dir,
                env={**os.environ, "PYTHONUTF8": "1"},
                timeout=max(120, len(pending) * 20),
                check=False,
            )
            if fetch.returncode != 0:
                raise RuntimeError(f"detail fetch failed: {sanitize_error(fetch.stderr)}")

            fetched_notes, failures = parse_fetch_payload(
                fetch.stdout, {note_id for note_id, _ in pending}
            )

            catalog_notes = {}
            if self.catalog_path.exists():
                existing_catalog = json.loads(self.catalog_path.read_text(encoding="utf-8-sig"))
                catalog_notes.update(existing_catalog.get("notes", {}))
            catalog_notes.update({note["note_id"]: note for note in fetched_notes})
            media = self.cache_missing_media(filter_media_candidates(
                unique, catalog_notes, self.published_since
            ))

            report = self.workspace / "xhs-favorites" / f"{datetime.now().astimezone():%Y-%m-%d}.md"
            organize_args = [
                "node", str(self.organizer), "--input", "-", "--catalog", str(self.catalog_path),
                "--output", str(report), "--date", f"{datetime.now().astimezone():%Y-%m-%d}",
            ]
            if baseline:
                organize_args.append("--baseline")
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

            fetched_ids = {
                note["note_id"] for note in fetched_notes
                if isinstance(note.get("note_id"), str)
            }
            self.tag_catalog_sources(board_id, (known & set(unique)) | fetched_ids)
            self.rebuild_knowledge_base()
            next_board_id = self.next_board_id(board_id)
            publish = self.publish_after_board(board_id)

            result = {
                **status,
                "state": "completed",
                "completed_at": datetime.now().astimezone().isoformat(),
                "new": 0 if baseline else len(fetched_notes),
                "skipped": len(failures),
                "failures": failures,
                "baseline": baseline,
                "report": str(report),
                "media": media,
                "next_board_id": next_board_id,
            }
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
                    },
                )
                return
            if parsed.path == "/boards":
                if not self.authorized() or not is_manager_origin(self.headers.get("Origin")):
                    self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False})
                    return
                boards = bridge.board_settings()
                self.send_json(HTTPStatus.OK, {"ok": True, "boards": boards})
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
                    {"ok": True, "protocol_version": PROTOCOL_VERSION, "token": bridge.token},
                )
                return
            if parsed.path == "/xhs-favorites.user.js":
                body = bridge.userscript.read_bytes()
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/javascript; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
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
            if self.path not in {"/import-sync", "/boards", "/sync/start", "/sync/failure"}:
                self.send_json(HTTPStatus.NOT_FOUND, {"ok": False})
                return
            if not self.authorized():
                self.send_json(HTTPStatus.UNAUTHORIZED, {"ok": False})
                return
            if self.path in {"/boards", "/sync/start"} and not is_manager_origin(self.headers.get("Origin")):
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
                    self.send_json(HTTPStatus.ACCEPTED, {"ok": True, **bridge.trigger_manual_sync()})
                    return
                if self.path == "/sync/failure":
                    self.send_json(HTTPStatus.OK, {"ok": True, **bridge.record_manual_failure(payload)})
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
    bridge = Bridge(Path(args.workspace), Path(args.skill_dir), Path(args.config), args.port)
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
