"""The organization mutation lock when two writers hand it to each other.

The lock is a directory renamed into place. The writer that loses the rename
watches the holder; the holder deletes the directory when it is done. Every
test here is about the moments where those two overlap.
"""

import contextlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = SKILL_ROOT / "scripts" / "save_diandian_summary.py"
WORKER_PATH = SKILL_ROOT / "test-fixtures" / "lock_stress_worker.py"

STRESS_PROCESSES = 3
STRESS_CYCLES_PER_PROCESS = 300
STRESS_WALL_CLOCK_SECONDS = 150
STRESS_LONGEST_ALLOWED_WAIT_SECONDS = 2.0


def load_module():
    spec = importlib.util.spec_from_file_location("save_diandian_summary", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Workspace:
    """A private store with its sibling lock folder, inside a throwaway folder."""

    def __init__(self, test):
        temporary = tempfile.TemporaryDirectory()
        test.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        self.private_root = root / ".xhs-favorites" / "diandian-summaries"
        self.private_root.mkdir(parents=True)
        self.lock_parent = root / ".xhs-favorites" / "organization-migration"
        self.lock_path = self.lock_parent / ".apply-lock"

    def hold_lock_as_another_writer(self):
        """The lock as a live writer (this process) leaves it."""
        self.lock_path.mkdir(parents=True)
        (self.lock_path / "owner.json").write_text(
            json.dumps({"schema_version": 1, "pid": os.getpid(), "nonce": "another-writer"}),
            encoding="utf-8",
        )

    def other_writer_releases(self):
        shutil.rmtree(self.lock_path, ignore_errors=True)


def enter_and_leave(module, workspace):
    with module.private_store_lock(workspace.private_root):
        pass


class OtherWriterReleasesDuringInspection:
    """Make the other writer's release land at one exact moment of the waiter's look.

    Counts every time the waiting writer queries the lock folder or its
    owner file (does it exist, what is it, read it, rename onto it failed) and
    releases the lock just before the Nth query is answered. Sweeping N over
    1, 2, 3, ... covers every point at which the lock can vanish without this
    test having to know how many queries the implementation makes.

    A waiter that finds the lock held sleeps before it looks again. That
    sleep ends the first look, so a sleep before the Nth query means N is
    past the end of the sweep: the lock is released then, so the waiter can
    finish, and `ran_out_of_moments` is set.
    """

    def __init__(self, workspace, moment):
        self.workspace = workspace
        self.moment = moment
        self.queries = 0
        self.released = False
        self.ran_out_of_moments = False
        self._watched = {
            os.path.normcase(str(workspace.lock_path)),
            os.path.normcase(str(workspace.lock_path / "owner.json")),
        }

    def _look(self, path):
        if os.path.normcase(str(path)) not in self._watched:
            return
        self.queries += 1
        if self.queries == self.moment:
            self.released = True
            self.workspace.other_writer_releases()

    def __enter__(self):
        real_lexists = os.path.lexists
        real_lstat = Path.lstat
        real_read_text = Path.read_text
        real_rename = Path.rename

        def lexists(path):
            self._look(path)
            return real_lexists(path)

        def lstat(path, *args, **kwargs):
            self._look(path)
            return real_lstat(path, *args, **kwargs)

        def read_text(path, *args, **kwargs):
            self._look(path)
            return real_read_text(path, *args, **kwargs)

        def rename(path, target):
            try:
                return real_rename(path, target)
            except OSError:
                self._look(target)
                raise

        real_sleep = time.sleep

        def sleep(seconds):
            if not self.released:
                self.ran_out_of_moments = True
                self.released = True
                self.workspace.other_writer_releases()
            return real_sleep(seconds)

        self._stack = contextlib.ExitStack()
        self._stack.enter_context(mock.patch.object(time, "sleep", sleep))
        self._stack.enter_context(mock.patch.object(os.path, "lexists", lexists))
        self._stack.enter_context(mock.patch.object(Path, "lstat", lstat))
        self._stack.enter_context(mock.patch.object(Path, "read_text", read_text))
        self._stack.enter_context(mock.patch.object(Path, "rename", rename))
        return self

    def __exit__(self, *exc_info):
        self._stack.close()


class WaitingForTheLockTests(unittest.TestCase):
    def test_waiter_takes_the_lock_whatever_moment_the_holder_releases_it(self):
        windows_covered = 0
        for moment in range(1, 80):
            adversary = None
            with self.subTest(release_at_query=moment):
                module = load_module()
                module.PRIVATE_STORE_LOCK_TIMEOUT_SECONDS = 5.0
                workspace = Workspace(self)
                workspace.hold_lock_as_another_writer()
                adversary = OtherWriterReleasesDuringInspection(workspace, moment)
                with adversary:
                    enter_and_leave(module, workspace)
            if adversary is None or adversary.ran_out_of_moments:
                break
            windows_covered += 1
        else:
            self.fail("the sweep never ran out of moments to release the lock at")
        # Fewer than this would mean the sweep stopped looking at the lock early.
        self.assertGreaterEqual(windows_covered, 4)

    def test_owner_file_refused_while_the_holder_deletes_it_is_a_released_lock(self):
        module = load_module()
        module.PRIVATE_STORE_LOCK_TIMEOUT_SECONDS = 5.0
        workspace = Workspace(self)
        workspace.hold_lock_as_another_writer()
        owner_file = workspace.lock_path / "owner.json"
        real_read_text = Path.read_text

        def read_text(path, *args, **kwargs):
            if path == owner_file:
                workspace.other_writer_releases()
                raise PermissionError(13, "Access is denied")
            return real_read_text(path, *args, **kwargs)

        with mock.patch.object(Path, "read_text", read_text):
            enter_and_leave(module, workspace)

    def test_parent_folder_created_by_the_other_writer_a_moment_earlier_is_used(self):
        module = load_module()
        workspace = Workspace(self)
        real_mkdir = Path.mkdir

        def mkdir(path, *args, **kwargs):
            if path == workspace.lock_parent:
                os.mkdir(path)  # the other writer got there first
            return real_mkdir(path, *args, **kwargs)

        with mock.patch.object(Path, "mkdir", mkdir):
            enter_and_leave(module, workspace)

        self.assertFalse(workspace.lock_path.exists())

    def test_rename_that_keeps_failing_with_no_lock_present_ends_in_the_timeout(self):
        module = load_module()
        module.PRIVATE_STORE_LOCK_TIMEOUT_SECONDS = 0.3
        workspace = Workspace(self)
        real_rename = Path.rename

        def rename(path, target):
            if target == workspace.lock_path:
                raise FileExistsError(17, "Cannot create a file when that file already exists")
            return real_rename(path, target)

        with mock.patch.object(Path, "rename", rename):
            with self.assertRaisesRegex(TimeoutError, "organization mutation lock"):
                enter_and_leave(module, workspace)

    def test_lock_folder_without_an_owner_file_ends_in_the_timeout_not_invalid(self):
        module = load_module()
        module.PRIVATE_STORE_LOCK_TIMEOUT_SECONDS = 0.3
        workspace = Workspace(self)
        workspace.lock_path.mkdir(parents=True)

        with self.assertRaisesRegex(TimeoutError, "organization mutation lock"):
            enter_and_leave(module, workspace)

    def test_owner_file_that_stays_unreadable_ends_in_the_timeout_not_invalid(self):
        module = load_module()
        module.PRIVATE_STORE_LOCK_TIMEOUT_SECONDS = 0.3
        workspace = Workspace(self)
        workspace.hold_lock_as_another_writer()
        owner_file = workspace.lock_path / "owner.json"
        real_read_text = Path.read_text

        def read_text(path, *args, **kwargs):
            if path == owner_file:
                raise PermissionError(13, "Access is denied")
            return real_read_text(path, *args, **kwargs)

        with mock.patch.object(Path, "read_text", read_text):
            with self.assertRaisesRegex(TimeoutError, "organization mutation lock"):
                enter_and_leave(module, workspace)

    def test_lock_folder_that_keeps_vanishing_under_inspection_ends_in_the_timeout(self):
        module = load_module()
        module.PRIVATE_STORE_LOCK_TIMEOUT_SECONDS = 0.3
        workspace = Workspace(self)
        workspace.hold_lock_as_another_writer()
        real_lstat = Path.lstat

        def lstat(path, *args, **kwargs):
            if path == workspace.lock_path:
                raise FileNotFoundError(2, "The system cannot find the file specified")
            return real_lstat(path, *args, **kwargs)

        with mock.patch.object(Path, "lstat", lstat):
            with self.assertRaisesRegex(TimeoutError, "organization mutation lock"):
                enter_and_leave(module, workspace)

    def test_owner_file_that_is_not_a_valid_record_is_refused_at_once(self):
        module = load_module()
        module.PRIVATE_STORE_LOCK_TIMEOUT_SECONDS = 5.0
        workspace = Workspace(self)
        workspace.lock_path.mkdir(parents=True)
        (workspace.lock_path / "owner.json").write_text("{not json", encoding="utf-8")

        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, "lock is invalid"):
            enter_and_leave(module, workspace)
        self.assertLess(time.monotonic() - started, 2.0)

    def test_lock_that_is_not_a_folder_is_refused_at_once(self):
        module = load_module()
        module.PRIVATE_STORE_LOCK_TIMEOUT_SECONDS = 5.0
        workspace = Workspace(self)
        workspace.lock_parent.mkdir(parents=True)
        workspace.lock_path.write_text("not a folder", encoding="utf-8")

        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, "lock root is unsafe"):
            enter_and_leave(module, workspace)
        self.assertLess(time.monotonic() - started, 2.0)


class ReleasingTheLockTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows sharing-violation regression")
    def test_release_waits_out_a_reader_holding_the_owner_file_open(self):
        module = load_module()
        workspace = Workspace(self)
        reading = threading.Event()

        def read_owner_file_briefly():
            with open(workspace.lock_path / "owner.json", "rb") as handle:
                handle.read()
                reading.set()
                time.sleep(0.3)

        reader = threading.Thread(target=read_owner_file_briefly)
        try:
            with module.private_store_lock(workspace.private_root):
                reader.start()
                self.assertTrue(reading.wait(timeout=5))
        finally:
            reader.join(timeout=5)

        self.assertFalse(workspace.lock_path.exists())

    def test_release_keeps_retrying_a_windows_sharing_violation_then_gives_up(self):
        module = load_module()
        module.LOCK_RELEASE_RETRY_SECONDS = 0.2
        workspace = Workspace(self)
        violation = PermissionError(13, "The process cannot access the file")
        violation.winerror = 32

        with mock.patch.object(module.shutil, "rmtree", side_effect=violation) as rmtree:
            with self.assertRaises(PermissionError):
                enter_and_leave(module, workspace)

        self.assertGreater(rmtree.call_count, 1)

    def test_release_retries_access_denied_too(self):
        module = load_module()
        workspace = Workspace(self)
        denied = PermissionError(13, "Access is denied")
        denied.winerror = 5
        real_rmtree = shutil.rmtree
        attempts = []

        def rmtree(path, *args, **kwargs):
            attempts.append(path)
            if len(attempts) < 3:
                raise denied
            return real_rmtree(path, *args, **kwargs)

        with mock.patch.object(module.shutil, "rmtree", rmtree):
            enter_and_leave(module, workspace)

        self.assertEqual(len(attempts), 3)
        self.assertFalse(workspace.lock_path.exists())

    def test_release_raises_at_once_for_any_other_error(self):
        module = load_module()
        workspace = Workspace(self)
        failure = OSError(5, "Input/output error")
        failure.winerror = 1117

        with mock.patch.object(module.shutil, "rmtree", side_effect=failure) as rmtree:
            with self.assertRaises(OSError):
                enter_and_leave(module, workspace)

        self.assertEqual(rmtree.call_count, 1)

    def test_a_lock_another_writer_took_right_after_release_is_not_a_failure(self):
        module = load_module()
        workspace = Workspace(self)
        real_rmtree = shutil.rmtree

        def rmtree(path, *args, **kwargs):
            real_rmtree(path, *args, **kwargs)
            if Path(path) == workspace.lock_path:
                workspace.hold_lock_as_another_writer()

        with mock.patch.object(module.shutil, "rmtree", rmtree):
            enter_and_leave(module, workspace)

        self.assertTrue((workspace.lock_path / "owner.json").exists())

    def test_a_lock_that_is_still_ours_after_release_is_still_reported(self):
        module = load_module()
        workspace = Workspace(self)

        with mock.patch.object(module.shutil, "rmtree", lambda *args, **kwargs: None):
            with self.assertRaisesRegex(ValueError, "cleanup is unsafe"):
                enter_and_leave(module, workspace)


class TradingTheLockBetweenProcessesTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows lock hand-off regression")
    def test_many_processes_trading_the_lock_never_fail_and_never_wait_long(self):
        workspace = Workspace(self)
        processes = [
            subprocess.Popen(
                [
                    sys.executable,
                    str(WORKER_PATH),
                    str(SCRIPT_PATH),
                    str(workspace.private_root),
                    str(STRESS_CYCLES_PER_PROCESS),
                    "0.002",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            for _ in range(STRESS_PROCESSES)
        ]
        deadline = time.monotonic() + STRESS_WALL_CLOCK_SECONDS
        reports = []
        stuck = []
        for index, process in enumerate(processes):
            try:
                stdout, stderr = process.communicate(timeout=max(1.0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                stuck.append(index)
                continue
            self.assertEqual(process.returncode, 0, stderr)
            reports.append(json.loads(stdout))
        for index in stuck:
            processes[index].kill()
            processes[index].communicate()
        self.assertEqual(stuck, [], "processes still running after the wall-clock limit")

        for report in reports:
            self.assertEqual(report["failures"], [], report)
            self.assertEqual(report["failure_count"], 0, report)
            self.assertEqual(report["cycles_done"], STRESS_CYCLES_PER_PROCESS, report)
            self.assertLess(
                report["longest_wait_seconds"], STRESS_LONGEST_ALLOWED_WAIT_SECONDS, report
            )
        self.assertFalse(workspace.lock_path.exists())


if __name__ == "__main__":
    unittest.main()
