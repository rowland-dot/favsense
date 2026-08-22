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
    def test_legacy_completed_is_not_full_success(self):
        state = load_state_module()
        projected = state.normalize_run_state({"state": "completed"})
        self.assertEqual(projected["state"], "completed_with_warnings")
        self.assertEqual(projected["reason_code"], "unknown_legacy")

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


if __name__ == "__main__":
    unittest.main()
