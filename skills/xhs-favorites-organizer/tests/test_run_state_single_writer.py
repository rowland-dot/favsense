"""The run state module is the only writer of the organization run record.

Slice 1 and 2 pin the two disagreements the issue names, against the module's public
projection and copy rule, before any writer exists.
"""

import ast
import importlib.util
import json
import pathlib
import unittest

import bridge_support


SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "organization_state.py"


def load_state_module():
    spec = importlib.util.spec_from_file_location("organization_state", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SelectedSentenceTests(unittest.TestCase):
    def test_core_done_with_an_aborted_summary_batch_selects_the_aborted_sentence(self):
        state = load_state_module()
        projected = state.project_legacy_manual_state({
            "batch": "fixture-run", "state": "failed", "core_completed": True,
            "summary_batch_aborted": 2,
        })
        self.assertEqual(
            state.visible_copy(projected), "本次未尝试，可继续整理",
            "the server rule must give the sentence the page used to pick for this state",
        )


class CoreImportSafetyStopTests(unittest.TestCase):
    def test_a_stop_during_core_import_is_recorded_on_the_core_phase(self):
        state = load_state_module()
        projected = state.project_legacy_manual_state({
            "batch": "fixture-run", "state": "safety-stopped", "scanned": 30,
        })
        self.assertEqual(projected["phases"]["core"]["status"], "safety_stopped")
        self.assertEqual(projected["phases"]["core"]["reason_code"], "safety_signal")
        self.assertEqual(projected["phases"]["summary"]["status"], "not_started")
        self.assertEqual(projected["state"], "safety_stopped")


CASES_PATH = pathlib.Path(__file__).parents[3] / "site" / "organization-status-cases.json"
CONTRACT_PATH = pathlib.Path(__file__).parents[3] / "site" / "organization-status-contract.json"


class SharedEventTableTests(unittest.TestCase):
    """Every sequence of reported events lands on the status the table expects."""

    def test_every_case_in_the_shared_table_gives_its_expected_status(self):
        state = load_state_module()
        table = json.loads(CASES_PATH.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(table["cases"]), 12)
        for case in table["cases"]:
            with self.subTest(case=case["name"]):
                record = None
                for name, data in case["events"]:
                    record = state.apply_event(record, name, data)
                status = state.public_status(record)
                expect = case["expect"]
                self.assertEqual(status["state"], expect["state"])
                self.assertEqual(status["build_version"], expect["build_version"])
                self.assertEqual(
                    {name: [phase["status"], phase["reason_code"]] for name, phase in status["phases"].items()},
                    expect["phases"],
                )
                self.assertEqual(status["counts"], expect["counts"])
                self.assertEqual(status["copy_key"], expect["copy_key"])
                self.assertIn(status["copy_key"], json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))["copy"])

    def test_the_table_covers_the_sequences_the_issue_names(self):
        table = json.loads(CASES_PATH.read_text(encoding="utf-8"))
        keys = {case["expect"]["copy_key"] for case in table["cases"]}
        for needed in (
            "safety_stopped", "summary_batch_aborted", "summary_failed", "evidence_missing",
            "build_failed", "publish_failed", "publish_unchanged", "local_rebuild_running",
            "local_rebuild_ready", "core_completed", "core_failed",
        ):
            self.assertIn(needed, keys)
        core_phases = {case["expect"]["phases"]["core"][0] for case in table["cases"]}
        self.assertIn("safety_stopped", core_phases)


BRIDGE_SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "bridge-server.py"


