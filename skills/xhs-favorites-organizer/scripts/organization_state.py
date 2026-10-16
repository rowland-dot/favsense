"""Versioned, privacy-safe organization run and note state reducer."""

from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import time


CONTRACT_PATH = Path(__file__).parents[3] / "site" / "organization-status-contract.json"
HASH = re.compile(r"^[a-f0-9]{64}$")
LEGACY_DIANDIAN_HALT_ERROR = "DianDian CDP summarization stopped; core import was preserved."
# How long a read waits for a file Windows refuses because it is being swapped or held. Same budget as
# the sync service's atomic write (bridge-server.py FILE_CLASH_WAIT_SECONDS): the busiest measured
# wait was a quarter of a second.
FILE_CLASH_WAIT_SECONDS = 2
# A DianDian reply that cannot be a summary costs only its own note; the run record counts each kind.
UNUSABLE_REPLY_COUNTERS = {"diandian-refused": "diandian_refused", "diandian-incomplete": "diandian_incomplete"}


def _contract():
    value = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    if value.get("schema_version") != 2:
        raise ValueError("organization status contract version mismatch")
    return value


def _now():
    return datetime.now(timezone.utc).isoformat()


def _phase(status="not_started", reason_code="", artifact_status=None):
    value = {"status": status, "reason_code": reason_code, "updated_at": _now()}
    if artifact_status is not None:
        value["artifact_status"] = artifact_status
    return value


