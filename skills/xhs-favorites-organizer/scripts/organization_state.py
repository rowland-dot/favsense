"""Versioned, privacy-safe organization run and note state reducer."""

from __future__ import annotations

import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import re


CONTRACT_PATH = Path(__file__).parents[3] / "site" / "organization-status-contract.json"
HASH = re.compile(r"^[a-f0-9]{64}$")


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
        "counts": {"scanned": 0, "new": 0, "summary_captured": 0, "summary_failed": 0, "summary_batch_aborted": 0, "curation_accepted": 0, "curation_pending": 0},
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
    if statuses.get("core") != "completed":
        return "core_completed"
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
    core_completed = value.get("core_completed") is True or legacy_state == "completed"
    run = transition_phase(run, "core", "completed" if core_completed else ("running" if legacy_state in {"starting", "running"} else "failed"), "" if core_completed or legacy_state in {"starting", "running"} else "contract_invalid")
    captured = max(0, int(value.get("summarized", 0) or 0))
    failed = max(0, int(value.get("summary_failed", 0) or 0))
    aborted = max(0, int(value.get("summary_pending", 0) or 0)) if failed else 0
    if legacy_state == "safety-stopped":
        run = transition_phase(run, "summary", "safety_stopped", "safety_signal")
    elif failed:
        reason = "transport_failed" if value.get("summary_halt_reason") in {"transport-failed", "transport_failed"} else "contract_invalid"
        run = transition_phase(run, "summary", "failed", reason)
    elif value.get("summary_plan_pending") is True or value.get("summary_pending", 0):
        run = transition_phase(run, "summary", "running")
    elif core_completed:
        run = transition_phase(run, "summary", "completed" if captured else "not_required")
    run["counts"].update({
        "scanned": max(0, int(value.get("scanned", 0) or 0)),
        "new": max(0, int(value.get("new", 0) or 0)),
        "summary_captured": captured,
        "summary_failed": failed,
        "summary_batch_aborted": aborted,
    })
    if core_completed:
        evidence_status = "missing" if failed or aborted else "ready"
        run = transition_phase(run, "evidence", evidence_status, "evidence_missing" if evidence_status == "missing" else "")
        run = transition_phase(run, "curation", "pending_review", "audit_pending")
    run["state"] = derive_overall_state(run)
    return safe_public_projection(run)


def visible_copy(run):
    contract = _contract()["copy"]
    phases = run.get("phases", {})
    if run.get("state") == "safety_stopped":
        return contract["safety_stopped"]
    if phases.get("build", {}).get("status") == "failed":
        return contract["build_failed"]
    if phases.get("publish", {}).get("status") == "failed":
        return contract["publish_failed"]
    if phases.get("publish", {}).get("status") == "unchanged":
        return contract["publish_unchanged"]
    return contract["core_completed"]


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
    return projection
