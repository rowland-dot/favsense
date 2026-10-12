"""Every kind of safety stop is recorded, with its phase, so the next round treats it as a leftover.

Today only the detail fetcher and the media downloader leave a record. A stop reported by the
board page or by the DianDian step ends the round and leaves nothing behind, so the next round
walks straight back into the platform.
"""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import bridge_support
from bridge_support import ScriptRunnerDouble, completed


SCRIPTS = Path(__file__).parents[1] / "scripts"


def load(name: str, file_name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / file_name)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


BRIDGE = load("xhs_bridge_stop_sources", "bridge-server.py")
FETCHER = load("xhs_fetcher_stop_sources", "fetch-xhs-details.py")
DOWNLOADER = load("xhs_downloader_stop_sources", "download-pending-media.py")
ACCESS = load("favsense_platform_access_stop_sources", "platform_access.py")

STOP_NAME = "media-download-safety-stop.json"
NOTE_ID = "z" * 24


def read_record(state_dir: Path) -> dict:
    return json.loads((state_dir / STOP_NAME).read_text(encoding="utf-8"))


def bridge_with_round(root: Path, **options):
    bridge = bridge_support.make_bridge(BRIDGE, root, **options)
    bridge.organization_status_v2_enabled = False
    bridge.open_sop_browser_page = mock.Mock(return_value={"id": "target"})
    return bridge


def start_round(bridge, **extra):
    BRIDGE.atomic_json(bridge.manual_sync_path, {
        "batch": "manual",
        "state": "running",
        "started_at": BRIDGE.datetime.now().astimezone().isoformat(),
        "run_board_ids": ["board"],
        "processed_run_ids": [],
        **extra,
    })


def next_start(bridge):
    with mock.patch.object(BRIDGE.subprocess, "Popen"):
        return bridge.trigger_manual_sync()


