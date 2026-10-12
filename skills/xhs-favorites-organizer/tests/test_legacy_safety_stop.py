"""A safety stop left by an earlier round must block the next round before any platform request.

These tests drive the bridge through its two public doors: the start request and the status
reply the workbench polls.
"""

from datetime import datetime, timedelta
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "bridge-server.py"
SPEC = importlib.util.spec_from_file_location("xhs_bridge_legacy_stop", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BRIDGE)

STOP_NAME = "media-download-safety-stop.json"
# What the marker from 2026-08-29 in the real private folder looks like: no phase, no run.
OLD_FORMAT_RECORD = {"stopped_at": "2026-08-29T12:00:00+00:00", "reason": "platform-safety-limit"}
# Fields that would make a refused start look like an organisation round that scanned something.
COUNT_FIELDS = {
    "scanned", "new", "board_count", "processed_boards", "summarized", "summary_total",
    "summary_pending", "summary_failed", "summary_batch_aborted", "counts", "phases",
}


def make_bridge(root: Path, *, v2: bool = False):
    bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
    bridge.trigger_lock = threading.Lock()
    bridge.processing_lock = threading.Lock()
    bridge.manual_sync_path = root / "manual-sync.json"
    bridge.board_order = ["first"]
    bridge.boards = {"first": "First"}
    bridge.workspace = root
    bridge.state_dir = root / ".xhs-favorites"
    bridge.state_dir.mkdir(parents=True, exist_ok=True)
    bridge.config_path = root / "config.json"
    bridge.port = 47631
    bridge.profile_url = "https://www.xiaohongshu.com/user/profile/testprofile?tab=fav&subTab=board"
    bridge.organization_status_v2_enabled = v2
    bridge.open_sop_browser_page = mock.Mock(return_value={"id": "target"})
    return bridge


def write_stop(bridge, value=OLD_FORMAT_RECORD):
    BRIDGE.atomic_json(bridge.state_dir / STOP_NAME, value)


