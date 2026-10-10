"""A sync run always ends with one final build; a local-only rebuild reuses that step."""

from datetime import timedelta
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import threading
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "bridge-server.py"
SPEC = importlib.util.spec_from_file_location("xhs_bridge_final_build", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BRIDGE)

STATE_PATH = Path(__file__).parents[1] / "scripts" / "organization_state.py"
STATE_SPEC = importlib.util.spec_from_file_location("organization_state_final_build", STATE_PATH)
ORGANIZATION_STATE = importlib.util.module_from_spec(STATE_SPEC)
assert STATE_SPEC.loader is not None
STATE_SPEC.loader.exec_module(ORGANIZATION_STATE)

BUILD_VERSION = "a" * 64
MANIFEST = "b" * 64


def note_id(letter: str) -> str:
    return letter * 24


class FakeRun:
    """A bridge whose platform and heavy-build edges are doubles; state files are real."""

    def __init__(self, root: Path, boards: list[str], *, diandian_enabled: bool) -> None:
        self.root = root
        self.batch = "manual20261011000000"
        self.boards = boards
        bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
        bridge.workspace = root
        bridge.state_dir = root / ".xhs-favorites"
        bridge.catalog_path = bridge.state_dir / "catalog.json"
        bridge.config_path = root / "xhs-favorites.json"
        bridge.config_path.write_text("{}", encoding="utf-8")
        bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
        bridge.status_path = bridge.state_dir / "bridge-status.json"
        bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
        bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
        bridge.organization_status_v2_enabled = True
        bridge.diandian_enabled = diandian_enabled
        bridge.boards = {board: board.upper() for board in boards}
        bridge.board_order = list(boards)
        bridge.processing_lock = threading.Lock()
        bridge.trigger_lock = threading.Lock()
        bridge.summary_plans = {}
        bridge.summary_locks = {}
        bridge.summary_locks_guard = threading.Lock()
        bridge.summary_finalizing = set()
        bridge.summary_finalized = set()
        bridge.summary_halted = set()
        bridge.publish_config = {"repository": "unused", "branch": "main"}
        bridge.run_curation_pipeline = mock.Mock(
            return_value={"counts": {"accepted": 1, "pending": 0}}
        )
        bridge.build_organization_snapshot = mock.Mock(
            return_value={"build_version": BUILD_VERSION, "site_manifest_sha256": MANIFEST}
        )
        bridge.publish_public_site = mock.Mock(return_value={
            "ok": True,
            "status": "published",
            "build_version": BUILD_VERSION,
            "site_manifest_sha256": MANIFEST,
        })
        bridge.saved_diandian_record = mock.Mock(return_value={"summary": "saved"})
        bridge.record_diandian_succeeded_batch = mock.Mock()
        self.bridge = bridge
        BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {}})
        BRIDGE.atomic_json(bridge.manual_sync_path, {
            "batch": self.batch,
            "state": "running",
            "run_board_ids": list(boards),
            "run_mode": "incremental",
            "processed_run_ids": [],
            "board_note_ids": {},
        })

    def run_id(self, board: str) -> str:
        return self.bridge.manual_run_id(self.batch, board)

    def core_done(self, board: str, notes: list[str]) -> None:
        """The board's core import finished, as the userscript's import call reports it."""
        order = self.boards
        following = order[order.index(board) + 1] if order.index(board) + 1 < len(order) else None
        result = {
            "run_id": self.run_id(board),
            "state": "completed",
            "scanned": len(notes),
            "new": 0,
            "next_board_id": following,
            "note_ids": notes,
        }
        BRIDGE.atomic_json(self.bridge.state_dir / "runs" / f"{self.run_id(board)}.json", result)
        self.bridge.record_manual_result(self.run_id(board), board, result)

    def plan(self, board: str, notes: list[str]) -> dict:
        return self.bridge.diandian_summary_plan({
            "run_id": self.run_id(board),
            "board_id": board,
            "note_ids": notes,
        })

    def wait_for_finalizer(self, board: str) -> None:
        thread = getattr(self.bridge, "summary_finalization_threads", {}).get(self.run_id(board))
        if thread is not None:
            thread.join(timeout=5)
            assert not thread.is_alive(), "finalizer did not finish"

    def assert_one_final_build(self, test: unittest.TestCase, publishes: int = 1) -> None:
        test.assertEqual(self.bridge.run_curation_pipeline.call_count, 1)
        test.assertEqual(self.bridge.build_organization_snapshot.call_count, 1)
        test.assertEqual(self.bridge.publish_public_site.call_count, publishes)
        state = self.bridge.read_manual_sync()
        test.assertEqual(state["state"], "completed")
        test.assertFalse(state["summary_finalizing"])
        test.assertEqual(state["build_version"], BUILD_VERSION)


