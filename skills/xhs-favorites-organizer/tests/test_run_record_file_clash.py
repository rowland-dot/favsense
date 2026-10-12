"""A briefly busy file on Windows must not lose a run-record update or blank the record.

Seams (the issue's agent brief): the sync service's atomic JSON write, the run record's event
reporting and reading through the real service, and the status route's read of a round's file.
"""

import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from urllib.request import Request, urlopen

import bridge_support


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "bridge-server.py"
SPEC = importlib.util.spec_from_file_location("xhs_bridge_file_clash", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BRIDGE)

SHORT_WAIT = 0.3


def clash(code=5, errno_value=13):
    """What Windows raises when a file is open elsewhere (5), shared (32), or another code."""
    error = PermissionError(errno_value, "The process cannot access the file")
    if code is not None:
        error.winerror = code
    return error


class FlakyReplace:
    """Stands in for `os.replace`: the first `failures` replacements onto the watched name raise."""

    def __init__(self, watched_name, failures, error_factory=clash):
        self.watched_name = watched_name
        self.failures = failures
        self.error_factory = error_factory
        self.calls = 0
        self._real = os.replace

    def __call__(self, source, target, *args, **kwargs):
        if Path(target).name == self.watched_name:
            self.calls += 1
            if self.calls <= self.failures:
                raise self.error_factory()
        return self._real(source, target, *args, **kwargs)


class AtomicWriteWaitsForABusyFileTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.folder = Path(directory.name)
        self.target = self.folder / "record.json"
        self.target.write_text(json.dumps({"value": "old"}), encoding="utf-8")

    def leftovers(self):
        return sorted(path.name for path in self.folder.iterdir() if path.name != "record.json")

    def test_access_denied_then_clear_still_writes_the_new_value(self):
        for code in (5, 32):
            with self.subTest(winerror=code):
                flaky = FlakyReplace("record.json", failures=3, error_factory=lambda code=code: clash(code))
                with mock.patch.object(BRIDGE.os, "replace", flaky):
                    BRIDGE.atomic_json(self.target, {"value": f"new-{code}"})
                self.assertEqual(flaky.calls, 4)
                self.assertEqual(json.loads(self.target.read_text(encoding="utf-8")), {"value": f"new-{code}"})
                self.assertEqual(self.leftovers(), [])

    def test_a_refusal_that_never_clears_is_raised_as_it_came_after_the_wait(self):
        flaky = FlakyReplace("record.json", failures=10**9)
        started = time.monotonic()
        with mock.patch.object(BRIDGE.os, "replace", flaky), \
                mock.patch.object(BRIDGE, "FILE_CLASH_WAIT_SECONDS", SHORT_WAIT):
            with self.assertRaises(PermissionError) as raised:
                BRIDGE.atomic_json(self.target, {"value": "new"})
        self.assertEqual(raised.exception.winerror, 5)
        self.assertGreater(flaky.calls, 1, "gave up without waiting")
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(json.loads(self.target.read_text(encoding="utf-8")), {"value": "old"})
        self.assertEqual(self.leftovers(), [], "the temporary file must go on every ending")

    @unittest.skipUnless(os.name == "nt", "the read-only attribute makes Windows refuse with error 5; elsewhere it does not")
    def test_a_read_only_target_is_refused_on_the_first_try(self):
        os.chmod(self.target, stat.S_IREAD)
        self.addCleanup(os.chmod, self.target, stat.S_IWRITE | stat.S_IREAD)
        counter = FlakyReplace("record.json", failures=0)
        with mock.patch.object(BRIDGE.os, "replace", counter):
            with self.assertRaises(PermissionError):
                BRIDGE.atomic_json(self.target, {"value": "new"})
        self.assertEqual(counter.calls, 1)
        self.assertEqual(self.leftovers(), [])

    def test_any_other_failure_is_raised_on_the_first_try(self):
        cases = {
            "denied for another reason": lambda: clash(code=1),
            "denied with no Windows code": lambda: clash(code=None),
            "file not found": lambda: FileNotFoundError(2, "no such file"),
        }
        for name, factory in cases.items():
            with self.subTest(name):
                flaky = FlakyReplace("record.json", failures=10**9, error_factory=factory)
                with mock.patch.object(BRIDGE.os, "replace", flaky):
                    with self.assertRaises(OSError):
                        BRIDGE.atomic_json(self.target, {"value": "new"})
                self.assertEqual(flaky.calls, 1)
                self.assertEqual(self.leftovers(), [])