class ScriptsWriteTheirOwnPhaseTests(unittest.TestCase):
    def test_the_detail_fetcher_records_the_detail_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / STOP_NAME
            FETCHER.write_safety_stop(path)
            self.assertEqual(ACCESS.read_stop(Path(directory))["phase"], "detail")
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["reason"], "platform-safety-limit")

    def test_the_media_downloader_records_the_media_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / STOP_NAME
            DOWNLOADER.write_safety_stop(path)
            self.assertEqual(ACCESS.read_stop(Path(directory))["phase"], "media")

    def test_a_second_stop_never_rewrites_the_first_record(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / STOP_NAME
            FETCHER.write_safety_stop(path)
            DOWNLOADER.write_safety_stop(path)
            self.assertEqual(ACCESS.read_stop(Path(directory))["phase"], "detail")


class EveryStopLeavesARecordTests(unittest.TestCase):
    def test_a_stop_found_while_fetching_details_is_recorded_as_detail(self):
        with tempfile.TemporaryDirectory() as directory:
            # The fetcher process is replaced, so it leaves no record of its own; the bridge must.
            payload = json.dumps({"notes": [], "failures": [{"note_id": NOTE_ID, "reason": "safety stop"}]})
            bridge = bridge_with_round(Path(directory), script_runner=ScriptRunnerDouble(completed(payload)))
            bridge.cache_missing_media = mock.Mock()
            bridge.tag_catalog_sources = mock.Mock()
            bridge.next_board_id = mock.Mock(return_value=None)
            bridge.publish_after_board = mock.Mock(return_value=None)
            BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {}})
            bridge.process_import("manual_board", "board", {
                NOTE_ID: f"https://www.xiaohongshu.com/explore/{NOTE_ID}",
            })
            self.assertEqual(read_record(bridge.state_dir)["phase"], "detail")
            refused = next_start(bridge)
            bridge.open_sop_browser_page.assert_not_called()
            self.assertEqual(refused["legacy_safety_stop"]["phase"], "detail")

    def test_a_stop_found_while_downloading_media_is_recorded_as_media(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake_media = root / "fake-media.py"
            fake_media.write_text(
                "import json\n"
                "input()\n"
                "print(json.dumps({'queued':1,'downloaded':0,'safety_stopped':True}))\n"
                "raise SystemExit(2)\n",
                encoding="utf-8",
            )
            # A real child process, so this one gets the production runner.
            bridge = bridge_with_round(
                root, script_runner=BRIDGE.BoundedScriptRunner(),
                config={"video_analysis": {"enabled": True}},
            )
            bridge.run_dir.mkdir(parents=True, exist_ok=True)
            bridge.python = Path(sys.executable)
            bridge.media_fetcher = fake_media
            result = bridge.cache_missing_media({NOTE_ID: f"https://www.xiaohongshu.com/explore/{NOTE_ID}"})
            self.assertTrue(result["safety_stopped"])
            self.assertEqual(read_record(bridge.state_dir)["phase"], "media")
            refused = next_start(bridge)
            bridge.open_sop_browser_page.assert_not_called()
            self.assertEqual(refused["legacy_safety_stop"]["phase"], "media")

    def test_a_stop_reported_by_the_board_page_is_recorded_as_page(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = bridge_with_round(Path(directory))
            start_round(bridge)
            run_id = bridge.manual_run_id("manual", "board")
            bridge.record_manual_failure({
                "run_id": run_id, "board_id": "board", "error": BRIDGE.DIANDIAN_SAFETY_STOP_REASON,
            })
            self.assertEqual(bridge.read_manual_sync()["state"], "safety-stopped")
            self.assertEqual(read_record(bridge.state_dir)["phase"], "page")
            # The round that just ended in the stop shows its own wording, and the stop is already
            # the next round's leftover, so the workbench is also told how to clear it.
            status = bridge.manual_sync_status()
            self.assertEqual(status["state"], "safety-stopped")
            self.assertEqual(status["legacy_safety_stop"]["phase"], "page")

    def test_a_stop_reported_by_the_diandian_step_is_recorded_as_diandian(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = bridge_with_round(Path(directory))
            start_round(bridge, summary_pending=1, summary_failed=0)
            bridge.summary_plans = {"manual_board": {NOTE_ID}}
            bridge.halt_diandian_run({
                "run_id": "manual_board",
                "board_id": "board",
                "reason": BRIDGE.DIANDIAN_SAFETY_STOP_REASON,
                "note_id": NOTE_ID,
            })
            self.assertEqual(bridge.read_manual_sync()["state"], "safety-stopped")
            self.assertEqual(read_record(bridge.state_dir)["phase"], "diandian")

    def test_a_failure_that_is_not_a_safety_stop_leaves_no_record(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = bridge_with_round(Path(directory))
            start_round(bridge)
            run_id = bridge.manual_run_id("manual", "board")
            bridge.record_manual_failure({
                "run_id": run_id, "board_id": "board", "error": "share-link-failed",
            })
            self.assertFalse((bridge.state_dir / STOP_NAME).exists())

    def test_every_recorded_stop_becomes_the_next_rounds_leftover(self):
        for source in ("page", "diandian"):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as directory:
                bridge = bridge_with_round(Path(directory))
                start_round(bridge, summary_pending=1, summary_failed=0)
                bridge.summary_plans = {"manual_board": {NOTE_ID}}
                if source == "page":
                    bridge.record_manual_failure({
                        "run_id": bridge.manual_run_id("manual", "board"),
                        "board_id": "board",
                        "error": BRIDGE.DIANDIAN_SAFETY_STOP_REASON,
                    })
                else:
                    bridge.halt_diandian_run({
                        "run_id": "manual_board", "board_id": "board",
                        "reason": BRIDGE.DIANDIAN_SAFETY_STOP_REASON, "note_id": NOTE_ID,
                    })
                refused = next_start(bridge)
                bridge.open_sop_browser_page.assert_not_called()
                self.assertIs(refused["refused"], True)
                self.assertEqual(refused["legacy_safety_stop"]["phase"], source)
                # The stop that ended the round and the one refusing the next are worded apart.
                self.assertNotEqual(refused["error"], BRIDGE.PLATFORM_ACCESS.ROUND_STOP_MESSAGE)
                self.assertNotEqual(bridge.read_manual_sync().get("error"), refused["error"])


if __name__ == "__main__":
    unittest.main()