def new_run_state(run_id):
    if not isinstance(run_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", run_id):
        raise ValueError("invalid run id")
    run = {
        "schema_version": 2,
        "run_id": run_id,
        "state": "core_completed",
        "build_version": "",
        "phases": {
            "core": _phase(), "summary": _phase(), "evidence": _phase(),
            "curation": _phase(), "build": _phase(), "publish": _phase("not_enabled"),
        },
        "counts": {"scanned": 0, "new": 0, "summary_captured": 0, "summary_failed": 0, "summary_refused": 0, "summary_incomplete": 0, "summary_batch_aborted": 0, "curation_accepted": 0, "curation_pending": 0},
    }
    run["state"] = derive_overall_state(run)
    return run


def transition_phase(run, phase, status, reason_code="", artifact_status=None):
    contract = _contract()
    if phase not in contract["phase_statuses"] or status not in contract["phase_statuses"][phase]:
        raise ValueError("invalid organization phase transition")
    if reason_code not in contract["reason_codes"]:
        raise ValueError("invalid organization reason code")
    if artifact_status is not None and artifact_status != "held_previous":
        raise ValueError("invalid artifact status")
    updated = copy.deepcopy(run)
    updated["phases"][phase] = _phase(status, reason_code, artifact_status)
    updated["state"] = derive_overall_state(updated)
    return updated


def derive_overall_state(run):
    phases = run.get("phases", {})
    statuses = {name: value.get("status") for name, value in phases.items() if isinstance(value, dict)}
    if any(status == "safety_stopped" for status in statuses.values()):
        return "safety_stopped"
    if statuses.get("core") == "failed" or statuses.get("build") == "failed":
        return "failed"
    if statuses.get("core") not in {"completed", "not_required"}:
        return "core_running"
    incomplete = {
        "summary": {"partial", "failed", "batch_aborted", "stale"},
        "evidence": {"missing", "partial", "blocked"},
        "curation": {"pending_review", "failed", "stale"},
    }
    if any(statuses.get(phase) in values for phase, values in incomplete.items()):
        return "organization_partial"
    if statuses.get("build") != "succeeded":
        return "core_completed"
    if statuses.get("publish") == "failed":
        return "completed_with_warnings"
    if statuses.get("publish") in {"published", "unchanged"}:
        return "published"
    return "organization_ready"


def normalize_run_state(value):
    if value.get("state") == "completed":
        return {"schema_version": 2, "state": "completed_with_warnings", "reason_code": "unknown_legacy"}
    return value


def project_legacy_manual_state(value):
    run_id = str(value.get("batch") or "legacy-run")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", run_id):
        run_id = "legacy-run"
    run = new_run_state(run_id)
    legacy_state = value.get("state")
    # An earlier version recorded a stopped summary step as a failed run carrying only this text.
    old_halt = legacy_state == "failed" and value.get("error") == LEGACY_DIANDIAN_HALT_ERROR
    core_completed = (
        value.get("core_completed") is True
        or value.get("core_imported") is True
        or legacy_state == "completed"
        or old_halt
    )
    # A stop that hit before the core import finished belongs to the core phase; the summary was never reached.
    core_stopped = legacy_state == "safety-stopped" and not core_completed
    if core_stopped:
        run = transition_phase(run, "core", "safety_stopped", "safety_signal")
    else:
        failure_reason = "userscript_outdated" if value.get("userscript_outdated") is True else "contract_invalid"
        run = transition_phase(run, "core", "completed" if core_completed else ("running" if legacy_state in {"starting", "running"} else "failed"), "" if core_completed or legacy_state in {"starting", "running"} else failure_reason)
    captured = max(0, int(value.get("summarized", 0) or 0))
    failed = max(0, int(value.get("summary_failed", 0) or 0))
    aborted = max(0, int(value.get("summary_batch_aborted", 0) or 0))
    if not aborted and failed:
        aborted = max(0, int(value.get("summary_pending", 0) or 0))
    if core_stopped:
        pass
    elif legacy_state == "safety-stopped":
        run = transition_phase(run, "summary", "safety_stopped", "safety_signal")
    elif failed or (
        legacy_state == "failed"
        and core_completed
        and (value.get("summary_halt_reason") or old_halt)
    ):
        reason = "transport_failed" if old_halt or value.get("summary_halt_reason") in {"transport-failed", "transport_failed"} else "contract_invalid"
        if value.get("summary_halt_reason") == "userscript-outdated":
            reason = "userscript_outdated"
        run = transition_phase(run, "summary", "failed", reason)
    elif value.get("summary_finalizing") is True or value.get("summary_plan_pending") is True or value.get("summary_pending", 0):
        run = transition_phase(run, "summary", "running")
    elif aborted:
        run = transition_phase(
            run,
            "summary",
            "partial" if captured else "batch_aborted",
            "batch_aborted",
        )
    elif core_completed:
        run = transition_phase(run, "summary", "completed" if captured else "not_required")
    run["counts"].update({
        "scanned": max(0, int(value.get("scanned", 0) or 0)),
        "new": None if value.get("new", 0) is None else max(0, int(value.get("new", 0) or 0)),
        "summary_captured": captured,
        "summary_failed": failed,
        # Of the failed notes, how many DianDian refused to read and how many it answered incompletely.
        "summary_refused": max(0, int(value.get("diandian_refused", 0) or 0)),
        "summary_incomplete": max(0, int(value.get("diandian_incomplete", 0) or 0)),
        "summary_batch_aborted": aborted,
        "curation_accepted": max(0, int(value.get("curation_accepted", 0) or 0)),
        "curation_pending": max(0, int(value.get("curation_pending", 0) or 0)),
    })
    if core_completed:
        evidence_status = "missing" if failed or aborted else "ready"
        run = transition_phase(run, "evidence", evidence_status, "evidence_missing" if evidence_status == "missing" else "")
        failed_phase = value.get("finalize_failed_phase") if value.get("summary_finalize_error") else ""
        run = transition_phase(
            run, "curation",
            "failed" if failed_phase == "curation" else (
                "running" if value.get("summary_finalizing") is True else (
                    "validated" if value.get("build_version") and not run["counts"]["curation_pending"] else "pending_review"
                )
            ),
            "contract_invalid" if failed_phase == "curation" else (
                "" if value.get("summary_finalizing") is True or (
                    value.get("build_version") and not run["counts"]["curation_pending"]
                ) else "audit_pending"
            ),
        )
        build_version = value.get("build_version")
        if isinstance(build_version, str) and HASH.fullmatch(build_version):
            run["build_version"] = build_version
            run = transition_phase(run, "build", "succeeded")
        elif failed_phase == "build":
            run = transition_phase(run, "build", "failed", "build_failed", "held_previous")
        publish_status = value.get("publish_status")
        if publish_status in {"published", "unchanged"}:
            run = transition_phase(run, "publish", publish_status)
        elif publish_status == "failed" or failed_phase == "publish":
            run = transition_phase(run, "publish", "failed", "publish_failed", "held_previous")
    run["state"] = derive_overall_state(run)
    return safe_public_projection(run)


def project_local_rebuild_state(value):
    """Project a local-only rebuild: nothing was scanned or summarized, so those phases say so."""
    run_id = str(value.get("batch") or "local-rebuild")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", run_id):
        run_id = "local-rebuild"
    run = new_run_state(run_id)
    run = transition_phase(run, "core", "not_required")
    run = transition_phase(run, "summary", "not_required")
    running = value.get("state") == "running"
    current = value.get("phase")
    failed_phase = value.get("failed_phase") if value.get("state") == "failed" else ""
    accepted = max(0, int(value.get("curation_accepted", 0) or 0))
    pending = max(0, int(value.get("curation_pending", 0) or 0))
    run["counts"].update({"curation_accepted": accepted, "curation_pending": pending})
    if running and current == "curation":
        run = transition_phase(run, "curation", "running")
    elif failed_phase == "curation":
        run = transition_phase(run, "curation", "failed", "contract_invalid")
    elif current in {"build", "publish"} or value.get("build_version") or failed_phase in {"build", "publish"}:
        run = transition_phase(
            run, "curation", "pending_review" if pending else "validated",
            "audit_pending" if pending else "",
        )
    build_version = value.get("build_version")
    if isinstance(build_version, str) and HASH.fullmatch(build_version):
        run["build_version"] = build_version
        run = transition_phase(run, "build", "succeeded")
    elif running and current == "build":
        run = transition_phase(run, "build", "running")
    elif failed_phase == "build":
        run = transition_phase(run, "build", "failed", "build_failed", "held_previous")
    publish_status = value.get("publish_status")
    if publish_status in {"published", "unchanged"}:
        run = transition_phase(run, "publish", publish_status)
    elif publish_status == "failed" or failed_phase == "publish":
        run = transition_phase(run, "publish", "failed", "publish_failed", "held_previous")
    elif running and current == "publish":
        run = transition_phase(run, "publish", "running")
    run["state"] = derive_overall_state(run)
    return safe_public_projection(run)


def visible_copy_key(run):
    """The one sentence the workbench shows for this run, named by its key in the status contract."""
    phases = run.get("phases", {})

    def status(name):
        return phases.get(name, {}).get("status")

    local_rebuild = status("core") == "not_required"
    if run.get("state") == "safety_stopped":
        return "safety_stopped"
    if any(phase.get("reason_code") == "userscript_outdated" for phase in phases.values()):
        return "userscript_outdated"
    if local_rebuild and any(phase.get("status") == "running" for phase in phases.values()):
        return "local_rebuild_running"
    if status("core") == "not_started":
        return "core_not_started"
    if status("core") == "running":
        return "core_running"
    if status("core") == "failed":
        return "core_failed"
    if status("build") == "failed":
        return "build_failed"
    if status("publish") == "failed":
        return "publish_failed"
    if status("publish") == "unchanged":
        return "publish_unchanged"
    if status("summary") == "failed":
        return "summary_failed"
    if status("summary") == "batch_aborted":
        return "summary_batch_aborted"
    if status("evidence") in {"missing", "partial", "blocked"}:
        return "evidence_missing"
    if status("summary") == "not_started":
        return "summary_not_started"
    if local_rebuild:
        return "local_rebuild_ready"
    return "core_completed"


def visible_copy(run):
    return copy_text(visible_copy_key(run))


def copy_text(key):
    """The contract's wording for one sentence key; the text exists nowhere else."""
    return _contract()["copy"][key]


def new_note_state(note_id, content_sha256):
    if not isinstance(note_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", note_id) or not HASH.fullmatch(content_sha256):
        raise ValueError("invalid note state identity")
    return {
        "schema_version": 2, "note_id": note_id, "content_sha256": content_sha256, "evidence_sha256": "",
        "dimensions": {
            "core": _phase("saved"), "summary": _phase(), "evidence": _phase("missing", "evidence_missing"),
            "resource": _phase("not_applicable", "resource_not_applicable"), "curation": _phase(), "public": _phase("not_eligible"),
        },
    }


def transition_note_state(note, dimension, status, reason_code=""):
    contract = _contract()
    if dimension not in contract["note_statuses"] or status not in contract["note_statuses"][dimension] or reason_code not in contract["reason_codes"]:
        raise ValueError("invalid note state transition")
    updated = copy.deepcopy(note)
    updated["dimensions"][dimension] = _phase(status, reason_code)
    return updated


def apply_summary_batch_failure(notes, captured_ids, failed_id, reason_code):
    result = []
    failed_seen = False
    for note in notes:
        note_id = note["note_id"]
        if note_id in captured_ids:
            result.append(transition_note_state(note, "summary", "captured"))
        elif note_id == failed_id:
            failed_seen = True
            result.append(transition_note_state(note, "summary", "failed", reason_code))
        elif failed_seen:
            result.append(transition_note_state(note, "summary", "batch_aborted", "batch_aborted"))
        else:
            result.append(note)
    return result


def next_actions(context):
    if context.get("safety_stopped"):
        return []
    actions = []
    if context.get("cached_media"):
        actions.append("offline_evidence")
    if context.get("publish_enabled"):
        actions.append("publish")
    return actions


def resume_note_ids(statuses):
    return sorted(note_id for note_id, status in statuses.items() if status in {"failed", "batch_aborted", "stale"})


def revision_transitions(*, content_changed, evidence_changed, point_contract_changed):
    if content_changed:
        return {
            "summary": ("stale", "content_changed"),
            "curation": ("stale", "content_changed"),
            "resource": ("stale", "content_changed"),
        }
    transitions = {}
    if evidence_changed:
        transitions["curation"] = ("stale", "evidence_changed")
    if point_contract_changed:
        transitions["summary"] = ("stale", "provider_changed")
        transitions["curation"] = ("stale", "evidence_changed")
    return transitions


def safe_public_projection(run):
    allowed = {"schema_version", "run_id", "state", "build_version", "phases", "counts"}
    projection = {key: copy.deepcopy(value) for key, value in run.items() if key in allowed}
    projection["state"] = derive_overall_state(projection)
    projection["copy_key"] = visible_copy_key(projection)
    return projection


# --- The run record: the one writer -----------------------------------------------------------
#
# The stored run record is the staged state (phases, counts, the selected sentence) plus a private
# `bookkeeping` block holding the working fields the sync service reads to decide whether a call
# belongs to the current round. The service reports what happened as an event; this module applies
# it, advances the phases, and is the only code that writes the file. An old single-level record is
# converted when it is read and rewritten in the staged form only by the next event.

NOTE_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
BOOKKEEPING = "bookkeeping"
_EVENTS = {}


def _event(name):
    def register(handler):
        _EVENTS[name] = handler
        return handler
    return register


def _local_now():
    return datetime.now().astimezone().isoformat()


def add_known_count(total, addition):
    """Add two counts; once either is unknown (null) the total stays unknown."""
    if total is None or addition is None:
        return None
    return int(total or 0) + int(addition or 0)


def _live(working):
    return {"state": "idle"} if working is None else working


def _append_unique(working, key, value):
    values = working.get(key)
    if not isinstance(values, list):
        values = []
    if value in values:
        working[key] = values
        return False
    values.append(value)
    working[key] = values
    return True


def is_run_record(value):
    return isinstance(value, dict) and value.get("schema_version") == 2 and isinstance(value.get(BOOKKEEPING), dict)


def working_view(record):
    """The service's working fields as a private copy; an old single-level record is its own view."""
    if is_run_record(record):
        return copy.deepcopy(record[BOOKKEEPING])
    return copy.deepcopy(record) if isinstance(record, dict) else {"state": "idle"}


def _derive(working, local_rebuild=False):
    if local_rebuild or working.get("run_mode") == "local_rebuild":
        return project_local_rebuild_state(working)
    return project_legacy_manual_state(working)


def _build_record(working, previous=None):
    public = _derive(working)
    earlier = previous.get("phases") if is_run_record(previous) else None
    if isinstance(earlier, dict):
        for name, phase in public["phases"].items():
            old = earlier.get(name)
            if isinstance(old, dict) and all(old.get(key) == phase.get(key) for key in ("status", "reason_code", "artifact_status")):
                phase["updated_at"] = old.get("updated_at", phase["updated_at"])
    return {**public, BOOKKEEPING: copy.deepcopy(working)}


def public_status(record, local_rebuild=False):
    """What the status route may show: the staged state and the sentence key, never the bookkeeping."""
    if is_run_record(record):
        return safe_public_projection(record)
    return _derive(working_view(record), local_rebuild)


def apply_event(record, name, data=None):
    handler = _EVENTS.get(name)
    if handler is None:
        raise ValueError("unknown organization run event")
    working = None if record is None else working_view(record)
    return _build_record(handler(working, **(data or {})), previous=record)


def read_text_waiting(path, encoding="utf-8-sig"):
    """Read a file, waiting briefly while Windows refuses it because it is being swapped or held.

    Only a `PermissionError` is waited on; a missing file and every other failure are raised at once,
    and so is the refusal itself once the wait is over.
    """
    deadline = None  # the clock is only read once a read has actually been refused
    while True:
        try:
            return Path(path).read_text(encoding=encoding)
        except PermissionError:
            now = time.monotonic()
            deadline = now + FILE_CLASH_WAIT_SECONDS if deadline is None else deadline
            if now >= deadline:
                raise
            time.sleep(0.01)


def load_record(path):
    """The record for a read-only look: anything that cannot be read, even after the wait, is no record."""
    try:
        value = json.loads(read_text_waiting(path))
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _load_record_to_update(path):
    """The record an event is about to be applied to. Absent is None; present but unreadable raises."""
    try:
        text = read_text_waiting(path)
    except FileNotFoundError:
        return None
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def report_event(path, name, data, write):
    """Apply one event to the record at `path` and store it with `write` (the caller's atomic writer).

    A record that exists but cannot be read raises instead of being rebuilt from nothing: the write
    would otherwise replace a whole round with the fields of this one event.
    """
    updated = apply_event(_load_record_to_update(path), name, data)
    write(path, updated)
    return updated


def snapshot_record(path):
    path = Path(path)
    return path.read_bytes() if path.exists() else None


def restore_record(path, snapshot, restore):
    """Put the record back exactly as `snapshot_record` saw it, using the caller's restoring writer."""
    restore(path, snapshot)


def discard_record(path):
    Path(path).unlink(missing_ok=True)


def _apply_core_result(working, core):
    core = core or {"next_board_id": None}
    working["summary_plan_pending"] = False
    if core.get("publish_status") is not None:
        working["publish_status"] = core["publish_status"]
    if core.get("next_board_id") is None:
        working.update({
            "state": "completed",
            "completed_at": core.get("completed_at") or _local_now(),
            "current_board": "",
        })
        return
    processed = working.get("processed_run_ids")
    if not isinstance(processed, list) or core.get("next_run_id") not in processed:
        working.update({"state": "running", "current_board": core.get("next_board_name", "")})
        working.pop("completed_at", None)


@_event("round_started")
def _round_started(_working, *, batch, started_at, run_board_ids, mode, requested_board_ids=None, target_note_id=None):
    working = {
        "batch": batch,
        "state": "starting",
        "started_at": started_at,
        "board_count": len(run_board_ids),
        "processed_boards": 0,
        "current_board": "正在刷新收藏夹",
        "scanned": 0,
        "new": 0,
        "summarized": 0,
        "summary_total": 0,
        "summary_pending": 0,
        "summary_failed": 0,
        "summary_batch_aborted": 0,
        "share_link_missing": 0,
        "share_link_missing_reasons": {},
        **{counter: 0 for counter in UNUSABLE_REPLY_COUNTERS.values()},
        "summary_plan_pending": False,
        "summary_finalizing": False,
        "processed_run_ids": [],
        "run_board_ids": list(run_board_ids),
        "run_mode": mode,
    }
    if requested_board_ids is not None:
        working["requested_board_ids"] = list(requested_board_ids)
    if target_note_id is not None:
        working["target_note_id"] = target_note_id
        working["local_only"] = True
    return working


@_event("run_page_opened")
def _run_page_opened(working, *, page_id):
    """The one browser page the round works in. Bookkeeping only: it never reaches the status."""
    working = _live(working)
    working["run_page_id"] = page_id
    return working


@_event("run_page_closed")
def _run_page_closed(working, *, page_id):
    working = _live(working)
    if working.get("run_page_id") == page_id:
        working.pop("run_page_id")
    return working


@_event("start_failed")
def _start_failed(working, *, error, completed_at=None):
    working = _live(working)
    working.update({"state": "failed", "completed_at": completed_at or _local_now(), "error": error})
    return working


@_event("run_expired")
def _run_expired(working, *, error, halted_run_ids, pending=0, completed_at=None):
    working = _live(working)
    working.update({
        "state": "failed",
        "completed_at": completed_at or _local_now(),
        "error": error,
        "summary_pending": 0,
        "summary_plan_pending": False,
        "summary_finalizing": False,
        "summary_halted_run_ids": list(halted_run_ids),
    })
    if pending:
        working["summary_batch_aborted"] = int(working.get("summary_batch_aborted", 0) or 0) + pending
    return working


@_event("boards_discovered")
def _boards_discovered(working, *, run_board_ids, board_name):
    working = _live(working)
    working.update({
        "state": "running",
        "board_count": len(run_board_ids),
        "current_board": board_name,
        "run_board_ids": list(run_board_ids),
    })
    return working


@_event("single_note_scope_confirmed")
def _single_note_scope_confirmed(working, *, board_name):
    working = _live(working)
    working.update({"state": "running", "board_count": 1, "current_board": board_name})
    return working


@_event("board_started")
def _board_started(working, *, board_name):
    working = _live(working)
    working.update({"state": "running", "current_board": board_name, "summary_plan_pending": False})
    return working


@_event("board_imported")
def _board_imported(
    working, *, run_id, board_id, board_name, outcome, scanned=0, new=0, note_ids=None,
    completed_at=None, error="", summary_pending=False, summary_plan_pending=False,
    diandian_enabled=False, config_sha256="", core=None,
):
    """One board's core import finished with `outcome` ("completed", "failed" or "safety-stopped")."""
    working = _live(working)
    processed = working.get("processed_run_ids")
    if not isinstance(processed, list):
        processed = []
    processed.append(run_id)
    working["scanned"] = int(working.get("scanned", 0) or 0) + int(scanned or 0)
    working["new"] = add_known_count(working.get("new", 0), new)
    working["processed_run_ids"] = processed
    working["processed_boards"] = len(processed)
    all_processed = len(processed) == len(working.get("run_board_ids", []))
    if isinstance(note_ids, list) and all(isinstance(note_id, str) and NOTE_ID.fullmatch(note_id) for note_id in note_ids):
        board_note_ids = working.get("board_note_ids") if isinstance(working.get("board_note_ids"), dict) else {}
        board_note_ids[board_id] = sorted(set(note_ids))
        working["board_note_ids"] = board_note_ids
        if all_processed:
            sealed = sorted({note_id for values in board_note_ids.values() for note_id in values})
            working["frozen_scope"] = {
                "note_ids": sealed,
                "mode": working.get("run_mode", "incremental"),
                "local_only": working.get("local_only") is True,
                "config_sha256": config_sha256() if callable(config_sha256) else config_sha256,
            }
    working["summary_plan_pending"] = bool(summary_plan_pending)
    if outcome == "failed":
        working.update({
            "state": "failed",
            "completed_at": completed_at or _local_now(),
            "error": error,
            "summary_plan_pending": False,
        })
    elif outcome == "safety-stopped":
        working.update({
            "state": "safety-stopped",
            "completed_at": completed_at or _local_now(),
            "error": error,
            "current_board": "",
            "summary_plan_pending": False,
        })
    elif outcome == "completed":
        # The last board's import is the end of the core phase, whatever follows it.
        if all_processed:
            working["core_imported"] = True
        if summary_pending or summary_plan_pending:
            if summary_plan_pending and diandian_enabled:
                step = "等待点点 AI 计划"
            elif summary_plan_pending:
                step = "正在完成本轮整理"
            else:
                step = "点点 AI 深度整理"
            working.update({"state": "running", "current_board": f"{board_name}：{step}"})
        else:
            _apply_core_result(working, core)
    return working


@_event("summary_planned")
def _summary_planned(working, *, run_id, board_name, planned):
    working = _live(working)
    working["summary_total"] = int(working.get("summary_total", 0) or 0) + planned
    working["summary_pending"] = planned
    working["summary_plan_pending"] = False
    working["summary_finalizing"] = False
    working.pop("summary_finalize_error", None)
    _append_unique(working, "summary_plan_resolved_run_ids", run_id)
    if planned:
        working.update({"state": "running", "current_board": f"{board_name}：点点 AI 深度整理"})
        working.pop("completed_at", None)
    return working


@_event("summary_plan_empty")
def _summary_plan_empty(working, *, run_id, abandoned, already_abandoned, pending_count, core=None):
    """The run's summary plan holds nothing (more) to do; `core` is set when the core result is applied here."""
    working = _live(working)
    if abandoned:
        _append_unique(working, "summary_plan_abandoned_run_ids", run_id)
    if abandoned and pending_count and not already_abandoned:
        working["summary_batch_aborted"] = int(working.get("summary_batch_aborted", 0) or 0) + pending_count
    _append_unique(working, "summary_plan_resolved_run_ids", run_id)
    working.update({"summary_plan_pending": False, "summary_pending": 0, "summary_finalizing": False})
    if core is not None:
        _apply_core_result(working, core)
    return working


@_event("summary_progress")
def _summary_progress(
    working, *, summarized_delta=0, failed_delta=0, pending=0, share_link_missing_reason=None,
    unusable_reply_reason=None,
):
    """`share_link_missing_reason` names why a note's share link was not copied; that note is counted as
    failed too (the caller passes `failed_delta`), and the record keeps the count and the reasons.
    `unusable_reply_reason` is one of UNUSABLE_REPLY_COUNTERS: DianDian refused to read the note or its
    reply lost text; the record keeps a count for each."""
    working = _live(working)
    working["summarized"] = int(working.get("summarized", 0) or 0) + summarized_delta
    working["summary_failed"] = int(working.get("summary_failed", 0) or 0) + failed_delta
    working["summary_pending"] = pending
    if unusable_reply_reason is not None:
        counter = UNUSABLE_REPLY_COUNTERS[unusable_reply_reason]
        working[counter] = int(working.get(counter, 0) or 0) + 1
    if share_link_missing_reason is not None:
        working["share_link_missing"] = int(working.get("share_link_missing", 0) or 0) + 1
        reasons = working.get("share_link_missing_reasons")
        reasons = dict(reasons) if isinstance(reasons, dict) else {}
        reasons[share_link_missing_reason] = int(reasons.get(share_link_missing_reason, 0) or 0) + 1
        working["share_link_missing_reasons"] = reasons
    return working


@_event("summary_halted")
def _summary_halted(working, *, run_id, safety, reason, attempted, remaining, error, completed_at=None):
    working = _live(working)
    halted = working.get("summary_halted_run_ids")
    halted = list(halted) if isinstance(halted, list) else []
    if run_id not in halted:
        halted.append(run_id)
        working["summary_failed"] = int(working.get("summary_failed", 0) or 0) + attempted
        working["summary_batch_aborted"] = int(working.get("summary_batch_aborted", 0) or 0) + remaining
    working.update({
        "state": "safety-stopped" if safety else "failed",
        "completed_at": completed_at or _local_now(),
        "current_board": "",
        "summary_pending": 0,
        "summary_plan_pending": False,
        "summary_finalizing": False,
        "summary_halted_run_ids": halted,
        "core_completed": True,
        "error": error,
    })
    if not safety:
        working["summary_halt_reason"] = reason
    return working


@_event("safety_halt_confirmed")
def _safety_halt_confirmed(working, *, error):
    working = _live(working)
    working.update({"state": "safety-stopped", "core_completed": True, "error": error})
    working.pop("summary_halt_reason", None)
    return working


@_event("round_failed")
def _round_failed(working, *, safety, error, remaining=0, completed_at=None):
    working = _live(working)
    working.update({
        "state": "safety-stopped" if safety else "failed",
        "completed_at": completed_at or _local_now(),
        "error": error,
        "summary_plan_pending": False,
    })
    if remaining:
        working["summary_batch_aborted"] = int(working.get("summary_batch_aborted", 0) or 0) + remaining
        working["summary_pending"] = 0
    return working


@_event("userscript_outdated")
def _userscript_outdated(working, *, error, completed_at=None):
    """The scan browser's installed user script speaks an older protocol; the round stops before importing."""
    working = _live(working)
    working.update({
        "state": "failed",
        "completed_at": completed_at or _local_now(),
        "error": error,
        "userscript_outdated": True,
        "summary_plan_pending": False,
    })
    return working


@_event("finalization_started")
def _finalization_started(working, *, board_name):
    working = _live(working)
    working.update({
        "state": "running",
        "current_board": f"{board_name}：正在更新点点 AI 结果",
        "summary_plan_pending": False,
        "summary_finalizing": True,
    })
    working.pop("summary_finalize_error", None)
    return working


@_event("finalization_finished")
def _finalization_finished(
    working, *, error="", failed_phase="build", build_version=None, site_manifest_sha256=None,
    curation_counts=None, completed=False, completed_at=None, board_name="", next_board_id="",
    next_run_id="", next_board_name="下一个收藏夹", publish_status=None, publish_warning=None,
):
    working = _live(working)
    working["summary_finalizing"] = False
    working["summary_plan_pending"] = False
    if error:
        working["summary_finalize_error"] = error
        working["finalize_failed_phase"] = failed_phase or "build"
        working.update({"state": "failed", "completed_at": _local_now(), "current_board": ""})
    else:
        working.pop("summary_finalize_error", None)
        working.pop("finalize_failed_phase", None)
    if isinstance(build_version, str) and HASH.fullmatch(build_version):
        working["build_version"] = build_version
    if isinstance(site_manifest_sha256, str) and HASH.fullmatch(site_manifest_sha256):
        working["site_manifest_sha256"] = site_manifest_sha256
    if isinstance(curation_counts, dict):
        working["curation_accepted"] = max(0, int(curation_counts.get("accepted", 0) or 0))
        working["curation_pending"] = max(0, int(curation_counts.get("pending", 0) or 0))
    if not error and completed:
        if not next_board_id:
            working.update({
                "state": "completed",
                "completed_at": completed_at or _local_now(),
                "current_board": "",
            })
        else:
            processed = working.get("processed_run_ids")
            if (
                (not isinstance(processed, list) or next_run_id not in processed)
                and working.get("state") != "completed"
                and str(working.get("current_board", "")).startswith(board_name)
            ):
                working.update({"state": "running", "current_board": next_board_name})
    if publish_status is not None:
        working["publish_status"] = publish_status
        if publish_warning == "bridge_status_write_failed":
            working["publish_status_warning"] = publish_warning
    return working


@_event("publish_claimed")
def _publish_claimed(working, *, build_version, site_manifest_sha256):
    working = _live(working)
    working.update({
        "build_version": build_version,
        "site_manifest_sha256": site_manifest_sha256,
        "publish_claimed_build_version": build_version,
        "publish_claimed_site_manifest_sha256": site_manifest_sha256,
        "publish_status": "running",
    })
    working.pop("publish_error", None)
    return working


@_event("publish_outcome_unknown")
def _publish_outcome_unknown(working):
    working = _live(working)
    working["publish_status"] = "failed"
    working["publish_error"] = "previous publish outcome is unknown; automatic retry withheld"
    return working


@_event("publish_recorded")
def _publish_recorded(working, *, status, build_version, site_manifest_sha256, error=""):
    working = _live(working)
    working["publish_status"] = status
    if status in {"published", "unchanged"}:
        working["published_build_version"] = build_version
        working["published_site_manifest_sha256"] = site_manifest_sha256
        working.pop("publish_error", None)
    else:
        working["publish_error"] = error
    return working


def _owned_rebuild(working, batch):
    if working is None or working.get("batch") != batch:
        raise ValueError("local rebuild no longer owns this record")
    working.setdefault("run_mode", "local_rebuild")
    return working


@_event("rebuild_started")
def _rebuild_started(_working, *, batch, started_at, note_ids):
    return {
        "batch": batch,
        "state": "running",
        "run_mode": "local_rebuild",
        "started_at": started_at,
        "phase": "curation",
        "note_ids": list(note_ids),
    }


@_event("rebuild_claimed")
def _rebuild_claimed(working, *, batch):
    working = _owned_rebuild(working, batch)
    working["work_claimed"] = True
    return working


@_event("rebuild_phase")
def _rebuild_phase(working, *, batch, phase, curation_accepted=None, curation_pending=None):
    working = _owned_rebuild(working, batch)
    working["phase"] = phase
    if curation_accepted is not None:
        working["curation_accepted"] = curation_accepted
    if curation_pending is not None:
        working["curation_pending"] = curation_pending
    return working


@_event("rebuild_publish_claimed")
def _rebuild_publish_claimed(working, *, batch, build_version):
    working = _owned_rebuild(working, batch)
    working.update({"publish_claimed_build_version": build_version, "publish_status": "running"})
    return working


@_event("rebuild_publish_finished")
def _rebuild_publish_finished(working, *, batch, status, error=""):
    working = _owned_rebuild(working, batch)
    working["publish_status"] = status
    if status == "failed":
        working["publish_error"] = error
    return working


@_event("rebuild_completed")
def _rebuild_completed(
    working, *, batch, build_version, site_manifest_sha256, completed_at=None,
    curation_accepted=None, curation_pending=None,
):
    working = _owned_rebuild(working, batch)
    working.update({
        "state": "completed",
        "completed_at": completed_at or _local_now(),
        "build_version": build_version,
        "site_manifest_sha256": site_manifest_sha256,
    })
    if curation_accepted is not None:
        working["curation_accepted"] = curation_accepted
    if curation_pending is not None:
        working["curation_pending"] = curation_pending
    return working


@_event("rebuild_failed")
def _rebuild_failed(working, *, batch, failed_phase, error, completed_at=None):
    working = _owned_rebuild(working, batch)
    working.update({
        "state": "failed",
        "completed_at": completed_at or _local_now(),
        "failed_phase": failed_phase,
        "error": error,
    })
    return working