class RunAlwaysEndsWithOneFinalBuildTest(unittest.TestCase):
    def test_last_board_whose_summaries_are_all_already_saved_still_builds_once(self):
        with tempfile.TemporaryDirectory() as directory:
            run = FakeRun(Path(directory), ["first"], diandian_enabled=True)
            notes = [note_id("a")]
            run.core_done("first", notes)

            response = run.plan("first", notes)
            run.wait_for_finalizer("first")

            self.assertEqual(response, {"enabled": True, "note_ids": []})
            run.assert_one_final_build(self)

    def test_run_with_diandian_off_builds_once_after_the_last_board(self):
        with tempfile.TemporaryDirectory() as directory:
            run = FakeRun(Path(directory), ["first"], diandian_enabled=False)
            notes = [note_id("a")]
            run.core_done("first", notes)

            response = run.plan("first", notes)
            run.wait_for_finalizer("first")

            self.assertEqual(response, {"enabled": False, "note_ids": []})
            run.assert_one_final_build(self)

    def test_earlier_board_summaries_do_not_build_early_and_an_empty_last_plan_builds_once(self):
        with tempfile.TemporaryDirectory() as directory:
            run = FakeRun(Path(directory), ["first", "last"], diandian_enabled=True)
            first_note, last_note = note_id("a"), note_id("b")
            run.bridge.saved_diandian_record = mock.Mock(
                side_effect=lambda current: None if current == first_note else {"summary": "saved"}
            )
            run.core_done("first", [first_note])
            self.assertEqual(run.plan("first", [first_note]), {"enabled": True, "note_ids": [first_note]})
            run.bridge.skip_diandian_result({
                "run_id": run.run_id("first"), "board_id": "first",
                "note_id": first_note, "reason": "attachment-not-supported",
            })
            run.wait_for_finalizer("first")
            self.assertEqual(run.bridge.run_curation_pipeline.call_count, 0)
            self.assertEqual(run.bridge.read_manual_sync()["state"], "running")

            run.core_done("last", [last_note])
            run.plan("last", [last_note])
            run.wait_for_finalizer("last")

            run.assert_one_final_build(self)

    def test_abandoned_plan_on_the_last_board_still_builds_once(self):
        with tempfile.TemporaryDirectory() as directory:
            run = FakeRun(Path(directory), ["first"], diandian_enabled=True)
            run.core_done("first", [note_id("a")])

            response = run.plan("first", [])
            run.wait_for_finalizer("first")

            self.assertEqual(response, {"enabled": False, "note_ids": [], "abandoned": True})
            run.assert_one_final_build(self)

    def test_repeated_empty_plan_calls_while_building_never_build_or_publish_twice(self):
        with tempfile.TemporaryDirectory() as directory:
            run = FakeRun(Path(directory), ["first"], diandian_enabled=True)
            notes = [note_id("a")]
            building, release = threading.Event(), threading.Event()

            def slow_curation():
                building.set()
                self.assertTrue(release.wait(timeout=5))
                return {"counts": {"accepted": 1, "pending": 0}}

            run.bridge.run_curation_pipeline = mock.Mock(side_effect=slow_curation)
            run.core_done("first", notes)
            run.plan("first", notes)
            self.assertTrue(building.wait(timeout=5))

            for _ in range(2):
                run.plan("first", notes)
            self.assertEqual(run.bridge.read_manual_sync()["state"], "running")
            self.assertTrue(run.bridge.read_manual_sync()["summary_finalizing"])
            release.set()
            run.wait_for_finalizer("first")

            run.assert_one_final_build(self)

    def test_non_empty_last_plan_still_builds_and_publishes_once(self):
        with tempfile.TemporaryDirectory() as directory:
            run = FakeRun(Path(directory), ["first"], diandian_enabled=True)
            note = note_id("a")
            run.bridge.saved_diandian_record = mock.Mock(return_value=None)
            run.core_done("first", [note])
            self.assertEqual(run.plan("first", [note]), {"enabled": True, "note_ids": [note]})

            run.bridge.skip_diandian_result({
                "run_id": run.run_id("first"), "board_id": "first",
                "note_id": note, "reason": "attachment-not-supported",
            })
            run.wait_for_finalizer("first")

            run.assert_one_final_build(self)

    def test_safety_stopped_core_import_never_builds_or_publishes(self):
        with tempfile.TemporaryDirectory() as directory:
            run = FakeRun(Path(directory), ["first"], diandian_enabled=True)
            stopped = {
                "run_id": run.run_id("first"), "state": "safety-stopped", "next_board_id": None,
                "note_ids": [note_id("a")], "error": "stopped",
            }
            BRIDGE.atomic_json(run.bridge.state_dir / "runs" / f"{run.run_id('first')}.json", stopped)
            run.bridge.record_manual_result(run.run_id("first"), "first", stopped)

            with self.assertRaises(ValueError):
                run.plan("first", [note_id("a")])

            self.assertEqual(run.bridge.run_curation_pipeline.call_count, 0)
            self.assertEqual(run.bridge.build_organization_snapshot.call_count, 0)
            self.assertEqual(run.bridge.publish_public_site.call_count, 0)
            self.assertEqual(run.bridge.read_manual_sync()["state"], "safety-stopped")

    def test_halted_summary_run_never_builds_or_publishes(self):
        with tempfile.TemporaryDirectory() as directory:
            run = FakeRun(Path(directory), ["first"], diandian_enabled=True)
            note = note_id("a")
            run.bridge.saved_diandian_record = mock.Mock(return_value=None)
            run.core_done("first", [note])
            run.plan("first", [note])

            halted = run.bridge.halt_diandian_run({
                "run_id": run.run_id("first"), "board_id": "first",
                "reason": "xhs-safety-stop", "note_id": note,
            })
            self.assertTrue(halted["halted"])
            with self.assertRaises(ValueError):
                run.plan("first", [])

            self.assertEqual(run.bridge.run_curation_pipeline.call_count, 0)
            self.assertEqual(run.bridge.build_organization_snapshot.call_count, 0)
            self.assertEqual(run.bridge.publish_public_site.call_count, 0)
            self.assertEqual(run.bridge.read_manual_sync()["state"], "safety-stopped")


