import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


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
        self.assertEqual(BRIDGE.PROTOCOL_VERSION, 4)

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
