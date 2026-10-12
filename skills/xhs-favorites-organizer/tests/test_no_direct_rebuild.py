"""The sync service builds the formal knowledge base and web data only in the final snapshot build.

The older path rebuilt both outputs straight into the live folders after every board, and published
board by board. It was reachable only while a switch that is always on in production was off.
"""

import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest import mock

MODULE_PATH = Path(__file__).parents[1] / "scripts" / "bridge-server.py"
SPEC = importlib.util.spec_from_file_location("xhs_bridge_no_direct_rebuild", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BRIDGE)

NOTE_ID = "a" * 24


def make_bridge(root: Path):
    # Built without initialization, so the always-on switch is absent: the case that used to take the old path.
    bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
    bridge.workspace = root
    bridge.state_dir = root / ".xhs-favorites"
    bridge.status_path = bridge.state_dir / "bridge-status.json"
    bridge.catalog_path = root / "catalog.json"
    bridge.python = Path("python")
    bridge.fetcher = Path("fetch-xhs-details.py")
    bridge.xhs_dir = root / "xhs"
    bridge.organizer = Path("organize.mjs")
    bridge.boards = {"board": "Board"}
    bridge.board_order = ["board"]
    bridge.published_since = None
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
            bridge = make_bridge(Path(directory))
            with mock.patch.object(BRIDGE.subprocess, "run") as run:
                bridge.process_import("manual_board", "board", {NOTE_ID: f"https://www.xiaohongshu.com/explore/{NOTE_ID}"})
            result = read_run(bridge)
        self.assertEqual(result["state"], "completed")
        self.assertIsNone(result["publish"])
        run.assert_not_called()
        bridge.publish_after_board.assert_not_called()
        bridge.cache_missing_media.assert_called_once()

    def test_a_board_with_new_notes_runs_only_the_organizer_and_does_not_publish(self):
        new_id = "n" * 24
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            fetched = mock.Mock(returncode=0, stderr="", stdout=json.dumps({
                "notes": [{"note_id": new_id, "detail_fetched": True, "comment_evidence_checked": True}],
                "failures": [],
            }))
            with (
                mock.patch.object(BRIDGE, "run_bounded_subprocess", return_value=fetched),
                mock.patch.object(BRIDGE.subprocess, "run", return_value=mock.Mock(returncode=0, stdout="", stderr="")) as run,
            ):
                bridge.process_import("manual_board", "board", {new_id: f"https://www.xiaohongshu.com/explore/{new_id}"})
            result = read_run(bridge)
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["new"], 1)
        self.assertIsNone(result["publish"])
        self.assertEqual(run.call_count, 1)
        self.assertNotIn("build-knowledge-base", " ".join(map(str, run.call_args.args[0])))
        bridge.publish_after_board.assert_not_called()

    def test_the_last_summary_finishing_runs_the_final_build_once_and_publishes_its_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = make_bridge(root)
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.processing_lock = threading.Lock()
            bridge.summary_plans = {"manual_board": set()}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.summary_finalizing = {"manual_board"}
            bridge.summary_finalized = set()
            bridge.summary_halted = set()
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
