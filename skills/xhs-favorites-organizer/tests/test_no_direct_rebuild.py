"""The sync service builds the formal knowledge base and web data only in the final snapshot build.

The older path rebuilt both outputs straight into the live folders after every board, and published
board by board. It was reachable only while a switch that is always on in production was off.
"""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import bridge_support
from bridge_support import ScriptRunnerDouble, completed

MODULE_PATH = Path(__file__).parents[1] / "scripts" / "bridge-server.py"
SPEC = importlib.util.spec_from_file_location("xhs_bridge_no_direct_rebuild", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BRIDGE)

NOTE_ID = "a" * 24


def make_bridge(root: Path, script_runner=None):
    bridge = bridge_support.make_bridge(BRIDGE, root, script_runner=script_runner)
    bridge.cache_missing_media = mock.Mock(return_value={"queued": 0, "downloaded": 0, "safety_stopped": False})
    bridge.tag_catalog_sources = mock.Mock()
    bridge.next_board_id = mock.Mock(return_value=None)
    bridge.publish_after_board = mock.Mock(return_value={"ok": True, "status": "published"})
    BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {
        NOTE_ID: {"note_id": NOTE_ID, "comment_evidence_checked": True},
    }})
    return bridge


def read_run(bridge):
    return json.loads((bridge.state_dir / "runs" / "manual_board.json").read_text(encoding="utf-8"))


class NoDirectRebuildTests(unittest.TestCase):
    def test_the_sync_service_has_no_direct_rebuild(self):
        self.assertFalse(hasattr(BRIDGE.Bridge, "rebuild_knowledge_base"))

    def test_a_board_with_nothing_new_neither_rebuilds_nor_publishes(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = ScriptRunnerDouble()
            bridge = make_bridge(Path(directory), runner)
            bridge.process_import("manual_board", "board", {NOTE_ID: f"https://www.xiaohongshu.com/explore/{NOTE_ID}"})
            result = read_run(bridge)
        self.assertEqual(result["state"], "completed")
        self.assertIsNone(result["publish"])
        self.assertEqual(runner.calls, [])
        bridge.publish_after_board.assert_not_called()
        bridge.cache_missing_media.assert_called_once()

    def test_a_board_with_new_notes_runs_only_the_organizer_and_does_not_publish(self):
        new_id = "n" * 24
        with tempfile.TemporaryDirectory() as directory:
            fetched = completed(json.dumps({
                "notes": [{"note_id": new_id, "detail_fetched": True, "comment_evidence_checked": True}],
                "failures": [],
            }))
            runner = ScriptRunnerDouble([fetched, completed()])
            bridge = make_bridge(Path(directory), runner)
            bridge.process_import("manual_board", "board", {new_id: f"https://www.xiaohongshu.com/explore/{new_id}"})
            result = read_run(bridge)
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["new"], 1)
        self.assertIsNone(result["publish"])
        fetch, organize = runner.calls
        self.assertIn("fetch-xhs-details.py", " ".join(fetch.command))
        self.assertIn("organize.mjs", " ".join(organize.command))
        self.assertNotIn("build-knowledge-base", " ".join(organize.command))
        bridge.publish_after_board.assert_not_called()

    def test_the_last_summary_finishing_runs_the_final_build_once_and_publishes_its_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = make_bridge(root)
            bridge.summary_plans = {"manual_board": set()}
            bridge.summary_finalizing = {"manual_board"}
            bridge.run_curation_pipeline = mock.Mock(return_value={"counts": {"accepted": 1, "pending": 0}})
            bridge.build_organization_snapshot = mock.Mock(
                return_value={"build_version": "a" * 64, "site_manifest_sha256": "b" * 64}
            )
            bridge.write_status = mock.Mock()
            BRIDGE.atomic_json(bridge.state_dir / "runs" / "manual_board.json", {
                "run_id": "manual_board", "state": "completed", "next_board_id": None,
            })
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual", "state": "running", "run_board_ids": ["board"],
                "core_completed": True, "summary_finalizing": True, "summarized": 1,
            })

            bridge.run_diandian_finalization("manual_board", "board")

            bridge.build_organization_snapshot.assert_called_once()
            bridge.publish_after_board.assert_called_once()
            self.assertEqual(bridge.publish_after_board.call_args.kwargs["build_version"], "a" * 64)
            self.assertEqual(bridge.read_manual_sync()["state"], "completed")


if __name__ == "__main__":
    unittest.main()
