"""Bridge failure handling: every request is answered, a media failure cannot fail a board,
failures leave a private sanitized trace, and /sync/failure says whether it recorded anything."""

import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "bridge-server.py"
SPEC = importlib.util.spec_from_file_location("xhs_bridge_failure_handling", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BRIDGE)

TOKEN = "a" * 64
FAKE_BOARD_ID = "f" * 24
SECRET_XSEC = "SECRETXSECVALUE123"
SECRET_QUERY = "SECRETQUERYVALUE456"


class RunningHandler:
    """A real handler on a loopback port with a stand-in bridge object."""

    def __init__(self, bridge):
        self.bridge = bridge
        self.server = BRIDGE.ThreadingHTTPServer((BRIDGE.HOST, 0), BRIDGE.make_handler(bridge))
        bridge.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_exc):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def call(self, method, path, payload=None):
        request = Request(
            f"http://{BRIDGE.HOST}:{self.bridge.port}{path}",
            data=None if payload is None else json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Origin": BRIDGE.MANAGER_ORIGIN,
                "X-XHS-Bridge-Token": TOKEN,
            },
            method=method,
        )
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))


class UnexpectedExceptionReplyTest(unittest.TestCase):
    def test_unexpected_exception_in_a_post_route_gets_a_json_500(self):
        bridge = SimpleNamespace(port=0, token=TOKEN, import_sync=mock.Mock(side_effect=KeyError("missing")))
        with RunningHandler(bridge) as handler:
            status, body = handler.call("POST", "/import-sync", {
                "run_id": "manualbatch_board", "board_id": "board", "urls": ["x"],
            })
        self.assertEqual(status, 500)
        self.assertIs(body["ok"], False)
        self.assertIn("KeyError", body["error"])

    def test_unexpected_exception_in_a_get_route_gets_a_json_500(self):
        bridge = SimpleNamespace(port=0, token=TOKEN, manual_sync_status=mock.Mock(side_effect=KeyError("missing")))
        with RunningHandler(bridge) as handler:
            status, body = handler.call("GET", "/sync/status")
        self.assertEqual(status, 500)
        self.assertIs(body["ok"], False)
        self.assertIn("KeyError", body["error"])

    def test_a_damaged_run_status_file_gets_a_json_500_instead_of_a_dropped_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            (state_dir / "runs").mkdir()
            (state_dir / "runs" / "damaged.json").write_text("{not json", encoding="utf-8")
            bridge = SimpleNamespace(port=0, token=TOKEN, state_dir=state_dir)
            with RunningHandler(bridge) as handler:
                status, body = handler.call("GET", "/status?run_id=damaged")
        self.assertEqual(status, 500)
        self.assertIs(body["ok"], False)


