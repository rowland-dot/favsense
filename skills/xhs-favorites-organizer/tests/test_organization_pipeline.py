import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "organization_state.py"


def load_state_module():
    spec = importlib.util.spec_from_file_location("organization_state", SCRIPT)
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