class StartIsRefusedTests(unittest.TestCase):
    def test_a_leftover_stop_refuses_the_start_before_the_scan_browser_is_touched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = make_bridge(root)
            write_stop(bridge)

            with mock.patch.object(BRIDGE.subprocess, "Popen") as popen:
                result = bridge.trigger_manual_sync()

            bridge.open_sop_browser_page.assert_not_called()
            popen.assert_not_called()
            self.assertIs(result["refused"], True)
            self.assertEqual(result["state"], "legacy-safety-stop")
            self.assertNotEqual(result["state"], "safety-stopped")
            self.assertEqual(
                result["legacy_safety_stop"],
                {"date": "2026-08-29", "phase": "media_or_detail", "phase_label": "媒体或详情"},
            )
            self.assertIn("2026-08-29", result["error"])
            self.assertIn("尚未清除", result["error"])
            self.assertEqual(COUNT_FIELDS & set(result), set())
            # A refusal is not a round: it leaves no manual-sync record behind.
            self.assertFalse(bridge.manual_sync_path.exists())

    def test_the_refusal_is_not_worded_as_a_stop_raised_by_this_round(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            write_stop(bridge)
            result = bridge.trigger_manual_sync()
            self.assertNotIn("触发安全限制", result["error"])
            self.assertNotIn("已停止本轮", result["error"])

    def test_a_record_that_names_its_phase_shows_that_phase(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            write_stop(bridge, {**OLD_FORMAT_RECORD, "phase": "diandian"})
            result = bridge.trigger_manual_sync()
            self.assertEqual(result["legacy_safety_stop"]["phase"], "diandian")
            self.assertEqual(result["legacy_safety_stop"]["phase_label"], "点点总结")

    def test_an_unreadable_record_also_refuses_the_start(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            (bridge.state_dir / STOP_NAME).write_text("{not json", encoding="utf-8")
            result = bridge.trigger_manual_sync()
            bridge.open_sop_browser_page.assert_not_called()
            self.assertEqual(result["legacy_safety_stop"]["phase"], "unknown")
            self.assertEqual(result["legacy_safety_stop"]["date"], None)

    def test_a_single_note_validation_is_refused_too_because_it_opens_the_scan_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            write_stop(bridge)
            bridge.normalize_manual_sync_request = mock.Mock(
                return_value=(["first"], "history", "n" * 24)
            )
            result = bridge.trigger_manual_sync({"note_id": "n" * 24})
            self.assertIs(result["refused"], True)
            bridge.open_sop_browser_page.assert_not_called()

    def test_an_archived_record_does_not_refuse_the_start(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = make_bridge(root)
            BRIDGE.atomic_json(
                bridge.state_dir / "media-download-safety-stop.archived-20260829.json",
                OLD_FORMAT_RECORD,
            )
            with mock.patch.object(BRIDGE.subprocess, "Popen"):
                result = bridge.trigger_manual_sync()
            self.assertEqual(result["state"], "starting")
            self.assertNotIn("refused", result)
            bridge.open_sop_browser_page.assert_called_once()

    def test_a_running_round_still_reports_busy_before_anything_else(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            bridge.processing_lock.acquire()
            try:
                write_stop(bridge)
                with self.assertRaises(BRIDGE.BridgeBusyError):
                    bridge.trigger_manual_sync()
            finally:
                bridge.processing_lock.release()


class StatusReplyTests(unittest.TestCase):
    def test_the_status_reply_carries_the_leftover_stop_without_a_manual_sync_record(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            write_stop(bridge)
            status = bridge.manual_sync_status()
            self.assertEqual(status["state"], "idle")
            self.assertEqual(
                status["legacy_safety_stop"],
                {"date": "2026-08-29", "phase": "media_or_detail", "phase_label": "媒体或详情"},
            )

    def test_the_status_reply_carries_it_next_to_the_last_finished_round(self):
        with tempfile.TemporaryDirectory() as directory:
            for v2 in (False, True):
                with self.subTest(v2=v2):
                    bridge = make_bridge(Path(directory), v2=v2)
                    write_stop(bridge)
                    BRIDGE.atomic_json(bridge.manual_sync_path, {
                        "batch": "manualdone", "state": "completed", "scanned": 5, "new": 2,
                        "started_at": "2026-10-10T08:00:00+00:00",
                        "processed_run_ids": [], "run_board_ids": ["first"],
                    })
                    status = bridge.manual_sync_status()
                    self.assertEqual(status["legacy_safety_stop"]["date"], "2026-08-29")
                    self.assertNotEqual(status.get("state"), "safety-stopped")

    def test_no_leftover_means_no_field(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            self.assertNotIn("legacy_safety_stop", bridge.manual_sync_status())

    def test_a_stop_written_after_the_running_round_began_is_not_a_leftover(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            began = datetime.now().astimezone() - timedelta(minutes=5)
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manualnow", "state": "running", "started_at": began.isoformat(),
                "processed_run_ids": [], "run_board_ids": ["first"],
            })
            write_stop(bridge, {
                "stopped_at": (began + timedelta(minutes=2)).isoformat(),
                "reason": "platform-safety-limit", "phase": "media",
            })
            self.assertNotIn("legacy_safety_stop", bridge.manual_sync_status())

    def test_a_stop_older_than_the_running_round_is_still_shown_as_a_leftover(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            began = datetime.now().astimezone() - timedelta(minutes=5)
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manualnow", "state": "running", "started_at": began.isoformat(),
                "processed_run_ids": [], "run_board_ids": ["first"],
            })
            write_stop(bridge)
            self.assertEqual(
                bridge.manual_sync_status()["legacy_safety_stop"]["date"], "2026-08-29"
            )


class ClearTests(unittest.TestCase):
    def test_clearing_archives_the_record_then_starts_a_round_in_one_step(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            write_stop(bridge)

            with mock.patch.object(BRIDGE.subprocess, "Popen"):
                reply = bridge.clear_safety_stop()

            self.assertIs(reply["cleared"], True)
            self.assertIs(reply["started"], True)
            self.assertEqual(reply["status"]["state"], "starting")
            self.assertNotIn("legacy_safety_stop", reply["status"])
            bridge.open_sop_browser_page.assert_called_once()
            self.assertFalse((bridge.state_dir / STOP_NAME).exists())
            archived = bridge.state_dir / "media-download-safety-stop.archived-20260829.json"
            self.assertEqual(json.loads(archived.read_text(encoding="utf-8")), OLD_FORMAT_RECORD)
            self.assertEqual(bridge.read_manual_sync()["state"], "starting")

    def test_clearing_when_nothing_is_recorded_changes_nothing_and_says_so(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            reply = bridge.clear_safety_stop()
            self.assertIs(reply["cleared"], False)
            self.assertIs(reply["started"], False)
            self.assertEqual(reply["status"]["state"], "idle")
            bridge.open_sop_browser_page.assert_not_called()
            self.assertFalse(bridge.manual_sync_path.exists())
            self.assertEqual(list(bridge.state_dir.iterdir()), [])

    def test_clearing_does_not_touch_the_record_while_a_round_is_running(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            write_stop(bridge)
            bridge.processing_lock.acquire()
            try:
                with self.assertRaises(BRIDGE.BridgeBusyError):
                    bridge.clear_safety_stop()
            finally:
                bridge.processing_lock.release()
            self.assertTrue((bridge.state_dir / STOP_NAME).is_file())
            bridge.open_sop_browser_page.assert_not_called()

    def test_a_cleared_stop_no_longer_refuses_the_next_start(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            write_stop(bridge)
            bridge.clear_safety_stop()
            BRIDGE.atomic_json(bridge.manual_sync_path, {"batch": "done", "state": "completed"})
            with mock.patch.object(BRIDGE.subprocess, "Popen"):
                result = bridge.trigger_manual_sync()
            self.assertEqual(result["state"], "starting")
            self.assertEqual(bridge.open_sop_browser_page.call_count, 2)


class ClearRouteTests(unittest.TestCase):
    TOKEN = "a" * 64

    def serve(self, bridge):
        server = BRIDGE.ThreadingHTTPServer((BRIDGE.HOST, 0), BRIDGE.make_handler(bridge))
        bridge.port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(timeout=2)))
        return bridge

    def post(self, bridge, body=b"{}", *, token=TOKEN, origin=BRIDGE.MANAGER_ORIGIN):
        headers = {"Content-Type": "application/json", "X-XHS-Bridge-Token": token}
        if origin is not None:
            headers["Origin"] = origin
        request = Request(
            f"http://{BRIDGE.HOST}:{bridge.port}/sync/safety-stop/clear",
            data=body, headers=headers, method="POST",
        )
        try:
            with urlopen(request, timeout=2) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    def test_the_clear_route_needs_the_local_credential_and_the_workbench_origin(self):
        bridge = self.serve(SimpleNamespace(
            port=0, token=self.TOKEN,
            clear_safety_stop=mock.Mock(return_value={"cleared": False, "started": False, "status": {}}),
        ))
        for kwargs in ({"token": "b" * 64}, {"origin": "https://attacker.invalid"}, {"origin": None}):
            with self.subTest(**kwargs):
                # No body: the bridge answers a bad credential before reading one, and a body it never
                # reads can reset the connection on Windows before the client has seen the answer.
                status, body = self.post(bridge, b"", **kwargs)
                self.assertEqual(status, BRIDGE.HTTPStatus.UNAUTHORIZED)
                self.assertEqual(body, {"ok": False})
        bridge.clear_safety_stop.assert_not_called()

    def test_a_valid_clear_request_is_forwarded_once_and_answered_with_the_result(self):
        result = {"cleared": True, "started": True, "status": {"state": "starting"}}
        bridge = self.serve(SimpleNamespace(
            port=0, token=self.TOKEN, clear_safety_stop=mock.Mock(return_value=result),
        ))
        status, body = self.post(bridge)
        self.assertEqual(status, BRIDGE.HTTPStatus.ACCEPTED)
        self.assertEqual(body, {"ok": True, **result})
        bridge.clear_safety_stop.assert_called_once_with()

    def test_a_clear_request_that_finds_nothing_answers_ok_without_starting(self):
        result = {"cleared": False, "started": False, "status": {"state": "idle"}}
        bridge = self.serve(SimpleNamespace(
            port=0, token=self.TOKEN, clear_safety_stop=mock.Mock(return_value=result),
        ))
        status, body = self.post(bridge)
        self.assertEqual(status, BRIDGE.HTTPStatus.OK)
        self.assertEqual(body["cleared"], False)

    def test_a_clear_request_with_a_body_is_rejected_before_anything_is_cleared(self):
        bridge = self.serve(SimpleNamespace(
            port=0, token=self.TOKEN, clear_safety_stop=mock.Mock(),
        ))
        status, body = self.post(bridge, b'{"force": true}')
        self.assertEqual(status, BRIDGE.HTTPStatus.BAD_REQUEST)
        self.assertIs(body["ok"], False)
        bridge.clear_safety_stop.assert_not_called()

    def test_a_clear_request_during_a_running_round_is_a_conflict(self):
        bridge = self.serve(SimpleNamespace(
            port=0, token=self.TOKEN,
            clear_safety_stop=mock.Mock(side_effect=BRIDGE.BridgeBusyError("already running")),
        ))
        status, body = self.post(bridge)
        self.assertEqual(status, BRIDGE.HTTPStatus.CONFLICT)
        self.assertIs(body["ok"], False)


class StartRouteTests(unittest.TestCase):
    def test_the_start_route_answers_a_refusal_with_a_readable_conflict_not_a_busy_error(self):
        token = "a" * 64
        refusal = {
            "refused": True,
            "state": "legacy-safety-stop",
            "error": "2026-08-29 的安全停止尚未清除",
            "legacy_safety_stop": {
                "date": "2026-08-29", "phase": "media_or_detail", "phase_label": "媒体或详情",
            },
        }
        bridge = SimpleNamespace(
            port=0, token=token, trigger_manual_sync=mock.Mock(return_value=refusal)
        )
        server = BRIDGE.ThreadingHTTPServer((BRIDGE.HOST, 0), BRIDGE.make_handler(bridge))
        bridge.port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            request = Request(
                f"http://{BRIDGE.HOST}:{bridge.port}/sync/start",
                data=b"{}",
                headers={
                    "Content-Type": "application/json",
                    "Origin": BRIDGE.MANAGER_ORIGIN,
                    "X-XHS-Bridge-Token": token,
                },
                method="POST",
            )
            with self.assertRaises(HTTPError) as caught:
                urlopen(request, timeout=2)
            self.assertEqual(caught.exception.code, BRIDGE.HTTPStatus.CONFLICT)
            body = json.loads(caught.exception.read().decode("utf-8"))
            self.assertIs(body["ok"], False)
            self.assertEqual(body["state"], "legacy-safety-stop")
            self.assertEqual(body["legacy_safety_stop"]["date"], "2026-08-29")
            self.assertEqual(body["error"], "2026-08-29 的安全停止尚未清除")
            self.assertNotIn("refused", body)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