class LocalRebuildTest(unittest.TestCase):
    PRIOR_BATCH = "manual20261010000000"

    def prepared(self, root: Path, *, publish: bool = True) -> FakeRun:
        """A finished earlier sync, its evidence files, and a catalog of three notes."""
        run = FakeRun(root, ["first"], diandian_enabled=True)
        bridge = run.bridge
        self.notes = [note_id("a"), note_id("b"), note_id("c")]
        BRIDGE.atomic_json(bridge.catalog_path, {
            "version": 1,
            "notes": {current: {"note_id": current} for current in self.notes},
        })
        BRIDGE.atomic_json(bridge.manual_sync_path, {
            "batch": self.PRIOR_BATCH,
            "state": "completed",
            "started_at": "2026-10-10T00:00:00+00:00",
            "completed_at": "2026-10-10T00:30:00+00:00",
            "run_board_ids": ["first"],
            "frozen_scope": {"note_ids": [self.notes[0]], "mode": "incremental"},
        })
        transactions = bridge.state_dir / "organization-transactions"
        transactions.mkdir(parents=True)
        self.prior_evidence = {
            transactions / f"{self.PRIOR_BATCH}-curation-input.json": b'{"prior": "input"}',
            transactions / f"{self.PRIOR_BATCH}-curation-bundle.json": b'{"prior": "bundle"}',
            bridge.manual_sync_path: bridge.manual_sync_path.read_bytes(),
        }
        for path, content in self.prior_evidence.items():
            path.write_bytes(content)
        if not publish:
            bridge.publish_config = None
        self.platform_calls = self.forbid_platform_contact(bridge)
        return run

    def forbid_platform_contact(self, bridge) -> mock.Mock:
        contact = mock.Mock(side_effect=AssertionError("local rebuild touched the platform"))
        for name in (
            "open_cdp_target", "open_sop_browser_page", "cache_missing_media", "process_import",
            "import_sync", "save_diandian_result", "run_diandian_cdp", "click_diandian_control",
        ):
            setattr(bridge, name, contact)
        for name in ("open_sop_cdp_target", "loopback_devtools_json", "loopback_devtools_action"):
            patcher = mock.patch.object(BRIDGE, name, contact)
            patcher.start()
            self.addCleanup(patcher.stop)
        return contact

    def rebuild(self, run: FakeRun) -> dict:
        status = run.bridge.trigger_local_rebuild()
        for thread in list(run.bridge.local_rebuild_threads.values()):
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
        return status

    def test_rebuild_runs_without_any_platform_contact_and_reports_what_really_ran(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self.prepared(Path(directory))

            started = self.rebuild(run)
            final = run.bridge.manual_sync_status()

            self.platform_calls.assert_not_called()
            self.assertEqual(started["phases"]["core"]["status"], "not_required")
            self.assertEqual(final["phases"]["core"]["status"], "not_required")
            self.assertEqual(final["phases"]["summary"]["status"], "not_required")
            self.assertEqual(final["phases"]["build"]["status"], "succeeded")
            self.assertEqual(final["phases"]["publish"]["status"], "published")
            self.assertEqual(final["state"], "published")
            self.assertEqual(final["build_version"], BUILD_VERSION)
            self.assertEqual(final["counts"]["scanned"], 0)
            self.assertEqual(final["counts"]["new"], 0)
            self.assertEqual(run.bridge.run_curation_pipeline.call_count, 1)
            self.assertEqual(run.bridge.build_organization_snapshot.call_count, 1)
            self.assertEqual(run.bridge.publish_public_site.call_count, 1)

    def test_rebuild_freezes_the_whole_catalog_under_its_own_batch_and_leaves_the_last_sync_alone(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self.prepared(Path(directory))

            self.rebuild(run)

            curation = run.bridge.run_curation_pipeline.call_args.kwargs
            snapshot = run.bridge.build_organization_snapshot.call_args.kwargs
            self.assertEqual(curation["note_ids"], sorted(self.notes))
            self.assertEqual(snapshot, curation)
            self.assertNotEqual(curation["batch"], self.PRIOR_BATCH)
            self.assertTrue(BRIDGE.RUN_ID.fullmatch(curation["batch"]))
            for path, content in self.prior_evidence.items():
                self.assertEqual(path.read_bytes(), content, path.name)

    def test_rebuild_is_refused_while_a_sync_is_running_but_not_by_a_leftover_safety_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self.prepared(Path(directory))
            bridge = run.bridge
            running = {
                "batch": "manual20261011010101", "state": "running",
                "started_at": BRIDGE.datetime.now().astimezone().isoformat(),
            }
            BRIDGE.atomic_json(bridge.manual_sync_path, running)
            before = bridge.manual_sync_path.read_bytes()

            with self.assertRaises(BRIDGE.BridgeBusyError):
                bridge.trigger_local_rebuild()

            self.assertEqual(bridge.manual_sync_path.read_bytes(), before)
            self.assertEqual(bridge.run_curation_pipeline.call_count, 0)

            BRIDGE.atomic_json(bridge.manual_sync_path, {**running, "state": "completed"})
            BRIDGE.atomic_json(bridge.state_dir / "media-download-safety-stop.json", {
                "stopped_at": "2026-10-10T00:00:00+00:00", "reason": "platform-safety-limit",
            })
            self.rebuild(run)
            self.assertEqual(bridge.build_organization_snapshot.call_count, 1)

    def test_a_sync_cannot_start_while_a_rebuild_is_running(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self.prepared(Path(directory))
            bridge = run.bridge
            building, release = threading.Event(), threading.Event()

            def slow_curation(**_scope):
                building.set()
                self.assertTrue(release.wait(timeout=5))
                return {"counts": {"accepted": 3, "pending": 0}}

            bridge.run_curation_pipeline = mock.Mock(side_effect=slow_curation)
            bridge.trigger_local_rebuild()
            self.assertTrue(building.wait(timeout=5))

            with self.assertRaises(BRIDGE.BridgeBusyError):
                bridge.trigger_local_rebuild()
            with self.assertRaises(BRIDGE.BridgeBusyError):
                bridge.trigger_manual_sync({})
            self.assertEqual(bridge.manual_sync_status()["phases"]["curation"]["status"], "running")
            release.set()
            for thread in bridge.local_rebuild_threads.values():
                thread.join(timeout=5)

    def test_failed_build_keeps_the_previous_local_snapshot_and_never_publishes(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self.prepared(Path(directory))
            bridge = run.bridge
            # The real snapshot builder runs: this rebuild's curation bundle was never produced.
            bridge.build_organization_snapshot = BRIDGE.Bridge.build_organization_snapshot.__get__(bridge)
            public_data = Path(directory) / "site" / "data" / "knowledge.json"
            card = Path(directory) / "knowledge-base" / "02-知识卡片" / "one.md"
            for path, content in ((public_data, b'{"previous": true}'), (card, b"previous card")):
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)

            self.rebuild(run)
            status = bridge.manual_sync_status()

            self.assertEqual(public_data.read_bytes(), b'{"previous": true}')
            self.assertEqual(card.read_bytes(), b"previous card")
            bridge.publish_public_site.assert_not_called()
            self.assertEqual(status["phases"]["build"]["status"], "failed")
            self.assertEqual(status["phases"]["build"]["artifact_status"], "held_previous")
            self.assertEqual(status["state"], "failed")
            self.assertEqual(
                ORGANIZATION_STATE.visible_copy(status), "构建失败，已保留上一版"
            )

    def test_failed_publish_keeps_the_new_local_snapshot_and_says_the_remote_is_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self.prepared(Path(directory))
            run.bridge.publish_public_site = mock.Mock(
                return_value={"ok": False, "status": "failed", "error": "remote refused"}
            )

            self.rebuild(run)
            status = run.bridge.manual_sync_status()

            self.assertEqual(status["phases"]["build"]["status"], "succeeded")
            self.assertEqual(status["phases"]["publish"]["status"], "failed")
            self.assertEqual(status["phases"]["publish"]["artifact_status"], "held_previous")
            self.assertEqual(status["state"], "completed_with_warnings")
            self.assertEqual(
                ORGANIZATION_STATE.visible_copy(status),
                "发布失败，远端仍为上一版；本地结果已保留",
            )

    def test_unchanged_and_unconfigured_publishing_are_reported_as_they_are(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self.prepared(Path(directory))
            run.bridge.publish_public_site = mock.Mock(return_value={
                "ok": True, "status": "unchanged",
                "build_version": BUILD_VERSION, "site_manifest_sha256": MANIFEST,
            })
            self.rebuild(run)
            status = run.bridge.manual_sync_status()
            self.assertEqual(status["phases"]["publish"]["status"], "unchanged")
            self.assertEqual(ORGANIZATION_STATE.visible_copy(status), "内容无变化，无需发布")

        with tempfile.TemporaryDirectory() as directory:
            run = self.prepared(Path(directory), publish=False)
            self.rebuild(run)
            status = run.bridge.manual_sync_status()
            self.assertEqual(status["phases"]["publish"]["status"], "not_enabled")
            self.assertEqual(status["phases"]["build"]["status"], "succeeded")
            self.assertEqual(ORGANIZATION_STATE.visible_copy(status), "本地重建完成，未访问小红书")
            run.bridge.publish_public_site.assert_not_called()

    def test_one_rebuild_run_publishes_at_most_once_however_often_it_is_started(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self.prepared(Path(directory))
            bridge = run.bridge
            self.rebuild(run)
            batch = next(iter(bridge.local_rebuild_threads))

            bridge.run_local_rebuild(batch)
            bridge.run_local_rebuild(batch)
            self.assertIsNone(bridge.publish_local_rebuild(
                batch, BUILD_VERSION, MANIFEST
            ))

            self.assertEqual(bridge.publish_public_site.call_count, 1)
            self.assertEqual(bridge.run_curation_pipeline.call_count, 1)
            self.assertEqual(bridge.build_organization_snapshot.call_count, 1)

    def test_a_rebuild_that_died_midway_stops_blocking_the_workbench(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self.prepared(Path(directory))
            bridge = run.bridge
            stale = (BRIDGE.datetime.now().astimezone() - timedelta(hours=3)).isoformat()
            BRIDGE.atomic_json(bridge.local_rebuild_path(), {
                "batch": "localrebuilddied", "state": "running", "phase": "build",
                "started_at": stale, "note_ids": self.notes,
            })

            status = bridge.manual_sync_status()

            self.assertEqual(status["phases"]["build"]["status"], "failed")
            self.assertEqual(bridge.read_local_rebuild()["state"], "failed")
            self.rebuild(run)
            self.assertEqual(bridge.manual_sync_status()["state"], "published")

    def test_workbench_shows_the_newer_of_the_last_sync_and_the_last_rebuild(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self.prepared(Path(directory))
            bridge = run.bridge
            self.rebuild(run)
            self.assertEqual(bridge.manual_sync_status()["phases"]["core"]["status"], "not_required")

            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual20261012000000", "state": "completed", "core_completed": True,
                "started_at": (BRIDGE.datetime.now().astimezone() + timedelta(minutes=5)).isoformat(),
                "build_version": BUILD_VERSION, "publish_status": "published",
            })

            self.assertEqual(bridge.manual_sync_status()["phases"]["core"]["status"], "completed")

    def test_http_route_is_authenticated_manager_only_and_reports_busy_as_a_conflict(self):
        token = "a" * 64
        bridge = SimpleNamespace(
            port=0,
            token=token,
            trigger_local_rebuild=mock.Mock(return_value={"state": "core_completed"}),
        )
        server = BRIDGE.ThreadingHTTPServer((BRIDGE.HOST, 0), BRIDGE.make_handler(bridge))
        bridge.port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def post(body=b"{}", *, supplied_token=token, origin=BRIDGE.MANAGER_ORIGIN):
            request = Request(
                f"http://{BRIDGE.HOST}:{bridge.port}/sync/local-rebuild",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "Origin": origin,
                    "X-XHS-Bridge-Token": supplied_token,
                },
                method="POST",
            )
            try:
                with urlopen(request, timeout=2) as response:
                    return response.status, json.loads(response.read().decode("utf-8"))
            except HTTPError as error:
                return error.code, json.loads(error.read().decode("utf-8"))

        try:
            status, body = post()
            self.assertEqual(status, BRIDGE.HTTPStatus.ACCEPTED)
            self.assertEqual(body, {"ok": True, "state": "core_completed"})
            bridge.trigger_local_rebuild.assert_called_once_with()

            bridge.trigger_local_rebuild.reset_mock()
            for status, body in (
                post(supplied_token="b" * 64),
                post(origin="https://attacker.invalid"),
            ):
                self.assertEqual(status, BRIDGE.HTTPStatus.UNAUTHORIZED)
                self.assertEqual(body, {"ok": False})
            status, _ = post(b'{"board_ids": ["x"]}')
            self.assertEqual(status, BRIDGE.HTTPStatus.BAD_REQUEST)
            bridge.trigger_local_rebuild.assert_not_called()

            bridge.trigger_local_rebuild.side_effect = BRIDGE.BridgeBusyError("organization is already running in Chrome")
            status, body = post()
            self.assertEqual(status, BRIDGE.HTTPStatus.CONFLICT)
            self.assertFalse(body["ok"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