def load_bridge_module():
    spec = importlib.util.spec_from_file_location("organization_bridge_single_writer", BRIDGE_SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The field set of a real finished round as the old writer left it on disk (values are synthetic).
LEGACY_ROUND = {
    "batch": "manual20261011000000", "state": "completed", "started_at": "2026-10-11T00:00:00+00:00",
    "board_count": 2, "processed_boards": 2, "current_board": "", "scanned": 40, "new": 3,
    "summarized": 3, "summary_total": 3, "summary_pending": 0, "summary_failed": 0,
    "summary_batch_aborted": 0, "summary_plan_pending": False, "summary_finalizing": False,
    "processed_run_ids": ["manual20261011000000_b1", "manual20261011000000_b2"],
    "run_board_ids": ["b1", "b2"], "run_mode": "incremental",
    "board_note_ids": {"b1": ["n1"], "b2": ["n2", "n3"]},
    "summary_plan_resolved_run_ids": ["manual20261011000000_b1", "manual20261011000000_b2"],
    "frozen_scope": {"note_ids": ["n1", "n2", "n3"], "mode": "incremental", "local_only": False, "config_sha256": "c" * 64},
    "completed_at": "2026-10-11T00:30:00+00:00",
}
PUBLIC_KEYS = {"schema_version", "run_id", "state", "build_version", "phases", "counts", "copy_key"}


class RecordFileTests(unittest.TestCase):
    def bridge(self, directory):
        module = load_bridge_module()
        return module, bridge_support.make_bridge(module, pathlib.Path(directory))

    def test_an_old_single_level_round_is_converted_when_read_and_the_file_is_left_alone(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            module, bridge = self.bridge(directory)
            module.atomic_json(bridge.manual_sync_path, LEGACY_ROUND)
            before = bridge.manual_sync_path.read_bytes()

            working = bridge.read_manual_sync()
            status = bridge.manual_sync_status()

            self.assertEqual(working, LEGACY_ROUND)
            self.assertEqual(status["schema_version"], 2)
            self.assertEqual(status["phases"]["core"]["status"], "completed")
            self.assertEqual(status["counts"]["scanned"], 40)
            self.assertEqual(status["copy_key"], "core_completed")
            self.assertEqual(bridge.manual_sync_path.read_bytes(), before)

    def test_the_next_event_writes_the_staged_form_and_keeps_every_old_field(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            module, bridge = self.bridge(directory)
            module.atomic_json(bridge.manual_sync_path, LEGACY_ROUND)

            bridge.report_run_event("publish_recorded", status="unchanged", build_version="a" * 64, site_manifest_sha256="b" * 64)

            stored = json.loads(bridge.manual_sync_path.read_text(encoding="utf-8"))
            self.assertEqual(stored["schema_version"], 2)
            self.assertEqual(stored["phases"]["publish"]["status"], "unchanged")
            kept = stored["bookkeeping"]
            for key, value in LEGACY_ROUND.items():
                self.assertEqual(kept[key], value, key)
            self.assertEqual(bridge.read_manual_sync()["publish_status"], "unchanged")

    def test_the_status_never_shows_the_bookkeeping(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            module, bridge = self.bridge(directory)
            module.atomic_json(bridge.manual_sync_path, LEGACY_ROUND)
            bridge.report_run_event("publish_recorded", status="published", build_version="a" * 64, site_manifest_sha256="b" * 64)

            status = bridge.manual_sync_status()

            self.assertEqual(set(status), PUBLIC_KEYS)
            shown = json.dumps(status, ensure_ascii=False)
            for private in ("run_board_ids", "processed_run_ids", "board_note_ids", "frozen_scope", "summary_plan_resolved_run_ids", "b1", "n2"):
                self.assertNotIn(private, shown)

    def test_the_public_view_of_a_stored_record_drops_the_bookkeeping(self):
        state = load_state_module()
        record = state.apply_event(None, "round_started", {
            "batch": "manual20261012090000", "started_at": "2026-10-12T09:00:00+10:00",
            "run_board_ids": ["b1"], "mode": "incremental",
        })
        self.assertIn("bookkeeping", record)
        self.assertEqual(set(state.public_status(record)), PUBLIC_KEYS)
        self.assertEqual(set(state.public_status(state.working_view(record))), PUBLIC_KEYS)

    def test_the_stored_overall_state_matches_the_status_so_raw_readers_see_a_stop(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            module, bridge = self.bridge(directory)
            bridge.report_run_event(
                "round_started", batch="manual20261012090000", started_at="2026-10-12T09:00:00+10:00",
                run_board_ids=["b1"], mode="incremental",
            )
            bridge.report_run_event("round_failed", safety=True, error="stopped", remaining=0)

            stored = json.loads(bridge.manual_sync_path.read_text(encoding="utf-8"))

            self.assertEqual(stored["state"], "safety_stopped")
            self.assertEqual(stored["state"], bridge.manual_sync_status()["state"])

    def test_a_snapshot_puts_the_record_back_exactly(self):
        import tempfile
        state = load_state_module()
        with tempfile.TemporaryDirectory() as directory:
            module, bridge = self.bridge(directory)
            module.atomic_json(bridge.manual_sync_path, {**LEGACY_ROUND, "state": "running"})
            snapshot = state.snapshot_record(bridge.manual_sync_path)
            bridge.report_run_event("finalization_started", board_name="收藏夹A")
            self.assertNotEqual(bridge.manual_sync_path.read_bytes(), snapshot)

            state.restore_record(bridge.manual_sync_path, snapshot, module.restore_file_snapshot)

            self.assertEqual(bridge.manual_sync_path.read_bytes(), snapshot)
            self.assertEqual(state.snapshot_record(bridge.manual_sync_path.with_name("absent.json")), None)


RECORD_NAMES = {"manual_sync_path", "local_rebuild_path"}
WRITE_VERBS = {
    "atomic_json", "restore_file_snapshot", "write_text", "write_bytes", "unlink", "replace",
    "rename", "touch", "open",
}


def record_writes(source):
    """Calls in the sync service that write or remove a run record file, as (line, call name)."""
    found = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Call):
            continue
        callee = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
        if callee not in WRITE_VERBS:
            continue
        touched = [ast.dump(arg) for arg in node.args] + [ast.dump(keyword.value) for keyword in node.keywords]
        if isinstance(node.func, ast.Attribute):
            touched.append(ast.dump(node.func.value))
        if any(name in text for text in touched for name in RECORD_NAMES):
            found.append((node.lineno, callee))
    return found


class OnlyTheStateModuleWritesTheRunRecordTests(unittest.TestCase):
    def test_the_scan_finds_a_direct_write_when_there_is_one(self):
        self.assertEqual(
            record_writes("def f(self):\n    atomic_json(self.manual_sync_path, state)\n"),
            [(2, "atomic_json")],
        )
        self.assertEqual(record_writes("def f(self):\n    self.local_rebuild_path().unlink()\n"), [(2, "unlink")])
        self.assertEqual(record_writes("def f(self):\n    return self.manual_sync_path.exists()\n"), [])

    def test_the_sync_service_never_writes_a_run_record_itself(self):
        self.assertEqual(record_writes(BRIDGE_SCRIPT.read_text(encoding="utf-8")), [])

    def test_the_service_has_no_generic_record_updater_left(self):
        self.assertFalse("def update_local_rebuild" in BRIDGE_SCRIPT.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
