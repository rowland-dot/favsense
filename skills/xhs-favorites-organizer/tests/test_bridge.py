import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "bridge-server.py"
SPEC = importlib.util.spec_from_file_location("xhs_bridge", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BRIDGE)

FETCH_PATH = Path(__file__).parents[1] / "scripts" / "fetch-xhs-details.py"
FETCH_SPEC = importlib.util.spec_from_file_location("xhs_detail_fetcher", FETCH_PATH)
FETCHER = importlib.util.module_from_spec(FETCH_SPEC)
assert FETCH_SPEC.loader is not None
FETCH_SPEC.loader.exec_module(FETCHER)


class BridgeHelpersTest(unittest.TestCase):
    def test_media_candidates_respect_published_since(self):
        current = "a" * 24
        old = "b" * 24
        unknown = "c" * 24
        urls = {
            current: f"https://www.xiaohongshu.com/explore/{current}",
            old: f"https://www.xiaohongshu.com/explore/{old}",
            unknown: f"https://www.xiaohongshu.com/explore/{unknown}",
        }
        notes = {
            current: {"published_at": "2026-01-01_00:00:00"},
            old: {"published_at": "2025-12-31_23:59:59"},
        }
        self.assertEqual(
            BRIDGE.filter_media_candidates(urls, notes, "2026-01-01"),
            {current: urls[current]},
        )

    def test_checkout_verification_handles_the_dedicated_runtime_identity(self):
        source = FETCH_PATH.read_text(encoding="utf-8")
        self.assertIn('f"safe.directory={xhs_dir}"', source)
        self.assertIn('[*git_prefix, "rev-parse", "HEAD"]', source)
        self.assertIn('[*git_prefix, "status", "--porcelain"]', source)

    def test_organizer_git_privacy_check_handles_the_dedicated_runtime_identity(self):
        organizer = FETCH_PATH.with_name("organize.mjs").read_text(encoding="utf-8")
        self.assertIn('`safe.directory=${markerRoot}`', organizer)
        self.assertIn('`safe.directory=${repositoryRoot}`', organizer)

    def test_knowledge_builder_git_privacy_check_handles_runtime_identity(self):
        builder = FETCH_PATH.with_name("build-knowledge-base.mjs").read_text(encoding="utf-8")
        self.assertIn('`safe.directory=${current}`', builder)
        self.assertIn('`safe.directory=${root}`', builder)

    def test_protocol_version_is_pinned(self):
        self.assertEqual(BRIDGE.PROTOCOL_VERSION, 5)

    def test_manual_organization_only_launches_chrome_after_explicit_trigger(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            chrome = root / "Google" / "Chrome" / "Application" / "chrome.exe"
            chrome.parent.mkdir(parents=True)
            chrome.write_bytes(b"chrome")
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.trigger_lock = BRIDGE.threading.Lock()
            bridge.processing_lock = BRIDGE.threading.Lock()
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.board_order = ["first"]
            bridge.boards = {"first": "First"}
            bridge.workspace = root
            bridge.config_path = root / "config.json"
            bridge.port = 47631

            with mock.patch.dict(BRIDGE.os.environ, {"LOCALAPPDATA": str(root)}, clear=True), mock.patch.object(BRIDGE.subprocess, "Popen") as popen:
                self.assertFalse(popen.called)
                status = bridge.trigger_manual_sync()

            self.assertEqual(status["state"], "starting")
            self.assertEqual(status["board_count"], 1)
            self.assertNotIn("batch", status)
            launched = popen.call_args.args[0]
            self.assertEqual(Path(launched[0]), chrome)
            self.assertIn("xhs_kb_sync=1", launched[1])
            self.assertIn("xhs_kb_mode=incremental", launched[1])
            with self.assertRaisesRegex(BRIDGE.BridgeBusyError, "already running"):
                bridge.trigger_manual_sync()

    def test_manual_organization_aggregates_board_results_without_exposing_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"first": "First", "last": "Last"}
            batch = "manual20260729010101"
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "running",
                "board_count": 2,
                "processed_boards": 0,
                "processed_run_ids": [],
                "scanned": 0,
                "new": 0,
            })
            first_run = bridge.manual_run_id(batch, "first")
            bridge.record_manual_result(first_run, "first", {
                "state": "completed", "scanned": 12, "new": 2, "next_board_id": "last",
            })
            running = bridge.manual_sync_status()
            self.assertEqual(running["state"], "running")
            self.assertEqual(running["processed_boards"], 1)
            self.assertEqual(running["current_board"], "Last")
            self.assertNotIn("processed_run_ids", running)

            last_run = bridge.manual_run_id(batch, "last")
            bridge.record_manual_result(last_run, "last", {
                "state": "completed", "scanned": 8, "new": 1, "next_board_id": None,
                "publish": {"status": "published"},
            })
            completed = bridge.manual_sync_status()
            self.assertEqual(completed["state"], "completed")
            self.assertEqual(completed["scanned"], 20)
            self.assertEqual(completed["new"], 3)
            self.assertEqual(completed["publish_status"], "published")

    def test_manual_organization_starting_state_expires_when_userscript_never_responds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.manual_sync_path = root / "manual-sync.json"
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual-stale",
                "state": "starting",
                "started_at": "2000-01-01T00:00:00+00:00",
                "processed_run_ids": [],
            })

            status = bridge.manual_sync_status()

            self.assertEqual(status["state"], "failed")
            self.assertIn("Tampermonkey", status["error"])
            self.assertNotIn("batch", status)
            self.assertEqual(bridge.read_manual_sync()["state"], "failed")

    def test_board_manager_only_accepts_the_exact_workbench_origin(self):
        self.assertTrue(BRIDGE.is_manager_origin("http://127.0.0.1:8766"))
        for origin in [
            None,
            "http://localhost:8766",
            "http://127.0.0.1:8000",
            "https://127.0.0.1:8766",
            "http://127.0.0.1",
            "http://example.com:8766",
            "http://user@127.0.0.1:8766",
            "http://127.0.0.1:8766/private",
        ]:
            with self.subTest(origin=origin):
                self.assertFalse(BRIDGE.is_manager_origin(origin))

    def test_board_switch_updates_known_boards_and_keeps_one_enabled(self):
        config = {"version": 1, "boards": [
            {"id": "first", "name": "First", "enabled": True},
            {"id": "second", "name": "Second", "enabled": False, "reason": "old"},
        ]}
        updated = BRIDGE.update_board_enabled(config, "second", True)
        self.assertTrue(updated["boards"][1]["enabled"])
        self.assertNotIn("reason", updated["boards"][1])
        BRIDGE.update_board_enabled(config, "first", False)
        self.assertEqual(config["boards"][0]["reason"], "用户在工作台中关闭")
        with self.assertRaisesRegex(ValueError, "at least one board"):
            BRIDGE.update_board_enabled(config, "second", False)
        with self.assertRaisesRegex(ValueError, "unknown board_id"):
            BRIDGE.update_board_enabled(config, "missing", True)
        with self.assertRaisesRegex(ValueError, "boolean"):
            BRIDGE.update_board_enabled(config, "second", "yes")

    def test_accepts_supported_note_url(self):
        url = "https://www.xiaohongshu.com/discovery/item/abc_123?xsec_token=secret"
        self.assertEqual(BRIDGE.note_id_from_url(url), "abc_123")

    def test_rejects_userinfo_and_other_hosts(self):
        invalid = [
            "https://attacker@example.com/explore/abc",
            "https://example.com/explore/abc",
            "http://www.xiaohongshu.com/explore/abc",
        ]
        for url in invalid:
            with self.subTest(url=url), self.assertRaises(ValueError):
                BRIDGE.note_id_from_url(url)

    def test_catalog_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            path.write_text(json.dumps({"version": 1, "notes": {"a": {}}}), encoding="utf-8")
            self.assertEqual(BRIDGE.read_catalog_ids(path), {"a"})

    def test_media_queue_skips_curated_and_cached_notes(self):
        with tempfile.TemporaryDirectory() as directory:
            media = Path(directory)
            cached = "b" * 24
            (media / f"{cached}.mp4").write_bytes(b"cached")
            unique = {
                "a" * 24: "https://www.xiaohongshu.com/explore/" + "a" * 24 + "?xsec_token=one",
                cached: "https://www.xiaohongshu.com/explore/" + cached + "?xsec_token=two",
                "c" * 24: "https://www.xiaohongshu.com/explore/" + "c" * 24 + "?xsec_token=three",
            }
            queued = BRIDGE.media_urls_to_cache(unique, {"c" * 24}, media)
            self.assertEqual(queued, [unique["a" * 24]])

    def test_disabled_video_analysis_never_starts_media_download(self):
        bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
        bridge.video_analysis_enabled = False
        with mock.patch.object(BRIDGE.subprocess, "Popen") as popen:
            result = bridge.cache_missing_media({"a" * 24: "https://example.invalid"})
        self.assertEqual(result["state"], "disabled")
        popen.assert_not_called()

    def test_enabled_video_analysis_schedules_download_off_sync_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.video_analysis_enabled = True
            bridge.curation = root / "curation.json"
            bridge.curation.write_text("{}", encoding="utf-8")
            bridge.media_dir = root / "media"
            bridge.media_dir.mkdir()
            bridge.state_dir = root / "state"
            bridge.state_dir.mkdir()
            bridge.run_dir = root / "runs"
            bridge.run_dir.mkdir()
            bridge.python = Path("python.exe")
            bridge.media_fetcher = Path("download-pending-media.py")
            bridge.xhs_dir = root / "xhs"
            bridge.workspace = root
            process = mock.Mock()
            process.stdin = mock.Mock()
            with mock.patch.object(BRIDGE.subprocess, "Popen", return_value=process) as popen:
                result = bridge.cache_missing_media({
                    "a" * 24: "https://www.xiaohongshu.com/explore/" + "a" * 24
                })
            self.assertEqual(result["state"], "scheduled")
            popen.assert_called_once()
            process.stdin.close.assert_called_once()

    def test_safety_stop_sentinel_prevents_future_media_workers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.video_analysis_enabled = True
            bridge.state_dir = root
            (root / "media-download-safety-stop.json").write_text("{}", encoding="utf-8")
            with mock.patch.object(BRIDGE.subprocess, "Popen") as popen:
                result = bridge.cache_missing_media({"a" * 24: "https://example.invalid"})
            self.assertEqual(result["state"], "safety-stopped")
            popen.assert_not_called()

    def test_fetch_payload_contract_keeps_sanitized_gaps(self):
        notes, failures = BRIDGE.parse_fetch_payload(json.dumps({
            "notes": [{"note_id": "ok"}],
            "failures": [{"note_id": "gone", "reason": "detail unavailable"}],
        }), {"ok", "gone"})
        self.assertEqual([note["note_id"] for note in notes], ["ok"])
        self.assertEqual(failures[0]["note_id"], "gone")

    def test_fetch_payload_must_exactly_partition_requested_notes(self):
        with self.assertRaises(ValueError):
            BRIDGE.parse_fetch_payload(json.dumps({
                "notes": [{"note_id": "ok"}],
                "failures": [],
            }), {"ok", "missing"})
        with self.assertRaises(ValueError):
            BRIDGE.parse_fetch_payload(json.dumps({
                "notes": [{"note_id": "ok"}],
                "failures": [{"note_id": "ok", "reason": "request failed"}],
            }), {"ok"})

    def test_error_redacts_xsec_token(self):
        message = BRIDGE.sanitize_error("bad https://x/?xsec_token=secret&x=1")
        self.assertNotIn("secret", message)
        self.assertIn("[REDACTED]", message)

    def test_configured_paths_stay_inside_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            resolved = BRIDGE.resolve_workspace_path(workspace, "config/profile.json", "domain_profile")
            self.assertEqual(resolved, workspace / "config" / "profile.json")
            with self.assertRaises(ValueError):
                BRIDGE.resolve_workspace_path(workspace, "../outside.json", "domain_profile")

    def test_huggingface_publish_config_is_explicit_and_token_free(self):
        disabled = BRIDGE.normalize_publish_config({"version": 1})
        self.assertIsNone(disabled)
        enabled = BRIDGE.normalize_publish_config({
            "version": 1,
            "publish": {
                "enabled": True,
                "provider": "huggingface",
                "repository": "https://huggingface.co/spaces/example/favsense",
                "branch": "main",
            },
        })
        self.assertEqual(enabled["repository"], "https://huggingface.co/spaces/example/favsense")
        self.assertNotIn("token", enabled)
        with self.assertRaisesRegex(ValueError, "Hugging Face Space"):
            BRIDGE.normalize_publish_config({
                "version": 1,
                "publish": {"enabled": True, "provider": "huggingface", "repository": "https://example.com/repo"},
            })

    def test_publish_runs_only_after_the_final_enabled_board(self):
        bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
        bridge.board_order = ["first", "last"]
        bridge.publish_config = {"enabled": True}
        calls = []
        bridge.publish_public_site = lambda: calls.append("published") or {"ok": True, "status": "published"}
        self.assertIsNone(bridge.publish_after_board("first"))
        self.assertEqual(bridge.publish_after_board("last")["status"], "published")
        self.assertEqual(calls, ["published"])

    def test_publish_timeout_is_reported_without_failing_local_sync(self):
        bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
        bridge.publisher = Path("publish-huggingface.mjs")
        bridge.workspace = Path(".").resolve()
        bridge.publish_config = {
            "repository": "https://huggingface.co/spaces/example/favsense",
            "branch": "main",
        }
        with mock.patch.object(
            BRIDGE.subprocess,
            "run",
            side_effect=BRIDGE.subprocess.TimeoutExpired(["node", "publisher"], 180),
        ):
            result = bridge.publish_public_site()
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "failed")
        self.assertIn("timed out", result["error"])


class DetailFetcherTest(unittest.IsolatedAsyncioTestCase):
    async def test_each_note_is_requested_once_and_failures_do_not_stop_the_batch(self):
        class FakeApp:
            def __init__(self):
                self.calls = []

            async def extract(self, url, *, download, data):
                self.calls.append(url)
                if url == "gone":
                    return []
                if url == "broken":
                    raise RuntimeError("https://x/?xsec_token=secret")
                return [{"note_id": "ok", "title": "A note"}]

        app = FakeApp()
        ok, no_detail = await FETCHER.extract_note(app, "ok", "ok")
        gone, unavailable = await FETCHER.extract_note(app, "gone", "gone")
        broken, failed = await FETCHER.extract_note(app, "broken", "broken")

        self.assertIsNotNone(ok)
        self.assertIsNone(no_detail)
        self.assertIsNone(gone)
        self.assertEqual(unavailable, {"note_id": "gone", "reason": "detail unavailable"})
        self.assertIsNone(broken)
        self.assertEqual(failed, {"note_id": "broken", "reason": "request failed"})
        self.assertEqual(app.calls, ["ok", "gone", "broken"])


if __name__ == "__main__":
    unittest.main()
