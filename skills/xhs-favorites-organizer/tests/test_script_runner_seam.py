"""The sync service runs every helper script through one replaceable script runner.

The runner is handed in when the service starts. Production passes nothing and gets the real,
output-bounded one; a test hands in a double that answers from presets and records what it was asked
to run. These tests start a real, fully initialised service and watch it only through that seam and
through its public operations.
"""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from bridge_support import ScriptRunnerDouble, completed, make_bridge

MODULE_PATH = Path(__file__).parents[1] / "scripts" / "bridge-server.py"
SPEC = importlib.util.spec_from_file_location("xhs_bridge_script_runner_seam", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BRIDGE)

KNOWN_ID = "a" * 24
NEW_ID = "b" * 24
REVISION = "c" * 64


def url(note_id: str) -> str:
    return f"https://www.xiaohongshu.com/explore/{note_id}"


def known_catalog(bridge) -> None:
    BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {
        KNOWN_ID: {
            "note_id": KNOWN_ID, "comment_evidence_checked": True, "content_sha256": REVISION,
        },
    }})


class ImportThroughTheRunnerTests(unittest.TestCase):
    def test_an_import_runs_the_detail_fetch_and_the_organizer_through_the_runner(self):
        fetched_note = {"note_id": NEW_ID, "detail_fetched": True, "comment_evidence_checked": True}

        def respond(command, **_options):
            if "fetch-xhs-details.py" in " ".join(command):
                return completed(json.dumps({"notes": [fetched_note], "failures": []}))
            self.assertIn("organize.mjs", " ".join(command))
            catalog = json.loads(bridge.catalog_path.read_text(encoding="utf-8"))
            catalog["notes"][NEW_ID] = {**fetched_note, "content_sha256": REVISION}
            BRIDGE.atomic_json(bridge.catalog_path, catalog)
            return completed()

        with tempfile.TemporaryDirectory() as directory:
            runner = ScriptRunnerDouble(respond)
            bridge = make_bridge(BRIDGE, Path(directory), script_runner=runner)
            known_catalog(bridge)
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual", "state": "running", "run_board_ids": ["board"],
            })

            bridge.process_import("manual_board", "board", {KNOWN_ID: url(KNOWN_ID), NEW_ID: url(NEW_ID)})

            result = json.loads(
                (bridge.state_dir / "runs" / "manual_board.json").read_text(encoding="utf-8")
            )
            fetch, organize = runner.calls
            self.assertEqual(fetch.input_text, url(NEW_ID))
            self.assertIn("--max-items", fetch.command)
            self.assertEqual(Path(organize.command[1]).name, "organize.mjs")
            self.assertEqual(json.loads(organize.input_text), {"notes": [fetched_note]})
            self.assertEqual(organize.cwd, bridge.workspace)
            self.assertEqual(result["state"], "completed")
            self.assertEqual(result["new"], 1)
            self.assertEqual(result["note_ids"], sorted([KNOWN_ID, NEW_ID]))


class AWiringMistakeIsNotHiddenTests(unittest.TestCase):
    """The service is built whole, so a missing piece is a mistake to see, never a default to fall back on."""

    def started(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        bridge = make_bridge(BRIDGE, Path(directory.name))
        BRIDGE.atomic_json(bridge.manual_sync_path, {"batch": "manual", "state": "running"})
        return bridge

    def test_a_piece_the_start_did_not_set_up_makes_the_public_operation_fail(self):
        state = {"batch": "manual", "state": "running", "processed_run_ids": []}
        operations = {
            "board_order": lambda bridge: bridge.run_board_order("manual"),
            "boards": lambda bridge: bridge.manual_state_owns_run(state, "manual_board", "board"),
            "summary_plans": lambda bridge: bridge.manual_run_ids_for_state(state),
            "processing_lock": lambda bridge: bridge.manual_sync_status(),
            "summary_locks_guard": lambda bridge: bridge.diandian_is_halted("manual_board"),
        }
        for attribute, operate in operations.items():
            with self.subTest(attribute=attribute):
                bridge = self.started()
                delattr(bridge, attribute)
                with self.assertRaises(AttributeError):
                    operate(bridge)

    def test_the_local_rebuild_lock_and_thread_table_exist_from_the_start(self):
        bridge = self.started()
        self.assertEqual(bridge.local_rebuild_threads, {})
        self.assertIs(bridge.get_local_rebuild_lock(), bridge.get_local_rebuild_lock())
        self.assertTrue(hasattr(bridge, "_local_rebuild_lock"))


if __name__ == "__main__":
    unittest.main()
