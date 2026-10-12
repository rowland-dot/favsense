"""Every way a collection import can end reports the same set of fields.

The early stop used to write "new: 0" while thirty notes were still waiting, and it left out the
note list, the skipped count and the failures the other endings carried. Each ending now builds
its result the same way, and a number nobody knows is null, never zero.
"""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import bridge_support
from bridge_support import completed


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "bridge-server.py"
SPEC = importlib.util.spec_from_file_location("xhs_bridge_import_shape", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BRIDGE)

STOP_NAME = "media-download-safety-stop.json"
KNOWN_ID = "a" * 24
NEW_ID = "b" * 24
SECOND_NEW_ID = "c" * 24
RESULT_FIELDS = {
    "run_id", "state", "started_at", "completed_at", "scanned", "pending", "board_id",
    "board_name", "new", "skipped", "failures", "baseline", "report", "media",
    "next_board_id", "note_ids", "error", "publish",
}


def url(note_id: str) -> str:
    return f"https://www.xiaohongshu.com/explore/{note_id}"


def make_bridge(root: Path, known=(KNOWN_ID,)):
    bridge = bridge_support.make_bridge(BRIDGE, root)
    bridge.cache_missing_media = mock.Mock(
        return_value={"queued": 0, "downloaded": 0, "safety_stopped": False}
    )
    bridge.tag_catalog_sources = mock.Mock()
    bridge.next_board_id = mock.Mock(return_value=None)
    bridge.publish_after_board = mock.Mock(return_value=None)
    BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {
        note_id: {"note_id": note_id, "comment_evidence_checked": True} for note_id in known
    }})
    return bridge


def run_import(bridge, unique, *, fetch=None):
    """Drive process_import and return the result it wrote for the run."""

    def respond(command, **options):
        if fetch is not None and "fetch-xhs-details.py" in " ".join(command):
            return completed(json.dumps(fetch))
        if "organize.mjs" not in " ".join(command):
            raise AssertionError(f"unexpected helper script call: {command}")
        payload = json.loads(options["input_text"])
        existing = json.loads(bridge.catalog_path.read_text(encoding="utf-8"))
        existing["notes"].update({note["note_id"]: note for note in payload["notes"]})
        BRIDGE.atomic_json(bridge.catalog_path, existing)
        return completed()

    bridge.script_runner.respond = respond
    bridge.process_import("manual_board", "board", unique)
    return json.loads(
        (bridge.state_dir / "runs" / "manual_board.json").read_text(encoding="utf-8")
    )