class BridgeLogTest(unittest.TestCase):
    def test_failed_requests_leave_one_sanitized_line_each_without_ids_tokens_or_query(self):
        run_id = f"manualbatch_{FAKE_BOARD_ID}"
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory) / ".xhs-favorites"
            leaky = KeyError(
                f"{run_id} https://www.xiaohongshu.com/explore/n1?xsec_token={SECRET_XSEC} {TOKEN}"
            )
            bridge = SimpleNamespace(
                port=0, token=TOKEN, state_dir=state_dir,
                import_sync=mock.Mock(side_effect=leaky),
                manual_sync_status=mock.Mock(side_effect=RuntimeError(f"broken {run_id}")),
            )
            with RunningHandler(bridge) as handler:
                handler.call("POST", "/import-sync", {"run_id": run_id, "board_id": FAKE_BOARD_ID, "urls": ["x"]})
                handler.call("GET", f"/sync/status?xsec_token={SECRET_QUERY}")
            text = (state_dir / "bridge.log").read_text(encoding="utf-8")
        lines = text.splitlines()
        self.assertEqual(len(lines), 2, text)
        post_fields = lines[0].split("\t")
        get_fields = lines[1].split("\t")
        self.assertRegex(post_fields[0], r"^\d{4}-\d{2}-\d{2}T")
        self.assertEqual(post_fields[1:5], ["POST", "/import-sync", "500", "KeyError"])
        self.assertEqual(get_fields[1:5], ["GET", "/sync/status", "500", "RuntimeError"])
        for secret in (FAKE_BOARD_ID, run_id, SECRET_XSEC, SECRET_QUERY, TOKEN, "xsec_token", "?"):
            self.assertNotIn(secret, text)

    def test_the_log_stays_size_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            message = "x " * 500
            for index in range(3 * BRIDGE.BRIDGE_LOG_MAX_BYTES // len(message) + 10):
                BRIDGE.append_bridge_log(state_dir, "POST", "/import-sync", 500, "KeyError", f"{index} {message}")
            sizes = [path.stat().st_size for path in state_dir.glob("bridge.log*")]
            latest = (state_dir / "bridge.log").read_text(encoding="utf-8")
        self.assertLessEqual(sum(sizes), 2 * BRIDGE.BRIDGE_LOG_MAX_BYTES + len(message) + 200)
        self.assertIn("500", latest)


class MediaFailureTest(unittest.TestCase):
    NOTE_ID = "a" * 24

    def make_bridge(self, root):
        bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
        bridge.workspace = root
        bridge.state_dir = root / ".xhs-favorites"
        bridge.status_path = bridge.state_dir / "bridge-status.json"
        bridge.catalog_path = root / "catalog.json"
        bridge.boards = {"board": "Board"}
        bridge.board_order = ["board", "board2"]
        bridge.published_since = None
        bridge.video_analysis_enabled = True
        bridge.curation = root / "curation.json"
        bridge.curation.write_text("{}", encoding="utf-8")
        bridge.media_dir = root / "media"
        bridge.media_dir.mkdir()
        bridge.run_dir = root / "runs"
        bridge.run_dir.mkdir()
        bridge.python = Path("python.exe")
        bridge.media_fetcher = Path("download-pending-media.py")
        bridge.xhs_dir = root / "xhs"
        bridge.next_board_id = mock.Mock(return_value="board2")
        bridge.publish_after_board = mock.Mock(return_value=None)
        bridge.tag_catalog_sources = mock.Mock()
        BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {
            self.NOTE_ID: {
                "note_id": self.NOTE_ID, "content_sha256": "a" * 64,
                "comment_evidence_checked": True, "source_board_ids": [], "source_boards": [],
            },
        }})
        return bridge

    def run_board(self, bridge, **patch):
        with mock.patch.object(BRIDGE, "run_bounded_subprocess", **patch):
            bridge.process_import("manual_board", "board", {
                self.NOTE_ID: f"https://www.xiaohongshu.com/explore/{self.NOTE_ID}",
            })
        return json.loads((bridge.state_dir / "runs" / "manual_board.json").read_text(encoding="utf-8"))

    def test_a_downloader_timeout_does_not_fail_the_board(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.make_bridge(Path(directory))
            result = self.run_board(bridge, side_effect=subprocess.TimeoutExpired("downloader", 60))
            log = (bridge.state_dir / "bridge.log").read_text(encoding="utf-8")
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["next_board_id"], "board2")
        self.assertEqual(result["media"]["state"], "failed")
        self.assertEqual(result["media"]["queued"], 1)
        self.assertEqual(result["media"]["downloaded"], 0)
        self.assertIs(result["media"]["safety_stopped"], False)
        self.assertTrue(result["media"]["reason"])
        self.assertIn("TimeoutExpired", log)

    def test_every_other_downloader_failure_also_leaves_the_board_completed(self):
        cases = {
            "crash": SimpleNamespace(returncode=1, stdout=json.dumps({"downloaded": 0}), stderr=""),
            "invalid output": SimpleNamespace(returncode=0, stdout="not json", stderr=""),
            "bad count": SimpleNamespace(returncode=0, stdout=json.dumps({"downloaded": -1}), stderr=""),
            "another worker busy": SimpleNamespace(returncode=0, stdout=json.dumps({"state": "busy"}), stderr=""),
        }
        for name, completed in cases.items():
            with self.subTest(name), tempfile.TemporaryDirectory() as directory:
                bridge = self.make_bridge(Path(directory))
                result = self.run_board(bridge, return_value=completed)
                self.assertEqual(result["state"], "completed")
                self.assertEqual(result["next_board_id"], "board2")
                self.assertEqual(result["media"]["state"], "failed")

    def test_a_downloader_safety_stop_still_stops_the_run(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.make_bridge(Path(directory))
            completed = SimpleNamespace(
                returncode=2, stdout=json.dumps({"downloaded": 0, "safety_stopped": True}), stderr="",
            )
            result = self.run_board(bridge, return_value=completed)
        self.assertEqual(result["state"], "safety-stopped")
        self.assertIsNone(result["next_board_id"])
        self.assertIs(result["media"]["safety_stopped"], True)

    def test_a_crash_that_left_the_safety_stop_marker_still_stops_the_run(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.make_bridge(Path(directory))

            def crash_after_marker(*_args, **_kwargs):
                (bridge.state_dir / "media-download-safety-stop.json").write_text("{}", encoding="utf-8")
                raise subprocess.TimeoutExpired("downloader", 60)

            result = self.run_board(bridge, side_effect=crash_after_marker)
        self.assertEqual(result["state"], "safety-stopped")
        self.assertIsNone(result["next_board_id"])


class FailureReportRecordedFlagTest(unittest.TestCase):
    def make_bridge(self, root):
        bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
        bridge.manual_sync_path = root / "manual-sync.json"
        bridge.processing_lock = threading.Lock()
        bridge.boards = {"board": "Board"}
        bridge.board_order = ["board"]
        bridge.summary_plans = {}
        batch = "manualflag"
        run_id = bridge.manual_run_id(batch, "board")
        BRIDGE.atomic_json(bridge.manual_sync_path, {
            "batch": batch,
            "state": "running",
            "started_at": "2000-01-01T00:00:00+00:00",
            "run_board_ids": ["board"],
            "processed_run_ids": [],
            "scanned": 0,
            "new": 0,
        })
        return bridge, {"run_id": run_id, "board_id": "board", "error": "collection failed"}

    def test_a_failure_report_on_an_active_run_with_the_lock_free_is_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge, payload = self.make_bridge(Path(directory))
            status = bridge.record_manual_failure(payload)
        self.assertIs(status["recorded"], True)
        self.assertEqual(status["state"], "failed")

    def test_a_failure_report_while_the_processing_lock_is_held_is_not_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge, payload = self.make_bridge(Path(directory))
            bridge.processing_lock.acquire()
            try:
                status = bridge.record_manual_failure(payload)
            finally:
                bridge.processing_lock.release()
        self.assertIs(status["recorded"], False)
        self.assertEqual(status["state"], "running")

    def test_a_failure_report_on_an_already_finished_run_is_not_recorded(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge, payload = self.make_bridge(Path(directory))
            first = bridge.record_manual_failure(payload)
            second = bridge.record_manual_failure(payload)
        self.assertIs(first["recorded"], True)
        self.assertIs(second["recorded"], False)
        self.assertEqual(second["state"], "failed")


if __name__ == "__main__":
    unittest.main()
