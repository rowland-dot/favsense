"""An installed user script older than the sync service is refused, not discovered by a mid-round timeout.

The sync service learns which template the installed script came from when the install completes, and
every request the script makes names it. These tests drive the two public doors: the start request and
the HTTP routes the script calls.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import re
import tempfile
import threading
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import bridge_support


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "bridge-server.py"
SPEC = importlib.util.spec_from_file_location("xhs_bridge_userscript_outdated", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BRIDGE)

CONTRACT = json.loads(
    (Path(__file__).parents[3] / "site" / "organization-status-contract.json").read_text(encoding="utf-8")
)
REINSTALL_SENTENCE = CONTRACT["copy"]["userscript_outdated"]
VERSION_HEADER = "X-XHS-Userscript-Version"
# Fields that would make a refused start look like an organisation round that scanned something.
COUNT_FIELDS = {"scanned", "new", "board_count", "processed_boards", "counts", "phases"}
CAPABILITY_RECORD_KEYS = {"version", "digest", "issued_at", "expires_at"}


def make_bridge(root: Path):
    bridge = bridge_support.make_bridge(BRIDGE, root)
    bridge.open_sop_browser_page = mock.Mock(return_value={"id": "target"})
    return bridge


def install_record(bridge) -> dict:
    return json.loads(bridge.userscript_install_state.read_text(encoding="utf-8"))


def set_installed_version(bridge, version: str | None) -> None:
    """Rewrite the install record as an install of `version` left it (None: a record that predates versions)."""
    record = {key: value for key, value in install_record(bridge).items() if key != "template_version"}
    if version is not None:
        record["template_version"] = version
    BRIDGE.atomic_json(bridge.userscript_install_state, record)


class StartRefusalTests(unittest.TestCase):
    def test_a_start_is_refused_when_the_recorded_version_is_not_the_templates_current_one(self):
        outdated = {"older": "3.0.3", "newer": "99.0.0"}
        for name, version in outdated.items():
            with self.subTest(installed=name), tempfile.TemporaryDirectory() as directory:
                bridge = make_bridge(Path(directory))
                set_installed_version(bridge, version)

                with mock.patch.object(BRIDGE.subprocess, "Popen") as popen:
                    result = bridge.trigger_manual_sync()

                bridge.open_sop_browser_page.assert_not_called()
                popen.assert_not_called()
                self.assertIs(result["refused"], True)
                self.assertEqual(result["state"], "userscript-outdated")
                self.assertEqual(result["error"], REINSTALL_SENTENCE)
                self.assertEqual(COUNT_FIELDS & set(result), set())
                # A refusal is not a round: it leaves no manual-sync record behind.
                self.assertFalse(bridge.manual_sync_path.exists())

    def test_a_fresh_install_with_no_recorded_version_still_starts_the_round(self):
        # The version is only ever learned from a script request, and a script only runs once a page loads,
        # so refusing here would be a deadlock: the sync would never open the page that records it.
        for name, version in {"no stored version": None, "empty": ""}.items():
            with self.subTest(installed=name), tempfile.TemporaryDirectory() as directory:
                bridge = make_bridge(Path(directory))
                set_installed_version(bridge, version)

                with mock.patch.object(BRIDGE.subprocess, "Popen"):
                    result = bridge.trigger_manual_sync()

                self.assertNotIn("refused", result)
                self.assertEqual(result["phases"]["core"]["status"], "running")
                bridge.open_sop_browser_page.assert_called_once()

    def test_the_current_version_starts_the_round(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            set_installed_version(bridge, bridge_support.USERSCRIPT_VERSION)
            with mock.patch.object(BRIDGE.subprocess, "Popen"):
                result = bridge.trigger_manual_sync()
            self.assertNotIn("refused", result)
            self.assertEqual(result["phases"]["core"]["status"], "running")
            bridge.open_sop_browser_page.assert_called_once()

    def test_the_status_shows_an_outdated_install_before_any_round_is_started(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            self.assertNotIn("userscript_outdated", bridge.manual_sync_status())
            # Nothing recorded yet is not "outdated": the workbench must not tell the owner to reinstall
            # a script he has just installed.
            set_installed_version(bridge, None)
            self.assertNotIn("userscript_outdated", bridge.manual_sync_status())
            set_installed_version(bridge, "3.0.3")
            status = bridge.manual_sync_status()
            self.assertIs(status["userscript_outdated"], True)
            self.assertEqual(status["state"], "idle")

    def test_clearing_a_leftover_stop_does_not_archive_it_when_the_install_is_outdated(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            stop = bridge.state_dir / "media-download-safety-stop.json"
            BRIDGE.atomic_json(stop, {"stopped_at": "2026-08-29T12:00:00+00:00", "reason": "platform-safety-limit"})
            set_installed_version(bridge, "3.0.3")

            reply = bridge.clear_safety_stop()

            self.assertIs(reply["cleared"], False)
            self.assertIs(reply["started"], False)
            self.assertTrue(stop.is_file(), "the stop stays on record until a round can really start")
            bridge.open_sop_browser_page.assert_not_called()


class GeneratedScriptTests(unittest.TestCase):
    def test_the_generated_script_carries_the_templates_numeric_version_and_no_placeholder(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(Path(directory))
            script = bridge.userscript_content()
            self.assertIn(f'const TEMPLATE_VERSION = "{bridge_support.USERSCRIPT_VERSION}";', script)
            self.assertNotIn("__TEMPLATE_VERSION__", script)

    def test_every_route_the_template_calls_is_checked_and_no_workbench_route_is(self):
        template = bridge_support.USERSCRIPT_TEMPLATE.read_text(encoding="utf-8")
        called = set(re.findall(r"\b(?:post|get)\(\s*[`\"'](/[A-Za-z0-9/_-]+)", template))
        self.assertIn("/import-sync", called)
        self.assertIn("/sync/page-task", called)
        self.assertEqual(called - BRIDGE.USERSCRIPT_ROUTES, set())
        workbench = {"/boards", "/sync/start", "/sync/local-rebuild", "/sync/safety-stop/clear",
                     "/notes/organization-status", "/sync/status", "/local-session"}
        self.assertEqual(workbench & BRIDGE.USERSCRIPT_ROUTES, set())


class RouteTests(unittest.TestCase):
    def serve(self, bridge):
        server = BRIDGE.ThreadingHTTPServer((BRIDGE.HOST, 0), BRIDGE.make_handler(bridge))
        bridge.port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(lambda: (server.shutdown(), server.server_close(), thread.join(timeout=2)))
        return bridge

    def call(self, bridge, method, path, body=None, *, version="current", origin=None):
        headers = {"Content-Type": "application/json", "X-XHS-Bridge-Token": bridge.token}
        if version == "current":
            version = bridge_support.USERSCRIPT_VERSION
        if version is not None:
            headers[VERSION_HEADER] = version
        if origin is not None:
            headers["Origin"] = origin
        request = Request(
            f"http://{BRIDGE.HOST}:{bridge.port}{path}",
            data=None if body is None else json.dumps(body).encode("utf-8"),
            headers=headers, method=method,
        )
        try:
            with urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            return error.code, json.loads(error.read().decode("utf-8"))

    def bridge_with_round(self, directory):
        bridge = self.serve(make_bridge(Path(directory)))
        with mock.patch.object(BRIDGE.subprocess, "Popen"):
            bridge.trigger_manual_sync()
        return bridge

    def test_a_script_request_without_the_version_or_with_another_one_is_refused(self):
        calls = [
            ("POST", "/sync/discover", {"batch": "b", "boards": []}),
            ("GET", "/sync/board-context?batch=b&board_id=board", None),
            ("GET", "/sync/page-task?worker_id=44444444-4444-4444-8444-444444444444", None),
            ("POST", "/sync/page-result", {"worker_id": "x", "stage": "share", "ok": True}),
        ]
        for method, path, body in calls:
            for version in (None, "3.0.3", "99.0.0"):
                with self.subTest(path=path, version=version), tempfile.TemporaryDirectory() as directory:
                    bridge = self.serve(make_bridge(Path(directory)))
                    status, reply = self.call(bridge, method, path, body, version=version)
                    self.assertEqual(status, BRIDGE.HTTPStatus.CONFLICT)
                    self.assertIs(reply["ok"], False)
                    self.assertEqual(reply["reason"], "userscript-outdated")
                    self.assertEqual(reply["error"], REINSTALL_SENTENCE)
                    # Nothing was running, so there is no round to stop and no record to write.
                    self.assertFalse(bridge.manual_sync_path.exists())

    def test_a_current_script_request_gets_past_the_version_check(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.serve(make_bridge(Path(directory)))
            status, reply = self.call(bridge, "GET", "/sync/page-task?worker_id=bad")
            self.assertEqual(status, BRIDGE.HTTPStatus.BAD_REQUEST)
            self.assertNotEqual(reply.get("reason"), "userscript-outdated")

    def test_workbench_routes_do_not_need_the_version(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.serve(make_bridge(Path(directory)))
            for path in ("/local-session", "/sync/status", "/boards"):
                with self.subTest(path=path):
                    status, reply = self.call(
                        bridge, "GET", path, version=None, origin=BRIDGE.MANAGER_ORIGIN
                    )
                    self.assertEqual(status, BRIDGE.HTTPStatus.OK)
                    self.assertIs(reply["ok"], True)

    def test_a_refused_request_stops_a_running_round_with_the_reinstall_sentence(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.bridge_with_round(directory)
            self.assertEqual(bridge.read_manual_sync()["state"], "starting")

            status, _reply = self.call(
                bridge, "POST", "/sync/discover", {"batch": "b", "boards": []}, version=None
            )

            self.assertEqual(status, BRIDGE.HTTPStatus.CONFLICT)
            shown = bridge.manual_sync_status()
            self.assertEqual(shown["copy_key"], "userscript_outdated")
            self.assertEqual(shown["state"], "failed")
            self.assertEqual(shown["phases"]["core"]["status"], "failed")
            self.assertEqual(shown["phases"]["core"]["reason_code"], "userscript_outdated")
            self.assertEqual(bridge.read_manual_sync()["error"], REINSTALL_SENTENCE)

    def test_a_refused_share_stage_request_halts_the_run_without_waiting_for_the_share_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.bridge_with_round(directory)
            batch = bridge.read_manual_sync()["batch"]
            worker = "55555555-5555-4555-8555-555555555555"
            bridge.register_page_task(
                worker, "share", run_id=bridge.manual_run_id(batch, "board"), board_id="board",
                note_id="n" * 24, title="t", batch=batch,
            )

            status, _reply = self.call(
                bridge, "GET", f"/sync/page-task?worker_id={worker}", version="3.0.3"
            )

            self.assertEqual(status, BRIDGE.HTTPStatus.CONFLICT)
            state = bridge.read_manual_sync()
            self.assertEqual(state["summary_halt_reason"], "userscript-outdated")
            self.assertNotEqual(state["summary_halt_reason"], "share-worker-not-ready")
            self.assertEqual(bridge.manual_sync_status()["copy_key"], "userscript_outdated")
            self.assertTrue(bridge.diandian_is_halted(bridge.manual_run_id(batch, "board")))

    def test_a_round_that_cannot_be_stopped_does_not_hide_the_refusal_from_the_script(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.serve(make_bridge(Path(directory)))
            bridge.stop_round_for_outdated_userscript = mock.Mock(side_effect=RuntimeError("record unreadable"))

            status, reply = self.call(bridge, "POST", "/sync/discover", {"batch": "b", "boards": []}, version=None)

            self.assertEqual(status, BRIDGE.HTTPStatus.CONFLICT)
            self.assertEqual(reply["error"], REINSTALL_SENTENCE)
            log = (bridge.state_dir / BRIDGE.BRIDGE_LOG_NAME).read_text(encoding="utf-8")
            self.assertIn("INTERNAL\tscript-outdated\t-\tRuntimeError\trecord unreadable", log)

    def test_completing_an_install_stores_the_template_version_and_the_next_start_is_not_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.serve(make_bridge(Path(directory)))
            set_installed_version(bridge, None)
            self.assertEqual(set(install_record(bridge)), CAPABILITY_RECORD_KEYS)

            status, reply = self.call(
                bridge, "POST", "/install/complete", {"capability": bridge_support.INSTALL_CAPABILITY}
            )

            self.assertEqual(status, BRIDGE.HTTPStatus.OK)
            self.assertIs(reply["invalidated"], True)
            self.assertEqual(install_record(bridge)["template_version"], bridge_support.USERSCRIPT_VERSION)
            with mock.patch.object(BRIDGE.subprocess, "Popen"):
                started = bridge.trigger_manual_sync()
            self.assertNotIn("refused", started)

    def test_an_install_completion_from_an_older_script_stores_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.serve(make_bridge(Path(directory)))
            set_installed_version(bridge, None)

            status, _reply = self.call(
                bridge, "POST", "/install/complete", {"capability": bridge_support.INSTALL_CAPABILITY},
                version="3.0.3",
            )

            self.assertEqual(status, BRIDGE.HTTPStatus.CONFLICT)
            self.assertEqual(set(install_record(bridge)), CAPABILITY_RECORD_KEYS)


    # A freshly installed script is known by its first request: the header is the proof of what runs.

    def test_a_fresh_install_starts_then_its_first_request_records_the_version_and_later_starts_are_not_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.serve(make_bridge(Path(directory)))
            set_installed_version(bridge, None)
            self.assertEqual(set(install_record(bridge)), CAPABILITY_RECORD_KEYS)

            # No Xiaohongshu page has been visited and the install was never completed by the script.
            with mock.patch.object(BRIDGE.subprocess, "Popen"):
                started = bridge.trigger_manual_sync()
            self.assertNotIn("refused", started)
            bridge.open_sop_browser_page.assert_called_once()
            self.assertEqual(set(install_record(bridge)), CAPABILITY_RECORD_KEYS)

            status, _reply = self.call(bridge, "GET", "/sync/page-task?worker_id=bad")

            self.assertEqual(status, BRIDGE.HTTPStatus.BAD_REQUEST)
            self.assertEqual(install_record(bridge)["template_version"], bridge_support.USERSCRIPT_VERSION)
            self.assertEqual(bridge.read_manual_sync()["state"], "starting", "the round the request belongs to goes on")

            BRIDGE.atomic_json(bridge.manual_sync_path, {**bridge.read_manual_sync(), "state": "completed"})
            with mock.patch.object(BRIDGE.subprocess, "Popen"):
                again = bridge.trigger_manual_sync()
            self.assertNotIn("refused", again)

    def test_every_kind_of_script_route_records_the_version_from_a_current_request(self):
        calls = [
            ("GET", "/sync/page-task?worker_id=bad", None),
            ("POST", "/sync/discover", {"batch": "b", "boards": []}),
        ]
        for method, path, body in calls:
            with self.subTest(path=path), tempfile.TemporaryDirectory() as directory:
                bridge = self.serve(make_bridge(Path(directory)))
                set_installed_version(bridge, None)

                self.call(bridge, method, path, body)

                self.assertEqual(install_record(bridge)["template_version"], bridge_support.USERSCRIPT_VERSION)

    def test_a_request_that_is_not_a_current_authorized_script_request_records_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.serve(make_bridge(Path(directory)))
            set_installed_version(bridge, None)

            # An old or header-less script is refused and teaches the server nothing.
            for version in (None, "3.0.3"):
                self.call(bridge, "POST", "/sync/discover", {"batch": "b", "boards": []}, version=version)
            # A request with the right header but not the local credential is not the script either.
            request = Request(
                f"http://{BRIDGE.HOST}:{bridge.port}/sync/page-task?worker_id=bad",
                headers={"X-XHS-Bridge-Token": "c" * 64, VERSION_HEADER: bridge_support.USERSCRIPT_VERSION},
            )
            with self.assertRaises(HTTPError):
                urlopen(request, timeout=3)
            # A workbench route carries no version and does not count either.
            self.call(bridge, "GET", "/sync/status", version=bridge_support.USERSCRIPT_VERSION, origin=BRIDGE.MANAGER_ORIGIN)

            self.assertEqual(set(install_record(bridge)), CAPABILITY_RECORD_KEYS)

    def test_a_current_request_corrects_a_recorded_version_that_differs(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.serve(make_bridge(Path(directory)))
            set_installed_version(bridge, "3.0.3")
            self.assertTrue(bridge.userscript_is_outdated())

            self.call(bridge, "GET", "/sync/page-task?worker_id=bad")

            self.assertEqual(install_record(bridge)["template_version"], bridge_support.USERSCRIPT_VERSION)
            self.assertFalse(bridge.userscript_is_outdated())

    def test_recording_the_version_keeps_a_completed_install_completed(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = self.serve(make_bridge(Path(directory)))
            completed_at = "2026-10-16T09:00:00+00:00"
            BRIDGE.atomic_json(bridge.userscript_install_state, {
                **install_record(bridge), "completed_at": completed_at, "template_version": "3.0.3",
            })

            self.call(bridge, "GET", "/sync/page-task?worker_id=bad")

            record = install_record(bridge)
            self.assertEqual(record["completed_at"], completed_at)
            self.assertEqual(record["template_version"], bridge_support.USERSCRIPT_VERSION)
            # The spent install address stays spent.
            status, _reply = self.call(
                bridge, "GET", f"/install/{bridge_support.INSTALL_CAPABILITY}/xhs-favorites.user.js", version=None
            )
            self.assertEqual(status, BRIDGE.HTTPStatus.NOT_FOUND)


if __name__ == "__main__":
    unittest.main()
