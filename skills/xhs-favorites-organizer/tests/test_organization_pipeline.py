import importlib.util
import hashlib
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock


SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "organization_state.py"
BRIDGE_SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "bridge-server.py"


def load_state_module():
    spec = importlib.util.spec_from_file_location("organization_state", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_bridge_module():
    spec = importlib.util.spec_from_file_location("organization_bridge", BRIDGE_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OrganizationPipelineTests(unittest.TestCase):
    def test_core_not_started_and_running_are_not_reported_as_completed(self):
        state = load_state_module()
        run = state.new_run_state("fixture-run")
        self.assertEqual(run["state"], "failed")
        self.assertEqual(state.visible_copy(run), "核心收藏尚未保存")
        run = state.transition_phase(run, "core", "running")
        self.assertEqual(run["state"], "failed")
        self.assertEqual(state.visible_copy(run), "正在保存核心收藏")
        run = state.transition_phase(run, "summary", "failed", "transport_failed")
        self.assertEqual(run["state"], "failed")
        self.assertNotEqual(state.visible_copy(run), "核心收藏已保存")

    def test_legacy_finalization_projects_a_running_phase_until_build_finishes(self):
        state = load_state_module()
        projected = state.project_legacy_manual_state({
            "batch": "fixture-run", "state": "completed", "core_completed": True,
            "summary_finalizing": True, "summarized": 1,
        })
        self.assertEqual(projected["phases"]["summary"]["status"], "running")
        self.assertEqual(projected["state"], "core_completed")

    def test_aborted_only_and_partially_captured_batches_remain_visible(self):
        state = load_state_module()
        aborted = state.project_legacy_manual_state({
            "batch": "fixture-run", "state": "failed", "core_completed": True,
            "summary_batch_aborted": 2,
        })
        self.assertEqual(aborted["phases"]["summary"]["status"], "batch_aborted")
        self.assertEqual(aborted["phases"]["summary"]["reason_code"], "batch_aborted")

        partial = state.project_legacy_manual_state({
            "batch": "fixture-run", "state": "failed", "core_completed": True,
            "summarized": 1, "summary_batch_aborted": 2,
        })
        self.assertEqual(partial["phases"]["summary"]["status"], "partial")
        self.assertEqual(partial["counts"]["summary_captured"], 1)

    def test_legacy_completed_is_not_full_success(self):
        state = load_state_module()
        projected = state.normalize_run_state({"state": "completed"})
        self.assertEqual(projected["state"], "completed_with_warnings")
        self.assertEqual(projected["reason_code"], "unknown_legacy")

    def test_finalizer_build_and_publish_outcomes_are_projected_truthfully(self):
        state = load_state_module()
        build_failed = state.project_legacy_manual_state({
            "batch": "fixture-run", "state": "failed", "core_completed": True,
            "summary_finalize_error": "synthetic failure", "finalize_failed_phase": "build",
        })
        self.assertEqual(build_failed["state"], "failed")
        self.assertEqual(build_failed["phases"]["build"]["status"], "failed")
        self.assertEqual(build_failed["phases"]["build"]["artifact_status"], "held_previous")

        publish_failed = state.project_legacy_manual_state({
            "batch": "fixture-run", "state": "failed", "core_completed": True,
            "build_version": "a" * 64, "summary_finalize_error": "synthetic failure",
            "finalize_failed_phase": "publish",
        })
        self.assertEqual(publish_failed["state"], "completed_with_warnings")
        self.assertEqual(publish_failed["phases"]["build"]["status"], "succeeded")
        self.assertEqual(publish_failed["phases"]["publish"]["status"], "failed")

        unchanged = state.project_legacy_manual_state({
            "batch": "fixture-run", "state": "completed", "core_completed": True,
            "build_version": "b" * 64, "publish_status": "unchanged",
        })
        self.assertEqual(unchanged["state"], "published")
        self.assertEqual(unchanged["phases"]["publish"]["status"], "unchanged")

    def test_build_failure_prevents_complete_success_copy(self):
        state = load_state_module()
        run = state.new_run_state("fixture-run")
        run = state.transition_phase(run, "core", "completed")
        run = state.transition_phase(run, "summary", "completed")
        run = state.transition_phase(run, "evidence", "ready")
        run = state.transition_phase(run, "curation", "validated")
        run = state.transition_phase(run, "build", "failed", reason_code="build_failed", artifact_status="held_previous")
        self.assertEqual(state.derive_overall_state(run), "failed")
        self.assertEqual(state.visible_copy(run), "构建失败，已保留上一版")

    def test_failed_current_and_unattempted_remainder_are_distinct(self):
        state = load_state_module()
        notes = [state.new_note_state(item, "a" * 64) for item in ["one", "two", "three"]]
        result = state.apply_summary_batch_failure(notes, captured_ids=["one"], failed_id="two", reason_code="transport_failed")
        self.assertEqual([item["dimensions"]["summary"]["status"] for item in result], ["captured", "failed", "batch_aborted"])

    def test_safety_stop_suppresses_fallback_build_and_publish(self):
        state = load_state_module()
        decision = state.next_actions({"safety_stopped": True, "cached_media": True, "publish_enabled": True})
        self.assertEqual(decision, [])

    def test_resume_selects_only_failed_aborted_or_stale(self):
        state = load_state_module()
        statuses = {"a": "captured", "b": "failed", "c": "batch_aborted", "d": "stale", "e": "not_started"}
        self.assertEqual(state.resume_note_ids(statuses), ["b", "c", "d"])

    def test_bridge_stops_the_point_batch_before_dispatching_transport_fallback(self):
        bridge_module = load_bridge_module()
        bridge = bridge_module.Bridge.__new__(bridge_module.Bridge)
        events = []
        bridge.halt_diandian_cdp_run = lambda *args, **kwargs: (
            events.append("halt") or {"halted": True, "reason": "transport-failed"}
        )
        bridge.fallback_safety_stopped = lambda: False
        bridge.dispatch_evidence_fallback = lambda note_id, reason, **kwargs: (
            events.append("fallback") or {"dispatched": True, "reason_code": "fallback_ready"}
        )

        result = bridge.halt_diandian_transport_failure(
            "run", "board", failed_note_id="a" * 24
        )

        self.assertEqual(events, ["halt", "fallback"])
        self.assertEqual(result, {"halted": True, "reason": "transport-failed"})

    def test_bridge_does_not_dispatch_fallback_after_a_safety_halt_wins(self):
        bridge_module = load_bridge_module()
        bridge = bridge_module.Bridge.__new__(bridge_module.Bridge)
        bridge.halt_diandian_cdp_run = mock.Mock(return_value={
            "halted": True,
            "reason": bridge_module.DIANDIAN_SAFETY_STOP_REASON,
        })
        bridge.dispatch_evidence_fallback = mock.Mock()

        result = bridge.halt_diandian_transport_failure(
            "run", "board", failed_note_id="a" * 24
        )

        self.assertEqual(result["reason"], bridge_module.DIANDIAN_SAFETY_STOP_REASON)
        bridge.dispatch_evidence_fallback.assert_not_called()

    def test_bridge_fallback_receives_a_durable_safety_cancellation_probe(self):
        bridge_module = load_bridge_module()
        bridge = bridge_module.Bridge.__new__(bridge_module.Bridge)
        bridge.halt_diandian_cdp_run = mock.Mock(return_value={
            "halted": True,
            "reason": "transport-failed",
        })
        bridge.fallback_safety_stopped = mock.Mock(
            side_effect=[False, True]
        )

        def dispatch(note_id, reason, *, cancelled):
            self.assertEqual(note_id, "a" * 24)
            self.assertEqual(reason, "transport-failed")
            self.assertTrue(cancelled())
            return {"dispatched": False, "reason_code": "safety_stopped"}

        bridge.dispatch_evidence_fallback = mock.Mock(side_effect=dispatch)

        bridge.halt_diandian_transport_failure(
            "run", "board", failed_note_id="a" * 24
        )

        bridge.dispatch_evidence_fallback.assert_called_once()

    def test_bridge_fallback_cancellation_probe_observes_the_media_safety_marker(self):
        bridge_module = load_bridge_module()
        with tempfile.TemporaryDirectory() as temporary:
            bridge = bridge_module.Bridge.__new__(bridge_module.Bridge)
            bridge.state_dir = pathlib.Path(temporary)
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.manual_sync_path.write_text(
                json.dumps({"state": "failed"}), encoding="utf-8"
            )

            self.assertFalse(bridge.fallback_safety_stopped())
            (bridge.state_dir / "media-download-safety-stop.json").write_text(
                "{}", encoding="utf-8"
            )
            self.assertTrue(bridge.fallback_safety_stopped())

    def test_client_transport_halt_routes_through_the_offline_fallback_boundary(self):
        bridge_module = load_bridge_module()
        bridge = bridge_module.Bridge.__new__(bridge_module.Bridge)
        bridge.get_manual_sync_lock = mock.Mock(
            return_value=bridge_module.nullcontext()
        )
        bridge.read_manual_sync = mock.Mock(return_value={
            "batch": "manual",
            "state": "running",
        })
        bridge.manual_state_owns_run = mock.Mock(return_value=True)
        bridge.validate_manual_board_run = mock.Mock()
        bridge.halt_diandian_transport_failure = mock.Mock(return_value={
            "halted": True,
            "reason": "transport-failed",
        })
        bridge.halt_diandian_cdp_run = mock.Mock()
        note_id = "a" * 24

        result = bridge.halt_diandian_run({
            "run_id": "manual_board",
            "board_id": "board",
            "reason": "transport-failed",
            "note_id": note_id,
        })

        self.assertEqual(result["reason"], "transport-failed")
        bridge.halt_diandian_transport_failure.assert_called_once_with(
            "manual_board", "board", failed_note_id=note_id
        )
        bridge.halt_diandian_cdp_run.assert_not_called()

    def test_bridge_dispatches_only_cached_offline_video_for_transport_failure(self):
        bridge_module = load_bridge_module()
        with tempfile.TemporaryDirectory() as temporary:
            workspace = pathlib.Path(temporary)
            bridge = bridge_module.Bridge.__new__(bridge_module.Bridge)
            note_id = "a" * 24
            bridge.workspace = workspace
            bridge.state_dir = workspace / ".xhs-favorites"
            bridge.media_dir = bridge.state_dir / "media"
            bridge.media_dir.mkdir(parents=True)
            (bridge.media_dir / f"{note_id}.mp4").write_bytes(b"cached")
            bridge.config_path = workspace / "config.json"
            bridge.config_path.write_text("{}", encoding="utf-8")
            bridge.video_analysis_enabled = True
            bridge.image_ocr_enabled = False
            bridge.video_analysis_runner = workspace / "run-video-analysis.ps1"
            bridge.video_analysis_runner.write_text("", encoding="utf-8")
            bridge.powershell = workspace / "powershell.exe"
            bridge.powershell.write_bytes(b"tool")
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge._summary_report_lock = __import__("threading").RLock()
            bridge.trusted_content_sha256 = lambda candidate: "b" * 64
            transcript = bridge.state_dir / "video-analysis" / note_id / "transcription.json"
            transcript_text = "可信的本地转写正文"

            def run_offline(command, **kwargs):
                self.assertEqual(kwargs["input_text"], "")
                transcript.parent.mkdir(parents=True)
                transcript.write_text(json.dumps({
                    "schema_version": 1,
                    "status": "transcribed",
                    "method": "local_transcription",
                    "provider": "faster-whisper",
                    "tool_version": "fixture",
                    "content_sha256": "b" * 64,
                    "result_sha256": hashlib.sha256(
                        transcript_text.encode("utf-8")
                    ).hexdigest(),
                    "text": transcript_text,
                }), encoding="utf-8")
                self.assertIn(note_id, command)
                return subprocess.CompletedProcess(command, 0, "{}", "")

            with mock.patch.object(
                bridge_module, "run_bounded_subprocess", side_effect=run_offline
            ) as runner:
                result = bridge.dispatch_evidence_fallback(note_id, "transport-failed")

            runner.assert_called_once()
            self.assertEqual(result["evidence_status"], "ready")
            self.assertEqual(result["curation_status"], "pending_review")
            self.assertEqual(result["methods"], ["audio_transcript"])

    def test_bridge_rejects_tampered_or_reparse_cached_evidence(self):
        bridge_module = load_bridge_module()
        with tempfile.TemporaryDirectory() as temporary:
            workspace = pathlib.Path(temporary)
            bridge = bridge_module.Bridge.__new__(bridge_module.Bridge)
            note_id = "a" * 24
            bridge.workspace = workspace
            bridge.state_dir = workspace / ".xhs-favorites"
            bridge.media_dir = bridge.state_dir / "media"
            bridge.media_dir.mkdir(parents=True)
            video = bridge.media_dir / f"{note_id}.mp4"
            video.write_bytes(b"cached")
            bridge.config_path = workspace / "config.json"
            bridge.config_path.write_text("{}", encoding="utf-8")
            bridge.video_analysis_enabled = True
            bridge.image_ocr_enabled = False
            bridge.video_analysis_runner = workspace / "run-video-analysis.ps1"
            bridge.video_analysis_runner.write_text("", encoding="utf-8")
            bridge.powershell = workspace / "powershell.exe"
            bridge.powershell.write_bytes(b"tool")
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge._summary_report_lock = __import__("threading").RLock()
            bridge.trusted_content_sha256 = lambda candidate: "b" * 64
            transcript = bridge.state_dir / "video-analysis" / note_id / "transcription.json"

            def write_tampered_artifact(command, **kwargs):
                transcript.parent.mkdir(parents=True)
                transcript.write_text(json.dumps({
                    "schema_version": 1,
                    "status": "transcribed",
                    "method": "local_transcription",
                    "provider": "faster-whisper",
                    "tool_version": "fixture",
                    "content_sha256": "b" * 64,
                    "result_sha256": "c" * 64,
                    "text": "正文与结果哈希不匹配",
                }), encoding="utf-8")
                return subprocess.CompletedProcess(command, 0, "{}", "")

            with mock.patch.object(
                bridge_module,
                "run_bounded_subprocess",
                side_effect=write_tampered_artifact,
            ):
                tampered = bridge.dispatch_evidence_fallback(
                    note_id, "transport-failed"
                )
            self.assertEqual(tampered["evidence_status"], "missing")
            self.assertEqual(tampered["methods"], [])

            with (
                mock.patch.object(
                    bridge_module,
                    "path_is_reparse_point",
                    side_effect=lambda path: pathlib.Path(path) == video,
                ),
                mock.patch.object(bridge_module, "run_bounded_subprocess") as runner,
            ):
                reparse = bridge.dispatch_evidence_fallback(
                    note_id, "transport-failed"
                )
            runner.assert_not_called()
            self.assertEqual(reparse["reason_code"], "evidence_missing")

            with (
                mock.patch.object(
                    bridge_module,
                    "path_is_reparse_point",
                    side_effect=lambda path: pathlib.Path(path) == bridge.media_dir,
                ),
                mock.patch.object(bridge_module, "run_bounded_subprocess") as runner,
            ):
                redirected_directory = bridge.dispatch_evidence_fallback(
                    note_id, "transport-failed"
                )
            runner.assert_not_called()
            self.assertEqual(
                redirected_directory["reason_code"], "evidence_missing"
            )

            with (
                mock.patch.object(
                    bridge_module,
                    "path_is_reparse_point",
                    side_effect=lambda path: pathlib.Path(path)
                    == bridge.video_analysis_runner,
                ),
                mock.patch.object(bridge_module, "run_bounded_subprocess") as runner,
            ):
                redirected_runner = bridge.dispatch_evidence_fallback(
                    note_id, "transport-failed"
                )
            runner.assert_not_called()
            self.assertEqual(
                redirected_runner["reason_code"], "evidence_tool_unavailable"
            )

    def test_bridge_safety_or_non_transport_failure_never_dispatches_fallback(self):
        bridge_module = load_bridge_module()
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = pathlib.Path(temporary)
            bridge = bridge_module.Bridge.__new__(bridge_module.Bridge)
            bridge.state_dir = state_dir
            bridge.manual_sync_path = state_dir / "manual-sync.json"
            with mock.patch.object(bridge_module, "run_bounded_subprocess") as runner:
                safety = bridge.dispatch_evidence_fallback(
                    "a" * 24, bridge_module.DIANDIAN_SAFETY_STOP_REASON
                )
                invalid = bridge.dispatch_evidence_fallback(
                    "a" * 24, "invalid-summary"
                )
                bridge.manual_sync_path.write_text(
                    json.dumps({"state": "safety-stopped"}), encoding="utf-8"
                )
                persisted_safety = bridge.dispatch_evidence_fallback(
                    "a" * 24, "transport-failed"
                )
                bridge.manual_sync_path.unlink()
                (state_dir / "media-download-safety-stop.json").write_text(
                    "{}", encoding="utf-8"
                )
                marker_safety = bridge.dispatch_evidence_fallback(
                    "a" * 24, "transport-failed"
                )
            runner.assert_not_called()
            self.assertEqual(safety["reason_code"], "safety_stopped")
            self.assertEqual(invalid["reason_code"], "fallback_not_allowed")
            self.assertEqual(persisted_safety["reason_code"], "safety_stopped")
            self.assertEqual(marker_safety["reason_code"], "safety_stopped")

    def test_bridge_fails_closed_when_the_manual_safety_state_is_unreadable(self):
        bridge_module = load_bridge_module()
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = pathlib.Path(temporary)
            bridge = bridge_module.Bridge.__new__(bridge_module.Bridge)
            bridge.state_dir = state_dir
            bridge.manual_sync_path = state_dir / "manual-sync.json"
            bridge.manual_sync_path.write_text("{", encoding="utf-8")

            with mock.patch.object(bridge_module, "run_bounded_subprocess") as runner:
                result = bridge.dispatch_evidence_fallback(
                    "a" * 24, "transport-failed"
                )

            runner.assert_not_called()
            self.assertEqual(result["reason_code"], "safety_state_unavailable")

    def test_bridge_records_exact_missing_reason_without_running_an_ocr_tool(self):
        bridge_module = load_bridge_module()
        with tempfile.TemporaryDirectory() as temporary:
            workspace = pathlib.Path(temporary)
            bridge = bridge_module.Bridge.__new__(bridge_module.Bridge)
            note_id = "a" * 24
            bridge.workspace = workspace
            bridge.state_dir = workspace / ".xhs-favorites"
            bridge.media_dir = bridge.state_dir / "media"
            bridge.media_dir.mkdir(parents=True)
            (bridge.media_dir / f"{note_id}.jpg").write_bytes(b"cached")
            bridge.video_analysis_enabled = False
            bridge.image_ocr_enabled = True
            bridge.image_ocr_engine = None
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge._summary_report_lock = __import__("threading").RLock()

            with mock.patch.object(bridge_module, "run_bounded_subprocess") as runner:
                result = bridge.dispatch_evidence_fallback(note_id, "transport-failed")

            runner.assert_not_called()
            self.assertEqual(result["evidence_status"], "missing")
            self.assertEqual(result["curation_status"], "pending_review")
            self.assertEqual(result["reason_code"], "ocr_unavailable")

    def test_revision_changes_stale_only_the_dependent_dimensions(self):
        state = load_state_module()
        body_change = state.revision_transitions(
            content_changed=True, evidence_changed=True, point_contract_changed=False
        )
        self.assertEqual(body_change, {"summary": ("stale", "content_changed"), "curation": ("stale", "content_changed"), "resource": ("stale", "content_changed")})
        evidence_change = state.revision_transitions(
            content_changed=False, evidence_changed=True, point_contract_changed=False
        )
        self.assertNotIn("summary", evidence_change)
        self.assertEqual(evidence_change["curation"], ("stale", "evidence_changed"))
        point_change = state.revision_transitions(
            content_changed=False, evidence_changed=False, point_contract_changed=True
        )
        self.assertEqual(point_change["summary"], ("stale", "provider_changed"))
        self.assertEqual(point_change["curation"], ("stale", "evidence_changed"))

    def test_legacy_manual_projection_keeps_core_success_and_summary_failure_orthogonal(self):
        state = load_state_module()
        projected = state.project_legacy_manual_state({
            "batch": "fixture-run", "state": "failed", "core_completed": True,
            "scanned": 3, "new": 2, "summarized": 1, "summary_failed": 1,
            "summary_pending": 1, "summary_halt_reason": "transport-failed",
        })
        self.assertEqual(projected["phases"]["core"]["status"], "completed")
        self.assertEqual(projected["phases"]["summary"]["status"], "failed")
        self.assertEqual(projected["phases"]["summary"]["reason_code"], "transport_failed")
        self.assertEqual(projected["counts"]["summary_batch_aborted"], 1)
        self.assertEqual(projected["state"], "organization_partial")


if __name__ == "__main__":
    unittest.main()
