"""Two sync-service behaviours that only failed on Windows, and only now and then.

A refused POST must still be answered, whatever the client sent along with it: Windows resets a
connection that is closed with request data still unread, so the client saw a dropped connection
instead of the refusal. And the publish lock's path check must treat a brief sharing conflict
(Windows error 32, for example a virus scan touching the file) as "busy, try again", never as
"unsafe".
"""

import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import bridge_support


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "bridge-server.py"
SPEC = importlib.util.spec_from_file_location("xhs_bridge_windows_stability", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BRIDGE)

TOKEN = "a" * 64
REPEATS = 200
# Large enough that, before the fix, the connection broke on a visible share of requests.
BIG_BODY = json.dumps({"padding": "x" * 100_000}).encode("utf-8")


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

    def post(self, path, body, *, token=TOKEN, origin=BRIDGE.MANAGER_ORIGIN, host=None):
        headers = {
            "Content-Type": "application/json",
            "Origin": origin,
            "X-XHS-Bridge-Token": token,
        }
        if host is not None:
            headers["Host"] = host
        request = Request(
            f"http://{BRIDGE.HOST}:{self.bridge.port}{path}",
            data=body,
            headers=headers,
            method="POST",
        )
        try:
            # Generous on purpose: this test looks for a dropped connection, and a rare multi-second
            # stall on a busy machine is not one. A handler that truly hangs still fails, just later.
            with urlopen(request, timeout=30) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            with error:
                return error.code, json.loads(error.read().decode("utf-8"))

    def raw_post_headers_only(self, path, declared_length, *, token=TOKEN):
        """Send only the headers of a POST that claims `declared_length` bytes, then read the reply."""
        connection = http.client.HTTPConnection(BRIDGE.HOST, self.bridge.port, timeout=15)
        try:
            connection.putrequest("POST", path, skip_host=False)
            connection.putheader("Content-Type", "application/json")
            connection.putheader("Origin", BRIDGE.MANAGER_ORIGIN)
            connection.putheader("X-XHS-Bridge-Token", token)
            connection.putheader("Content-Length", str(declared_length))
            connection.endheaders()
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()


def stand_in_bridge():
    return SimpleNamespace(
        port=0,
        token=TOKEN,
        trigger_manual_sync=mock.Mock(return_value={"state": "starting", "board_count": 1}),
        open_original_note=mock.Mock(return_value={"opened": True}),
    )


class RefusedPostIsAlwaysAnsweredTest(unittest.TestCase):
    def assert_every_refusal_arrives(self, status_expected, **post_options):
        path = post_options.pop("path")
        bridge = stand_in_bridge()
        broken = []
        wrong = []
        with RunningHandler(bridge) as handler:
            for _ in range(REPEATS):
                try:
                    status, body = handler.post(path, BIG_BODY, **post_options)
                except (URLError, OSError) as error:
                    broken.append(repr(error))
                    continue
                if (status, body) != (status_expected, {"ok": False}):
                    wrong.append((status, body))
        self.assertEqual(broken, [], "the refusal never reached the client")
        self.assertEqual(wrong, [])
        # A refusal is never a way in: nothing behind the handler ran.
        bridge.trigger_manual_sync.assert_not_called()
        bridge.open_original_note.assert_not_called()

    def test_wrong_token_gets_401_every_time(self):
        self.assert_every_refusal_arrives(401, path="/notes/open", token="b" * 64)

    def test_wrong_origin_gets_401_every_time(self):
        self.assert_every_refusal_arrives(401, path="/sync/start", origin="https://attacker.invalid")

    def test_wrong_host_gets_404_every_time(self):
        self.assert_every_refusal_arrives(404, path="/notes/open", host="evil.invalid")

    def test_unknown_path_gets_404_every_time(self):
        self.assert_every_refusal_arrives(404, path="/not-a-route")

    def test_an_accepted_request_still_reaches_its_handler_with_the_exact_body(self):
        bridge = stand_in_bridge()
        body = json.dumps({"note_id": "n" * 24}).encode("utf-8")
        with RunningHandler(bridge) as handler:
            status, reply = handler.post("/notes/open", body)
        self.assertEqual(status, 202)
        self.assertEqual(reply, {"ok": True, "opened": True})
        bridge.open_original_note.assert_called_once_with("n" * 24)

    def test_a_body_over_the_size_limit_is_refused_without_being_read(self):
        # The client sends the headers and nothing else: a handler that waited for the claimed
        # bytes would hang here, so the reply arriving at all is the proof it did not read them.
        oversize = BRIDGE.MAX_BODY_BYTES + 1
        for token, expected in ((TOKEN, 400), ("b" * 64, 401)):
            with self.subTest(expected=expected):
                bridge = stand_in_bridge()
                with RunningHandler(bridge) as handler:
                    try:
                        status, _ = handler.raw_post_headers_only("/notes/open", oversize, token=token)
                    except (socket.timeout, OSError) as error:
                        self.fail(f"the handler waited for an oversize body: {error!r}")
                self.assertEqual(status, expected)
                bridge.open_original_note.assert_not_called()