class EveryEndingHasTheSameFieldsTests(unittest.TestCase):
    def test_nothing_new_to_fetch(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            result = run_import(bridge, {KNOWN_ID: url(KNOWN_ID)})
            self.assertEqual(result["state"], "completed")
            self.assertEqual(set(result), RESULT_FIELDS)
            self.assertEqual(result["new"], 0)
            self.assertEqual(result["note_ids"], [KNOWN_ID])

    def test_new_notes_fetched_and_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            result = run_import(
                bridge,
                {KNOWN_ID: url(KNOWN_ID), NEW_ID: url(NEW_ID)},
                fetch={"notes": [
                    {"note_id": NEW_ID, "detail_fetched": True, "comment_evidence_checked": True},
                ], "failures": []},
            )
            self.assertEqual(result["state"], "completed")
            self.assertEqual(set(result), RESULT_FIELDS)
            self.assertEqual(result["new"], 1)
            self.assertEqual(result["failures"], [])
            self.assertIsNone(result["error"])

    def test_the_detail_fetch_meets_a_safety_stop_part_way(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            result = run_import(
                bridge,
                {NEW_ID: url(NEW_ID), SECOND_NEW_ID: url(SECOND_NEW_ID)},
                fetch={"notes": [
                    {"note_id": NEW_ID, "detail_fetched": True, "comment_evidence_checked": True},
                ], "failures": [{"note_id": SECOND_NEW_ID, "reason": "safety stop"}]},
            )
            self.assertEqual(result["state"], "safety-stopped")
            self.assertEqual(set(result), RESULT_FIELDS)
            self.assertEqual(result["new"], 1)
            self.assertEqual(result["skipped"], 1)
            self.assertEqual(result["error"], BRIDGE.PLATFORM_ACCESS.ROUND_STOP_MESSAGE)

    def test_media_download_meets_a_safety_stop_after_everything_was_known(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            bridge.cache_missing_media.return_value = {
                "queued": 1, "downloaded": 0, "safety_stopped": True, "state": "safety-stopped",
            }
            result = run_import(bridge, {KNOWN_ID: url(KNOWN_ID)})
            self.assertEqual(result["state"], "safety-stopped")
            self.assertEqual(set(result), RESULT_FIELDS)
            self.assertEqual(result["new"], 0)
            self.assertEqual(result["error"], BRIDGE.PLATFORM_ACCESS.ROUND_STOP_MESSAGE)

    def test_the_round_already_has_a_stop_on_record_when_the_import_begins(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            BRIDGE.atomic_json(bridge.state_dir / STOP_NAME, {
                "stopped_at": "2026-10-12T09:30:00+00:00", "reason": "platform-safety-limit",
                "phase": "diandian",
            })
            thirty = {f"{index:024x}": url(f"{index:024x}") for index in range(1, 31)}
            result = run_import(bridge, {KNOWN_ID: url(KNOWN_ID), **thirty})
            self.assertEqual(result["state"], "safety-stopped")
            self.assertEqual(set(result), RESULT_FIELDS)
            # Nothing was fetched, so how many of the thirty are new is not known: it is not zero.
            self.assertIsNone(result["new"])
            self.assertEqual(result["pending"], 30)
            self.assertEqual(result["skipped"], 30)
            self.assertEqual(len(result["failures"]), 30)
            self.assertTrue(all(item["reason"] == "safety stop" for item in result["failures"]))
            self.assertEqual(result["note_ids"], [KNOWN_ID])
            self.assertIsNone(result["next_board_id"])
            self.assertEqual(result["media"]["state"], "safety-stopped")
            bridge.cache_missing_media.assert_not_called()

    def test_the_import_fails_before_it_can_count_anything(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            bridge.catalog_path.write_text("{not json", encoding="utf-8")
            result = run_import(bridge, {NEW_ID: url(NEW_ID)})
            self.assertEqual(result["state"], "failed")
            self.assertEqual(set(result), RESULT_FIELDS)
            self.assertIsNone(result["new"])
            self.assertIsNone(result["skipped"])
            self.assertIsNone(result["note_ids"])
            self.assertTrue(result["error"])

    def test_no_ending_writes_zero_for_a_number_it_does_not_know(self):
        for case in ("begins-stopped", "fails"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                bridge = make_bridge(Path(directory))
                if case == "begins-stopped":
                    BRIDGE.atomic_json(bridge.state_dir / STOP_NAME, {
                        "stopped_at": "2026-10-12T09:30:00+00:00", "phase": "media",
                    })
                else:
                    bridge.catalog_path.write_text("{not json", encoding="utf-8")
                result = run_import(bridge, {NEW_ID: url(NEW_ID)})
                self.assertIsNone(result["new"])
                self.assertNotEqual(result["new"], 0)


class UnknownCountsReachTheStatusTests(unittest.TestCase):
    def manual_bridge(self, root: Path):
        bridge = bridge_support.make_bridge(BRIDGE, root)
        BRIDGE.atomic_json(bridge.manual_sync_path, {
            "batch": "manualunknown", "state": "running",
            "started_at": BRIDGE.datetime.now().astimezone().isoformat(),
            "run_board_ids": ["board"], "processed_run_ids": [], "scanned": 4, "new": 2,
        })
        return bridge

    def test_an_unknown_new_count_stays_unknown_in_the_round_total(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.manual_bridge(Path(directory))
            bridge.record_manual_result(
                bridge.manual_run_id("manualunknown", "board"), "board",
                {"state": "safety-stopped", "scanned": 31, "new": None},
            )
            state = bridge.read_manual_sync()
            self.assertEqual(state["scanned"], 35)
            self.assertIsNone(state["new"])

    def test_the_organization_status_shows_an_unknown_new_count_as_null(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.manual_bridge(Path(directory))
            bridge.record_manual_result(
                bridge.manual_run_id("manualunknown", "board"), "board",
                {"state": "safety-stopped", "scanned": 31, "new": None},
            )
            counts = bridge.manual_sync_status()["counts"]
            self.assertIsNone(counts["new"])
            self.assertEqual(counts["scanned"], 35)

    def test_known_counts_still_add_up(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.manual_bridge(Path(directory))
            bridge.record_manual_result(
                bridge.manual_run_id("manualunknown", "board"), "board",
                {"state": "safety-stopped", "scanned": 3, "new": 1},
            )
            state = bridge.read_manual_sync()
            self.assertEqual((state["scanned"], state["new"]), (7, 3))


if __name__ == "__main__":
    unittest.main()