class OtherTemporaryFileSwapsWaitToo(unittest.TestCase):
    """The snapshot restore and the userscript write swap a temporary file in the same way."""

    def test_restoring_a_snapshot_waits_out_a_busy_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "catalog.json"
            target.write_bytes(b"changed")
            flaky = FlakyReplace("catalog.json", failures=3)
            with mock.patch.object(BRIDGE.os, "replace", flaky):
                BRIDGE.restore_file_snapshot(target, b"original")
            self.assertEqual(target.read_bytes(), b"original")
            self.assertEqual(flaky.calls, 4)

    def test_regenerating_the_userscript_waits_out_a_busy_file(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = bridge_support.make_bridge(BRIDGE, Path(directory))
            flaky = FlakyReplace(bridge.userscript.name, failures=3)
            with mock.patch.object(BRIDGE.os, "replace", flaky):
                bridge.regenerate_userscript()
            self.assertEqual(flaky.calls, 4)
            self.assertIn("==UserScript==", bridge.userscript.read_text(encoding="utf-8"))


class FlakyRead:
    """Stands in for `Path.read_text`: the first `failures` reads of the watched file raise errno 13.

    A reader that opens the file while it is being swapped gets `PermissionError(13)` with no Windows
    code, which is what the triage measured.
    """

    def __init__(self, watched, failures):
        self.watched = Path(watched)
        self.failures = failures
        self.raised = 0
        self._real = Path.read_text

    def __call__(self, path, *args, **kwargs):
        if Path(path) == self.watched and self.raised < self.failures:
            self.raised += 1
            raise PermissionError(13, "Permission denied")
        return self._real(path, *args, **kwargs)

    def patched(self):
        """Install on `Path` as an ordinary method (a bare callable instance would not be bound)."""
        def read_text(path, *args, **kwargs):
            return self(path, *args, **kwargs)
        return mock.patch.object(Path, "read_text", read_text)


class RunRecordReadingTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.bridge = bridge_support.make_bridge(BRIDGE, Path(directory.name))
        self.record = self.bridge.manual_sync_path
        self.bridge.report_run_event(
            "round_started", batch="manual20261013090000", started_at="2026-10-13T09:00:00+10:00",
            run_board_ids=["board"], mode="incremental",
        )
        self.bridge.report_run_event("finalization_started", board_name="收藏夹A")

    def test_a_busy_read_is_waited_out_and_the_round_keeps_its_bookkeeping(self):
        flaky = FlakyRead(self.record, failures=3)
        with flaky.patched():
            working = self.bridge.report_run_event(
                "publish_claimed", build_version="a" * 64, site_manifest_sha256="b" * 64,
            )
        self.assertEqual(flaky.raised, 3)
        self.assertEqual(working["batch"], "manual20261013090000")
        self.assertEqual(working["run_board_ids"], ["board"])
        self.assertTrue(working["summary_finalizing"])
        self.assertEqual(working["publish_claimed_build_version"], "a" * 64)
        stored = json.loads(self.record.read_text(encoding="utf-8"))
        self.assertEqual(stored["bookkeeping"]["batch"], "manual20261013090000")
        self.assertNotEqual(stored["state"], "idle")

    def test_a_record_that_stays_unreadable_is_never_rebuilt_from_nothing(self):
        before = self.record.read_bytes()
        flaky = FlakyRead(self.record, failures=10**9)
        with flaky.patched(), \
                mock.patch.object(BRIDGE.ORGANIZATION_STATE, "FILE_CLASH_WAIT_SECONDS", SHORT_WAIT):
            with self.assertRaises(PermissionError):
                self.bridge.report_run_event(
                    "publish_claimed", build_version="a" * 64, site_manifest_sha256="b" * 64,
                )
        self.assertGreater(flaky.raised, 1, "gave up without waiting")
        self.assertEqual(self.record.read_bytes(), before)

    def test_a_viewer_that_cannot_read_after_the_wait_still_sees_no_record(self):
        flaky = FlakyRead(self.record, failures=10**9)
        with flaky.patched(), \
                mock.patch.object(BRIDGE.ORGANIZATION_STATE, "FILE_CLASH_WAIT_SECONDS", SHORT_WAIT):
            self.assertEqual(self.bridge.read_manual_sync(), {"state": "idle"})

    def test_a_viewer_waits_out_a_busy_read_and_sees_the_round(self):
        flaky = FlakyRead(self.record, failures=3)
        with flaky.patched():
            seen = self.bridge.read_manual_sync()
        self.assertEqual(seen["batch"], "manual20261013090000")

    def test_a_missing_record_is_no_record_and_is_not_waited_for(self):
        self.record.unlink()
        started = time.monotonic()
        with mock.patch.object(BRIDGE.ORGANIZATION_STATE, "FILE_CLASH_WAIT_SECONDS", 30):
            working = self.bridge.report_run_event(
                "round_started", batch="manual20261013100000", started_at="2026-10-13T10:00:00+10:00",
                run_board_ids=["board"], mode="incremental",
            )
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(working["batch"], "manual20261013100000")


class StatusRouteReadsARoundFileTest(unittest.TestCase):
    def test_a_busy_read_of_the_round_file_is_waited_out_not_answered_with_an_error(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = bridge_support.make_bridge(BRIDGE, Path(directory))
            run_id = "manual20261013090000_board"
            round_file = bridge.state_dir / "runs" / f"{run_id}.json"
            BRIDGE.atomic_json(round_file, {"run_id": run_id, "state": "completed"})
            server = BRIDGE.ThreadingHTTPServer((BRIDGE.HOST, 0), BRIDGE.make_handler(bridge))
            bridge.port = server.server_address[1]
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self.addCleanup(thread.join, 2)
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            flaky = FlakyRead(round_file, failures=3)
            request = Request(
                f"http://{BRIDGE.HOST}:{bridge.port}/status?run_id={run_id}",
                headers={"X-XHS-Bridge-Token": bridge.token},
            )
            with flaky.patched():
                with urlopen(request, timeout=30) as response:
                    status, body = response.status, json.loads(response.read().decode("utf-8"))
            self.assertEqual(flaky.raised, 3)
            self.assertEqual(status, 200)
            self.assertEqual((body["ok"], body["state"]), (True, "completed"))


HOLDER = (
    "import sys, time\n"
    "handle = open(sys.argv[1], 'rb')\n"
    "print('open', flush=True)\n"
    "time.sleep(float(sys.argv[2]))\n"
    "handle.close()\n"
)


@unittest.skipUnless(os.name == "nt", "only Windows refuses to replace a file another process has open")
class AtomicWriteWaitsForARealReaderTest(unittest.TestCase):
    def test_a_write_lands_after_another_process_closes_the_file(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "record.json"
            target.write_text(json.dumps({"value": "old"}), encoding="utf-8")
            holder = subprocess.Popen(
                [sys.executable, "-I", "-c", HOLDER, str(target), "0.5"],
                stdout=subprocess.PIPE, text=True,
            )
            try:
                self.assertEqual(holder.stdout.readline().strip(), "open")
                started = time.monotonic()
                BRIDGE.atomic_json(target, {"value": "new"})
                waited = time.monotonic() - started
            finally:
                holder.wait(timeout=10)
                holder.stdout.close()
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), {"value": "new"})
            self.assertGreater(waited, 0.1, "the reader was still open; the write cannot have been instant")


if __name__ == "__main__":
    unittest.main()