def sharing_violation(code=32):
    """The error Windows raises when another program briefly holds the file (32) or similar."""
    error = PermissionError(13, "The process cannot access the file because it is being used by another process")
    error.winerror = code
    return error


class FlakyLstat:
    """Stands in for `os.lstat`: the first `failures` looks at a watched name raise, the rest are real."""

    def __init__(self, watched_names, failures, code=32):
        self.watched_names = set(watched_names)
        self.failures = failures
        self.code = code
        self.raised = 0
        self._real = os.lstat

    def __call__(self, path, *args, **kwargs):
        if Path(path).name in self.watched_names and self.raised < self.failures:
            self.raised += 1
            raise sharing_violation(self.code)
        return self._real(path, *args, **kwargs)


class PublishLockPathCheckTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.state_dir = self.root / ".xhs-favorites"
        self.state_dir.mkdir()

    def hold_lock(self, flaky):
        with mock.patch.object(BRIDGE.os, "lstat", flaky):
            with BRIDGE.publish_claim_lock(self.state_dir, "manual_board"):
                return True

    def test_a_brief_sharing_conflict_on_the_lock_folder_is_waited_out(self):
        flaky = FlakyLstat({"publish-claims"}, failures=3)
        self.assertTrue(self.hold_lock(flaky))
        self.assertEqual(flaky.raised, 3)

    def test_a_brief_sharing_conflict_on_an_existing_lock_file_is_waited_out(self):
        claims = self.state_dir / "publish-claims"
        claims.mkdir()
        (claims / "manual_board.lock").write_bytes(b"")
        flaky = FlakyLstat({"manual_board.lock"}, failures=3)
        self.assertTrue(self.hold_lock(flaky))
        self.assertEqual(flaky.raised, 3)

    def test_a_conflict_that_never_clears_is_refused_when_the_wait_ends(self):
        flaky = FlakyLstat({"publish-claims"}, failures=10**9)
        with mock.patch.object(BRIDGE, "PUBLISH_LOCK_WAIT_SECONDS", 0.2):
            with self.assertRaisesRegex(ValueError, "unavailable or unsafe"):
                self.hold_lock(flaky)
        self.assertGreater(flaky.raised, 1, "the check gave up without waiting")

    def test_any_other_error_code_is_refused_at_once(self):
        flaky = FlakyLstat({"publish-claims"}, failures=10**9, code=5)
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, "unavailable or unsafe"):
            self.hold_lock(flaky)
        self.assertEqual(flaky.raised, 1)
        self.assertLess(time.monotonic() - started, 5)

    def test_a_missing_lock_folder_is_still_refused_at_once(self):
        # Not a sharing conflict: nothing to wait for.
        missing = self.root / "no-such-state"
        with self.assertRaisesRegex(ValueError, "unavailable or unsafe"):
            with BRIDGE.publish_claim_lock(missing, "manual_board"):
                pass

    def test_a_claim_survives_a_brief_conflict_and_still_publishes_only_once(self):
        bridge = bridge_support.make_bridge(BRIDGE, self.root)
        bridge.summary_plans = {"manual_board": set()}
        BRIDGE.atomic_json(bridge.manual_sync_path, {
            "batch": "manual",
            "state": "running",
            "run_board_ids": ["board"],
            "summary_finalizing": True,
        })
        flaky = FlakyLstat({"publish-claims"}, failures=3)
        with mock.patch.object(BRIDGE.os, "lstat", flaky):
            first = bridge.claim_diandian_publish("manual_board", "board", "a" * 64, "b" * 64)
            second = bridge.claim_diandian_publish("manual_board", "board", "a" * 64, "b" * 64)
        self.assertEqual((first, second), (True, False))
        self.assertEqual(flaky.raised, 3)


if __name__ == "__main__":
    unittest.main()
