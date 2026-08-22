import importlib.util
import json
from datetime import timedelta
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen


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


DIANDIAN_SKILL_SOURCE = Path(__file__).parents[2] / "xhs-diandian-summarize-note"


def write_test_diandian_skill(path: Path, saver_source: str) -> None:
    shutil.copytree(DIANDIAN_SKILL_SOURCE, path)
    (path / "scripts" / "save_diandian_summary.py").write_text(saver_source, encoding="utf-8")


def upgrade_test_diandian_skill_to_cdp(path: Path, transport_source: str) -> None:
    transport_path = path / "scripts" / "cdp_transport.py"
    transport_path.write_text(transport_source, encoding="utf-8")
    release_path = path / "release.json"
    release = json.loads(release_path.read_text(encoding="utf-8"))
    release.update({
        "version": "1.2.0",
        "release_directory": "xhs-diandian-summarize-note-v1.2.0",
        "cdp_transport": "scripts/cdp_transport.py",
    })
    release["files"].append("scripts/cdp_transport.py")
    release_path.write_text(json.dumps(release), encoding="utf-8")


def configure_point_v2(bridge, root: Path, note_ids) -> None:
    bridge.diandian_release = {"version": "1.2.0"}
    bridge.diandian_browser_contract = {"enabled": True, "version": 1}
    if not isinstance(getattr(bridge, "catalog_path", None), Path):
        bridge.catalog_path = root / ".xhs-favorites" / "catalog.json"
    try:
        catalog = json.loads(bridge.catalog_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        catalog = {"notes": {}}
    catalog.setdefault("notes", {})
    for note_id in note_ids:
        catalog["notes"].setdefault(note_id, {})["content_sha256"] = "a" * 64
    BRIDGE.atomic_json(bridge.catalog_path, catalog)


def write_point_v2_record(bridge, note_id: str, title: str, summary: str) -> None:
    BRIDGE.atomic_json(bridge.diandian_dir / f"{note_id}.json", {
        "version": 2,
        "provider": "xiaohongshu-diandian",
        "prompt": "总结",
        "prompt_version": BRIDGE.diandian_prompt_version(bridge.diandian_release, bridge.diandian_browser_contract),
        "note_id": note_id,
        "title": title,
        "summary": summary,
        "content_sha256": "a" * 64,
        "request_sha256": BRIDGE.diandian_result_digest(title, summary),
        "summary_sha256": BRIDGE.hashlib.sha256(summary.strip().encode("utf-8")).hexdigest(),
        "captured_at": "2026-08-23T00:00:00+00:00",
    })


class BridgeHelpersTest(unittest.TestCase):
    def test_permanent_userscript_endpoint_never_discloses_the_bridge_token(self):
        with tempfile.TemporaryDirectory() as directory:
            userscript = Path(directory) / "xhs-favorites.user.js"
            userscript.write_text("// ==UserScript==\n", encoding="utf-8")
            bridge = SimpleNamespace(port=0, userscript=userscript)
            server = BRIDGE.ThreadingHTTPServer((BRIDGE.HOST, 0), BRIDGE.make_handler(bridge))
            bridge.port = server.server_address[1]
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with self.assertRaises(HTTPError) as rejected:
                    urlopen(
                        f"http://{BRIDGE.HOST}:{bridge.port}/xhs-favorites.user.js",
                        timeout=2,
                    )
                self.assertEqual(rejected.exception.code, BRIDGE.HTTPStatus.NOT_FOUND)
                self.assertNotIn("==UserScript==", rejected.exception.read().decode("utf-8"))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_one_time_userscript_installer_is_executable_only_until_the_installed_script_checks_in(self):
        fixture = json.loads(
            (Path(__file__).parents[1] / "test-fixtures" / "userscript-install-capability.json")
            .read_text(encoding="utf-8")
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            userscript = root / "xhs-favorites.user.js"
            userscript.write_text("// ==UserScript==\n// private-test-marker\n", encoding="utf-8")
            capability_state = root / "userscript-install.json"
            capability = fixture["capability"]
            now = BRIDGE.datetime.now().astimezone()
            BRIDGE.atomic_json(capability_state, {
                "version": 1,
                "digest": BRIDGE.hashlib.sha256(capability.encode("ascii")).hexdigest(),
                "issued_at": now.isoformat(),
                "expires_at": (
                    now + timedelta(seconds=fixture["max_lifetime_seconds"])
                ).isoformat(),
            })
            token = "a" * 64
            bridge = SimpleNamespace(
                port=0,
                userscript=userscript,
                userscript_install_state=capability_state,
                token=token,
            )
            server = BRIDGE.ThreadingHTTPServer((BRIDGE.HOST, 0), BRIDGE.make_handler(bridge))
            bridge.port = server.server_address[1]
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            install_path = fixture["path_template"].format(capability=capability)

            def read_install(path=install_path):
                with urlopen(f"http://{BRIDGE.HOST}:{bridge.port}{path}", timeout=2) as response:
                    return response.status, response.headers, response.read().decode("utf-8")

            try:
                for _ in range(2):
                    status, headers, body = read_install()
                    self.assertEqual(status, BRIDGE.HTTPStatus.OK)
                    self.assertEqual(headers.get_content_type(), fixture["install_content_type"])
                    self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                    self.assertEqual(headers["Cache-Control"], "no-store")
                    self.assertIsNone(headers["Access-Control-Allow-Origin"])
                    self.assertIn("private-test-marker", body)

                request = Request(
                    f"http://{BRIDGE.HOST}:{bridge.port}/install/complete",
                    data=json.dumps({"capability": capability}).encode("utf-8"),
                    headers={
                        "Content-Type": "application/json",
                        "X-XHS-Bridge-Token": token,
                    },
                    method="POST",
                )
                with urlopen(request, timeout=2) as response:
                    self.assertEqual(response.status, BRIDGE.HTTPStatus.OK)
                    self.assertEqual(json.loads(response.read().decode("utf-8")), {
                        "ok": True,
                        "invalidated": True,
                    })

                for path in [
                    install_path,
                    fixture["path_template"].format(capability="d" * 64),
                ]:
                    with self.subTest(path=path), self.assertRaises(HTTPError) as rejected:
                        read_install(path)
                    self.assertEqual(rejected.exception.code, BRIDGE.HTTPStatus.NOT_FOUND)
                    self.assertNotIn("private-test-marker", rejected.exception.read().decode("utf-8"))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_userscript_installer_rejects_expired_or_overlong_capabilities(self):
        fixture = json.loads(
            (Path(__file__).parents[1] / "test-fixtures" / "userscript-install-capability.json")
            .read_text(encoding="utf-8")
        )
        capability = fixture["capability"]
        now = BRIDGE.datetime.now().astimezone()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "userscript-install.json"
            for issued_at, expires_at in [
                (
                    now - timedelta(seconds=20),
                    now - timedelta(seconds=10),
                ),
                (
                    now,
                    now + timedelta(seconds=fixture["max_lifetime_seconds"] + 1),
                ),
            ]:
                BRIDGE.atomic_json(path, {
                    "version": 1,
                    "digest": BRIDGE.hashlib.sha256(capability.encode("ascii")).hexdigest(),
                    "issued_at": issued_at.isoformat(),
                    "expires_at": expires_at.isoformat(),
                })
                with self.subTest(expires_at=expires_at):
                    self.assertFalse(BRIDGE.valid_userscript_install_capability(path, capability))

    def test_generated_userscript_checks_in_with_its_own_install_capability(self):
        template = (
            Path(__file__).parents[1] / "assets" / "xhs-favorites.user.js.template"
        ).read_text(encoding="utf-8")

        self.assertIn('const INSTALL_CAPABILITY = "__INSTALL_CAPABILITY__";', template)
        self.assertIn(
            'post("/install/complete", { capability: INSTALL_CAPABILITY }',
            template,
        )
        self.assertIn("// @updateURL    none", template)
        self.assertIn("// @downloadURL  none", template)
        self.assertNotIn("http://127.0.0.1:__PORT__/xhs-favorites.user.js", template)

    def test_userscript_install_version_advances_when_setup_rotates_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            template = root / "userscript.template.js"
            state = root / "userscript-install.json"
            template.write_text(
                "// ==UserScript==\n// @version      3.0.1\n// ==/UserScript==\n",
                encoding="utf-8",
            )
            capability = "c" * 64

            def issued_version(issued_at):
                BRIDGE.atomic_json(state, {
                    "version": 1,
                    "digest": BRIDGE.hashlib.sha256(capability.encode("ascii")).hexdigest(),
                    "issued_at": issued_at.isoformat(),
                    "expires_at": (issued_at + timedelta(minutes=10)).isoformat(),
                })
                return BRIDGE.userscript_install_version(template, state)

            first_issued = BRIDGE.datetime.fromisoformat("2026-08-18T01:02:03.123456+00:00")
            second_issued = first_issued + timedelta(seconds=1)
            first = issued_version(first_issued)
            second = issued_version(second_issued)

            self.assertEqual(first, "3.0.1.2026.8.18.1.2.3.123456")
            self.assertEqual(second, "3.0.1.2026.8.18.1.2.4.123456")
            self.assertGreater(tuple(map(int, second.split("."))), tuple(map(int, first.split("."))))

    def test_userscript_render_uses_the_current_install_version(self):
        bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
        bridge.all_boards = []
        bridge.port = 47631
        bridge.token = "a" * 64
        bridge.install_capability = "b" * 64
        bridge.userscript_install_version = "3.0.1.2026.8.18.1.2.3.123456"
        bridge.userscript_template = (
            Path(__file__).parents[1] / "assets" / "xhs-favorites.user.js.template"
        )
        bridge.diandian_browser_contract = {"enabled": False}

        userscript = bridge.userscript_content()

        self.assertIn(
            "// @version      3.0.1.2026.8.18.1.2.3.123456",
            userscript,
        )

    def test_error_sanitizer_redacts_browser_credentials_and_private_xhs_paths(self):
        raw = (
            "xsec_token=secret Cookie: session=secret\n"
            "Authorization: Bearer secret-value\n"
            "X-XHS-Bridge-Token: bridge-secret\n"
            "https://www.xiaohongshu.com/user/profile/private-profile\n"
            "https://www.xiaohongshu.com/board/private-board\n"
            "/user/profile/relative-profile /board/relative-board"
        )

        cleaned = BRIDGE.sanitize_error(raw)

        self.assertNotIn("secret", cleaned)
        self.assertNotIn("private-profile", cleaned)
        self.assertNotIn("private-board", cleaned)
        self.assertNotIn("relative-profile", cleaned)
        self.assertNotIn("relative-board", cleaned)
        self.assertGreaterEqual(cleaned.count("[REDACTED]"), 1)

    def test_error_sanitizer_rejects_encoded_or_invisible_whitespace(self):
        for raw in ["", " \t\r\n", "\u00a0", "&#x20;", "&nbsp;", "%20"]:
            with self.subTest(raw=raw):
                self.assertEqual(
                    BRIDGE.sanitize_error(raw),
                    "No diagnostic output was returned.",
                )
        self.assertEqual(BRIDGE.sanitize_error("safe\u200b\tmessage"), "safe message")
        self.assertEqual(BRIDGE.sanitize_error("%1B%5B31mboom"), "[31mboom")

    def test_manual_status_normalizes_legacy_errors_at_the_public_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.manual_sync_path = Path(directory) / "manual-sync.json"

            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "state": "failed",
                "error": "&#x20;",
            })
            empty = bridge.manual_sync_status()
            self.assertEqual(empty["error"], BRIDGE.MANUAL_SYNC_FALLBACK_ERROR)

            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "state": "failed",
                "error": BRIDGE.LEGACY_DIANDIAN_HALT_ERROR,
            })
            legacy = bridge.manual_sync_status()
            self.assertIs(legacy["core_completed"], True)
            self.assertEqual(legacy["summary_halt_reason"], "transport-failed")
            self.assertIn("点点 AI", legacy["error"])
            self.assertIn("核心整理结果已保留", legacy["error"])

    def test_manual_status_v2_exposes_orthogonal_safe_projection(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.manual_sync_path = Path(directory) / "manual-sync.json"
            bridge.organization_status_v2_enabled = True
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "fixture-run", "state": "failed", "core_completed": True,
                "scanned": 3, "new": 2, "summarized": 1, "summary_failed": 1,
                "summary_pending": 1, "summary_halt_reason": "transport-failed",
            })
            status = bridge.manual_sync_status()
            self.assertEqual(status["schema_version"], 2)
            self.assertEqual(status["phases"]["core"]["status"], "completed")
            self.assertEqual(status["phases"]["summary"]["status"], "failed")
            self.assertNotIn("error", status)

    def test_snapshot_subprocess_result_is_an_exact_safe_envelope(self):
        valid = {
            "schema_version": 1,
            "ok": True,
            "outcome": "built",
            "build_version": "a" * 64,
            "counts": {"notes": 2, "categories": 1, "resources": 1},
        }
        self.assertEqual(BRIDGE.parse_snapshot_build_result(json.dumps(valid)), valid)
        for invalid in [
            {**valid, "path": "private"},
            {**valid, "build_version": "short"},
            {**valid, "counts": {"notes": -1, "categories": 1, "resources": 1}},
            {**valid, "outcome": "published"},
        ]:
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    BRIDGE.parse_snapshot_build_result(json.dumps(invalid))

    def test_curation_subprocess_result_is_an_exact_safe_envelope(self):
        valid = {"schema_version": 1, "ok": True, "outcome": "ready_for_safe_build", "counts": {"accepted": 1, "pending": 1, "rejected": 0, "resource_pending": 1}}
        self.assertEqual(BRIDGE.parse_curation_pipeline_result(json.dumps(valid)), valid)
        for invalid in [{**valid, "notes": ["private"]}, {**valid, "outcome": "accepted"}, {**valid, "counts": {"accepted": True, "pending": 0, "rejected": 0, "resource_pending": 0}}]:
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    BRIDGE.parse_curation_pipeline_result(json.dumps(invalid))

    def test_manual_failure_turns_encoded_blank_diagnostics_into_actionable_guidance(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.manual_sync_path = Path(directory) / "manual-sync.json"
            bridge.summary_plans = {}
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manualblank",
                "state": "starting",
            })

            status = bridge.record_manual_failure({
                "run_id": "manualblank",
                "error": "&#x20;",
            })

            self.assertEqual(status["state"], "failed")
            self.assertEqual(status["error"], BRIDGE.MANUAL_SYNC_FALLBACK_ERROR)

    def test_pre_core_safety_failure_keeps_its_control_reason_to_the_bridge(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.manual_sync_path = Path(directory) / "manual-sync.json"
            bridge.summary_plans = {}
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manualsafe",
                "state": "starting",
            })

            status = bridge.record_manual_failure({
                "run_id": "manualsafe",
                "error": "xhs-safety-stop",
            })

            self.assertEqual(status["state"], "safety-stopped")
            self.assertIn("安全限制", status["error"])
            self.assertNotIn("core_completed", status)

    def test_profile_url_normalization_discards_signed_and_unrecognized_query_fields(self):
        normalized = BRIDGE.normalize_profile_url(
            "https://www.xiaohongshu.com/user/profile/testprofile"
            "?xsec_token=secret&source=share&tab=notes&subTab=likes"
        )
        parsed = BRIDGE.urlparse(normalized)
        self.assertEqual(BRIDGE.parse_qs(parsed.query), {"tab": ["fav"], "subTab": ["board"]})
        self.assertNotIn("secret", normalized)

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
        self.assertEqual(BRIDGE.PROTOCOL_VERSION, 11)

    def test_cli_requires_the_explicit_sop_runtime_root(self):
        base = [
            "bridge-server.py",
            "--workspace", "workspace",
            "--skill-dir", "skill",
            "--config", "config",
        ]
        with mock.patch.object(BRIDGE.sys, "argv", base), mock.patch.object(
            BRIDGE.sys, "stderr"
        ), self.assertRaises(SystemExit):
            BRIDGE.parse_args()
        with mock.patch.object(
            BRIDGE.sys,
            "argv",
            [*base, "--sop-runtime", "shared-runtime"],
        ):
            args = BRIDGE.parse_args()

        self.assertEqual(args.sop_runtime, "shared-runtime")

    def test_sop_runtime_contract_derives_only_the_fixed_shared_channel_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "运行系统"
            profile = runtime / ".secrets" / "browser-profiles" / "cdp-chrome"
            profile.mkdir(parents=True)
            port_file = runtime / ".secrets" / "cdp-port.txt"
            port_file.write_text("9224\n", encoding="ascii")
            launcher = runtime / "scripts" / "启动扫描浏览器.bat"
            launcher.parent.mkdir(parents=True)
            launcher.write_text("@echo off\n", encoding="utf-8")

            contract = BRIDGE.resolve_sop_browser_contract(runtime)

            self.assertEqual(contract.runtime, runtime.resolve())
            self.assertEqual(contract.profile, profile.resolve())
            self.assertEqual(contract.port_file, port_file.resolve())
            self.assertEqual(contract.launcher, launcher.resolve())

    def test_sop_port_is_re_read_and_version_websocket_is_strictly_loopback(self):
        with tempfile.TemporaryDirectory() as directory:
            port_file = Path(directory) / "cdp-port.txt"
            endpoint_payloads = {
                9223: {"webSocketDebuggerUrl": "ws://127.0.0.1:9223/devtools/browser/first"},
                9224: {"webSocketDebuggerUrl": "ws://localhost:9224/devtools/browser/second"},
            }

            def fake_open(request, timeout=0):
                parsed = urlparse(request.full_url)
                payload = endpoint_payloads[int(parsed.port)]
                response = mock.MagicMock()
                response.status = 200
                response.read.return_value = json.dumps(payload).encode("utf-8")
                response.__enter__.return_value = response
                return response

            direct_opener = mock.MagicMock()
            direct_opener.open.side_effect = fake_open
            with mock.patch.object(BRIDGE, "build_opener", return_value=direct_opener):
                port_file.write_text("9223\n", encoding="ascii")
                first = BRIDGE.read_sop_devtools_endpoint(port_file)
                port_file.write_text("9224\n", encoding="ascii")
                second = BRIDGE.read_sop_devtools_endpoint(port_file)

            self.assertEqual(first.port, 9223)
            self.assertEqual(second.port, 9224)
            self.assertEqual(second.browser_path, "/devtools/browser/second")

            port_file.write_text("9224\n", encoding="ascii")
            endpoint_payloads[9224] = {
                "webSocketDebuggerUrl": "ws://attacker.invalid:9224/devtools/browser/second"
            }
            direct_opener = mock.MagicMock()
            direct_opener.open.side_effect = fake_open
            with mock.patch.object(BRIDGE, "build_opener", return_value=direct_opener), self.assertRaisesRegex(
                RuntimeError, "websocket"
            ):
                BRIDGE.read_sop_devtools_endpoint(port_file)

    def test_sop_devtools_http_and_websocket_never_use_environment_proxies(self):
        endpoint = BRIDGE.DevToolsEndpoint(9224, "/devtools/browser/browser-id")
        response = mock.MagicMock()
        response.status = 200
        response.read.return_value = b"{}"
        response.__enter__.return_value = response
        direct_opener = mock.MagicMock()
        direct_opener.open.return_value = response

        with mock.patch.object(BRIDGE, "build_opener", return_value=direct_opener) as build:
            BRIDGE.loopback_devtools_json(endpoint, "/json/list")

        build.assert_called_once()
        direct_opener.open.assert_called_once()
        request = direct_opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:9224/json/list")

        connection = mock.MagicMock()
        fake_connect = mock.Mock(return_value=connection)
        fake_client = SimpleNamespace(connect=fake_connect)
        target_payload = {
            "id": "target-id",
            "webSocketDebuggerUrl": "ws://127.0.0.1:9224/devtools/page/target-id",
        }
        with mock.patch.object(
            BRIDGE, "read_sop_devtools_endpoint", return_value=endpoint
        ), mock.patch.object(
            BRIDGE, "loopback_devtools_json", return_value=target_payload
        ), mock.patch.dict(
            "sys.modules", {"websockets.sync.client": fake_client}
        ):
            target = BRIDGE.open_sop_cdp_target(Path("port-file"))

        fake_connect.assert_called_once()
        self.assertIsNone(fake_connect.call_args.kwargs["proxy"])
        self.assertIs(target._connection, connection)

    def test_shared_sop_page_open_re_reads_endpoint_creates_and_activates_one_tab(self):
        endpoint = BRIDGE.DevToolsEndpoint(9224, "/devtools/browser/browser-id")
        requests = []

        def fake_json(active_endpoint, path, *, method="GET"):
            requests.append((active_endpoint.port, path, method))
            if path.startswith("/json/new?"):
                return {
                    "id": "target-id",
                    "webSocketDebuggerUrl": "ws://127.0.0.1:9224/devtools/page/target-id",
                }
            return {}

        bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
        bridge.sop_port_file = Path("dynamic-port-file")
        with mock.patch.object(
            BRIDGE, "read_sop_devtools_endpoint", return_value=endpoint
        ) as read_endpoint, mock.patch.object(
            BRIDGE, "loopback_devtools_json", side_effect=fake_json
        ), mock.patch.object(
            BRIDGE,
            "loopback_devtools_action",
            side_effect=lambda active_endpoint, path, method="GET": requests.append(
                (active_endpoint.port, path, method)
            ),
        ), mock.patch.object(BRIDGE.subprocess, "Popen") as popen:
            result = bridge.open_sop_browser_page(
                "https://www.xiaohongshu.com/explore", activate=True
            )

        read_endpoint.assert_called_once_with(bridge.sop_port_file)
        popen.assert_not_called()
        self.assertEqual(result, {"id": "target-id"})
        self.assertEqual(requests[0][0], 9224)
        self.assertEqual(requests[0][2], "PUT")
        self.assertEqual(requests[1], (9224, "/json/activate/target-id", "GET"))

    def test_browser_channel_id_is_path_only_and_normalized_for_windows(self):
        first = BRIDGE.browser_channel_id(Path(r"C:\\Users\\Rowla\\Codex\\SOP - 小红书\\运行系统"))
        equivalent = BRIDGE.browser_channel_id(Path(r"c:\\users\\rowla\\codex\\sop - 小红书\\运行系统\\"))
        different = BRIDGE.browser_channel_id(Path(r"C:\\Users\\Rowla\\Codex\\Other\\运行系统"))

        self.assertEqual(first, equivalent)
        self.assertNotEqual(first, different)
        self.assertRegex(first, r"^[a-f0-9]{64}$")

    def test_health_and_local_session_expose_only_the_approved_browser_channel_fields(self):
        token = "a" * 64
        bridge = SimpleNamespace(
            port=0,
            token=token,
            board_order=["board"],
            config_id="c" * 64,
            runtime_id="r" * 64,
            browser_channel_id="b" * 64,
            browser_session_ready=mock.Mock(return_value=True),
            diandian_cdp_enabled=True,
        )
        server = BRIDGE.ThreadingHTTPServer((BRIDGE.HOST, 0), BRIDGE.make_handler(bridge))
        bridge.port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with self.assertRaises(HTTPError) as unauthorized:
                urlopen(f"http://{BRIDGE.HOST}:{bridge.port}/health", timeout=2)
            self.assertEqual(unauthorized.exception.code, BRIDGE.HTTPStatus.UNAUTHORIZED)
            self.assertEqual(
                json.loads(unauthorized.exception.read().decode("utf-8")),
                {"ok": False},
            )
            health_request = Request(
                f"http://{BRIDGE.HOST}:{bridge.port}/health",
                headers={"X-XHS-Bridge-Token": token},
            )
            with urlopen(health_request, timeout=2) as response:
                health = json.loads(response.read().decode("utf-8"))
            local_request = Request(
                f"http://{BRIDGE.HOST}:{bridge.port}/local-session",
                headers={"Origin": BRIDGE.MANAGER_ORIGIN},
            )
            with urlopen(local_request, timeout=2) as response:
                local = json.loads(response.read().decode("utf-8"))

            self.assertEqual(health["browser_channel_id"], "b" * 64)
            self.assertNotIn("browser_session", health)
            self.assertEqual(local["browser_session"], {"owner": "sop-cdp", "ready": True})
            self.assertNotIn("browser_channel_id", local)
            serialized = json.dumps({"health": health, "local": local})
            self.assertNotIn("cdp-port", serialized)
            self.assertNotIn("browser-profiles", serialized)
            self.assertNotRegex(serialized, r'"port"\s*:')
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_diandian_is_optional_and_disabled_by_default(self):
        self.assertEqual(BRIDGE.normalize_diandian_config({}), {"enabled": False})

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.diandian_enabled = False
            bridge.diandian_dir = root / ".xhs-favorites" / "diandian-summaries"
            bridge.summary_plans = {}
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "出海电商"}
            batch = "manual20260812010101"
            run_id = bridge.manual_run_id(batch, "board")
            BRIDGE.atomic_json(bridge.manual_sync_path, {"batch": batch, "state": "running"})

            plan = bridge.diandian_summary_plan({
                "run_id": run_id,
                "board_id": "board",
                "note_ids": ["a" * 24],
            })

            self.assertEqual(plan, {"enabled": False, "note_ids": []})
            self.assertFalse(bridge.diandian_dir.exists())

    def test_diandian_skill_path_can_point_to_a_versioned_external_release(self):
        fixture = json.loads(
            (Path(__file__).parents[1] / "test-fixtures" / "external-diandian-skill-path.json")
            .read_text(encoding="utf-8")
        )
        with tempfile.TemporaryDirectory() as workspace_directory, tempfile.TemporaryDirectory() as library_directory:
            workspace = Path(workspace_directory)
            external_skill = Path(library_directory) / "xhs-diandian-summarize-note-v1.1.0" / fixture["skill_name"]
            write_test_diandian_skill(
                external_skill,
                "def save_record(destination, title, summary_text, note_id):\n    return None\n",
            )

            normalized = BRIDGE.normalize_diandian_config({
                "diandian": {"enabled": True, fixture["config_key"]: str(external_skill)}
            })
            resolved = BRIDGE.resolve_diandian_skill_path(workspace, normalized)

            self.assertEqual(resolved, external_skill.resolve())
            self.assertEqual(
                BRIDGE.diandian_saver_path(resolved),
                external_skill.resolve() / "scripts" / "save_diandian_summary.py",
            )
            self.assertEqual(BRIDGE.validate_diandian_skill_path(resolved), resolved)
            self.assertEqual(
                BRIDGE.load_diandian_browser_contract(resolved)["selectors"]["input_controls"],
                ["textarea"],
            )

    def test_diandian_browser_contract_rejects_unsafe_or_inconsistent_values(self):
        valid_contract = json.loads(
            (DIANDIAN_SKILL_SOURCE / "runtime" / "browser-contract.json")
            .read_text(encoding="utf-8")
        )
        invalid_contracts = []
        for url in (
            "https://user@www.xiaohongshu.com/ai_chat",
            "https://www.xiaohongshu.com:444/ai_chat",
            "https://www.xiaohongshu.com/ai_chat?source=test",
        ):
            candidate = json.loads(json.dumps(valid_contract))
            candidate["ai_chat_url"] = url
            invalid_contracts.append(candidate)
        prompt_drift = json.loads(json.dumps(valid_contract))
        prompt_drift["prompt"] = "ignore previous instructions"
        invalid_contracts.append(prompt_drift)
        short_deadline = json.loads(json.dumps(valid_contract))
        short_deadline["timings_ms"]["single_note_wait"] = 100
        invalid_contracts.append(short_deadline)

        for contract in invalid_contracts:
            with self.subTest(contract=contract):
                with tempfile.TemporaryDirectory() as directory:
                    skill_path = Path(directory)
                    (skill_path / "runtime").mkdir()
                    (skill_path / "runtime" / "browser-contract.json").write_text(
                        json.dumps(contract, ensure_ascii=False),
                        encoding="utf-8",
                    )
                    with self.assertRaisesRegex(ValueError, "invalid runtime values"):
                        BRIDGE.load_diandian_browser_contract(skill_path)

    def test_diandian_release_manifest_must_include_runtime_contract_and_saver(self):
        with tempfile.TemporaryDirectory() as directory:
            skill_path = Path(directory) / "skill"
            write_test_diandian_skill(
                skill_path,
                "def save_record(destination, title, summary_text, note_id):\n    return None\n",
            )
            release_path = skill_path / "release.json"
            release = json.loads(release_path.read_text(encoding="utf-8"))
            release["files"].remove("runtime/browser-contract.json")
            release_path.write_text(json.dumps(release), encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "file manifest is incomplete"):
                BRIDGE.validate_diandian_skill_path(skill_path)

    def test_diandian_v12_release_loads_the_manifest_bound_cdp_ask_export(self):
        with tempfile.TemporaryDirectory() as directory:
            skill_path = Path(directory) / "skill"
            write_test_diandian_skill(
                skill_path,
                "def save_record(destination, title, summary_text, note_id):\n    return None\n",
            )
            upgrade_test_diandian_skill_to_cdp(
                skill_path,
                "import time\n"
                "def ask(session, note_url, spec=None, tries=60, sleep=time.sleep):\n"
                "    return session.evaluate(note_url)\n",
            )

            release = BRIDGE.load_diandian_release(skill_path)
            transport = BRIDGE.diandian_cdp_transport_path(skill_path, release)
            ask = BRIDGE.load_diandian_cdp_ask(transport)

            self.assertEqual(release["version"], "1.2.0")
            self.assertEqual(transport, skill_path / "scripts" / "cdp_transport.py")
            self.assertEqual(ask(SimpleNamespace(evaluate=lambda value: value), "note"), "note")
            self.assertEqual(BRIDGE.validate_diandian_skill_path(skill_path), skill_path.resolve())

    def test_diandian_cdp_manifest_and_callable_fail_closed(self):
        invalid_sources = {
            "missing-export": "VALUE = 1\n",
            "wrong-signature": "def ask(session, note_url):\n    return ''\n",
        }
        for name, source in invalid_sources.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                skill_path = Path(directory) / "skill"
                write_test_diandian_skill(
                    skill_path,
                    "def save_record(destination, title, summary_text, note_id):\n    return None\n",
                )
                upgrade_test_diandian_skill_to_cdp(skill_path, source)
                transport = skill_path / "scripts" / "cdp_transport.py"
                with self.assertRaisesRegex(ValueError, "CDP transport"):
                    BRIDGE.load_diandian_cdp_ask(transport)

        with tempfile.TemporaryDirectory() as directory:
            skill_path = Path(directory) / "skill"
            write_test_diandian_skill(
                skill_path,
                "def save_record(destination, title, summary_text, note_id):\n    return None\n",
            )
            upgrade_test_diandian_skill_to_cdp(
                skill_path,
                "import time\n"
                "def ask(session, note_url, spec=None, tries=60, sleep=time.sleep):\n"
                "    return ''\n",
            )
            release_path = skill_path / "release.json"
            release = json.loads(release_path.read_text(encoding="utf-8"))
            release["cdp_transport"] = "../outside.py"
            release_path.write_text(json.dumps(release), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "CDP transport"):
                BRIDGE.load_diandian_release(skill_path)

        for name, version, include_transport in (
            ("v12-missing-transport", "1.2.0", False),
            ("v11-extra-transport", "1.1.9", True),
            ("future-version", "1.3.0", True),
        ):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                skill_path = Path(directory) / "skill"
                write_test_diandian_skill(
                    skill_path,
                    "def save_record(destination, title, summary_text, note_id):\n    return None\n",
                )
                if include_transport:
                    upgrade_test_diandian_skill_to_cdp(
                        skill_path,
                        "import time\ndef ask(session, note_url, spec=None, tries=60, sleep=time.sleep):\n    return ''\n",
                    )
                release_path = skill_path / "release.json"
                release = json.loads(release_path.read_text(encoding="utf-8"))
                release["version"] = version
                release["release_directory"] = f"xhs-diandian-summarize-note-v{version}"
                if not include_transport:
                    release.pop("cdp_transport", None)
                release_path.write_text(json.dumps(release), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "version schema"):
                    BRIDGE.load_diandian_release(skill_path)

    def test_userscript_render_uses_the_external_browser_contract(self):
        bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
        bridge.all_boards = []
        bridge.port = 47631
        bridge.token = "a" * 64
        bridge.install_capability = "b" * 64
        bridge.userscript_template = (
            Path(__file__).parents[1] / "assets" / "xhs-favorites.user.js.template"
        )
        bridge.diandian_browser_contract = {
            "enabled": True,
            **BRIDGE.load_diandian_browser_contract(DIANDIAN_SKILL_SOURCE),
        }
        bridge.diandian_browser_contract["selectors"]["input_controls"] = [
            ".external-skill-input"
        ]

        userscript = bridge.userscript_content()

        self.assertIn("https://www.xiaohongshu.com/ai_chat*", userscript)
        self.assertIn(".external-skill-input", userscript)
        self.assertNotIn("__DIANDIAN_CONTRACT__", userscript)
        self.assertNotIn("__DIANDIAN_MATCH_LINE__", userscript)

        bridge.diandian_browser_contract["cdp_enabled"] = True
        cdp_userscript = bridge.userscript_content()
        self.assertNotIn("// @match        https://www.xiaohongshu.com/ai_chat", cdp_userscript)
        self.assertIn('"cdp_enabled":true', cdp_userscript)

    def test_runtime_fingerprint_changes_when_external_skill_contract_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill_path = root / "skill"
            write_test_diandian_skill(
                skill_path,
                "def save_record(destination, title, summary_text, note_id):\n    return None\n",
            )
            config = root / "config.json"
            bridge = root / "bridge.py"
            userscript = root / "userscript.js"
            config.write_text(
                json.dumps({"diandian": {"enabled": True, "skill_path": str(skill_path)}}),
                encoding="utf-8",
            )
            bridge.write_text("bridge-v1", encoding="utf-8")
            userscript.write_text("userscript-v1", encoding="utf-8")
            original = BRIDGE.runtime_config_fingerprint(
                config, bridge, userscript, skill_path
            )
            contract_path = skill_path / "runtime" / "browser-contract.json"
            contract = json.loads(contract_path.read_text(encoding="utf-8"))
            contract["selectors"]["input_controls"] = [".updated-input"]
            contract_path.write_text(
                json.dumps(contract, ensure_ascii=False),
                encoding="utf-8",
            )

            updated = BRIDGE.runtime_config_fingerprint(
                config, bridge, userscript, skill_path
            )

            self.assertNotEqual(original, updated)

    def test_runtime_fingerprint_changes_when_external_cdp_transport_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            skill_path = root / "skill"
            write_test_diandian_skill(
                skill_path,
                "def save_record(destination, title, summary_text, note_id):\n    return None\n",
            )
            upgrade_test_diandian_skill_to_cdp(
                skill_path,
                "import time\ndef ask(session, note_url, spec=None, tries=60, sleep=time.sleep):\n    return 'first'\n",
            )
            config = root / "config.json"
            bridge = root / "bridge.py"
            userscript = root / "userscript.js"
            config.write_text("{}", encoding="utf-8")
            bridge.write_text("bridge", encoding="utf-8")
            userscript.write_text("userscript", encoding="utf-8")
            first = BRIDGE.runtime_config_fingerprint(
                config, bridge, userscript, skill_path
            )
            (skill_path / "scripts" / "cdp_transport.py").write_text(
                "import time\ndef ask(session, note_url, spec=None, tries=60, sleep=time.sleep):\n    return 'second'\n",
                encoding="utf-8",
            )
            second = BRIDGE.runtime_config_fingerprint(
                config, bridge, userscript, skill_path
            )
            self.assertNotEqual(first, second)

    def test_diandian_skill_path_resolves_an_explicit_portable_release_inside_the_workspace(self):
        fixture = json.loads(
            (Path(__file__).parents[1] / "test-fixtures" / "external-diandian-skill-path.json")
            .read_text(encoding="utf-8")
        )
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            expected = workspace / fixture["portable_example"]
            self.assertEqual(
                BRIDGE.resolve_diandian_skill_path(workspace, {
                    "enabled": True,
                    "skill_path": fixture["portable_example"],
                }),
                expected.resolve(),
            )

    def test_enabled_diandian_requires_an_explicit_skill_path(self):
        with self.assertRaisesRegex(ValueError, "diandian.skill_path"):
            BRIDGE.normalize_diandian_config({"diandian": {"enabled": True}})

    def test_diandian_skill_path_rejects_wrong_skill_identity(self):
        with tempfile.TemporaryDirectory() as workspace_directory, tempfile.TemporaryDirectory() as library_directory:
            workspace = Path(workspace_directory)
            external_skill = Path(library_directory) / "wrong-skill"
            (external_skill / "scripts").mkdir(parents=True)
            (external_skill / "runtime").mkdir(parents=True)
            (external_skill / "SKILL.md").write_text(
                "---\nname: unrelated-skill\ndescription: test\n---\n",
                encoding="utf-8",
            )
            (external_skill / "scripts" / "save_diandian_summary.py").write_text(
                "def save_record(destination, title, summary_text, note_id):\n    return None\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "xhs-diandian-summarize-note"):
                BRIDGE.validate_diandian_skill_path(external_skill)

    def test_diandian_saver_loader_returns_callable_export(self):
        with tempfile.TemporaryDirectory() as directory:
            saver = Path(directory) / "save_diandian_summary.py"
            saver.write_text(
                "def save_record(destination, title, summary_text, note_id):\n"
                "    return {'destination': destination, 'title': title, 'summary': summary_text, 'note_id': note_id}\n",
                encoding="utf-8",
            )

            save_record = BRIDGE.load_diandian_save_record(saver)

            self.assertTrue(callable(save_record))
            self.assertEqual(
                save_record("path", "title", "summary", "note"),
                {"destination": "path", "title": "title", "summary": "summary", "note_id": "note"},
            )

    def test_diandian_saver_loader_rejects_missing_export(self):
        with tempfile.TemporaryDirectory() as directory:
            saver = Path(directory) / "save_diandian_summary.py"
            saver.write_text("VALUE = 1\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "callable save_record"):
                BRIDGE.load_diandian_save_record(saver)

    def test_diandian_saver_loader_rejects_non_callable_export(self):
        with tempfile.TemporaryDirectory() as directory:
            saver = Path(directory) / "save_diandian_summary.py"
            saver.write_text("save_record = 'not callable'\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "callable save_record"):
                BRIDGE.load_diandian_save_record(saver)

    def test_diandian_saver_loader_rejects_incompatible_api_signature(self):
        with tempfile.TemporaryDirectory() as directory:
            saver = Path(directory) / "save_diandian_summary.py"
            saver.write_text("def save_record(value):\n    return value\n", encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "API 1"):
                BRIDGE.load_diandian_save_record(saver)

    def test_diandian_saver_loader_does_not_write_bytecode_into_skill_release(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts = Path(directory) / "scripts"
            scripts.mkdir()
            saver = scripts / "save_diandian_summary.py"
            saver.write_text(
                "def save_record(destination, title, summary_text, note_id):\n    return None\n",
                encoding="utf-8",
            )

            BRIDGE.load_diandian_save_record(saver)

            self.assertFalse((scripts / "__pycache__").exists())

    def test_diandian_plan_is_note_scoped_and_reschedules_legacy_summaries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            existing_id = "a" * 24
            pending_id = "b" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.diandian_enabled = True
            bridge.diandian_cdp_enabled = True
            bridge.diandian_dir = root / ".xhs-favorites" / "diandian-summaries"
            bridge.diandian_dir.mkdir(parents=True)
            bridge.summary_plans = {}
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "出海电商"}
            batch = "manual20260812010101"
            run_id = bridge.manual_run_id(batch, "board")
            BRIDGE.atomic_json(bridge.manual_sync_path, {"batch": batch, "state": "running"})
            BRIDGE.atomic_json(bridge.diandian_dir / f"{existing_id}.json", {
                "version": 1,
                "provider": "xiaohongshu-diandian",
                "prompt": "总结",
                "selectors": {"input_controls": ["textarea"], "selected_note_card": ".card", "assistant_message": ".message", "finished_message_class": "finished"},
                "note_id": existing_id,
                "title": "已完成",
                "summary": "已有完整总结",
            })

            plan = bridge.diandian_summary_plan({
                "run_id": run_id,
                "board_id": "board",
                "note_ids": [existing_id, pending_id],
            })

            self.assertTrue(plan["enabled"])
            self.assertEqual(plan["note_ids"], [existing_id, pending_id])
            self.assertEqual(bridge.summary_plans[run_id], {existing_id, pending_id})
            self.assertEqual(
                json.loads((bridge.diandian_dir / f"{existing_id}.json").read_text(encoding="utf-8"))["version"],
                1,
            )

    def test_diandian_plan_reschedules_records_rejected_by_the_builders(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            missing_version_id = "v" * 24
            sensitive_id = "s" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.diandian_enabled = True
            bridge.diandian_dir = root / ".xhs-favorites" / "diandian-summaries"
            bridge.diandian_dir.mkdir(parents=True)
            bridge.summary_plans = {}
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "出海电商"}
            batch = "manual20260812010101"
            run_id = bridge.manual_run_id(batch, "board")
            BRIDGE.atomic_json(bridge.manual_sync_path, {"batch": batch, "state": "running"})
            BRIDGE.atomic_json(bridge.diandian_dir / f"{missing_version_id}.json", {
                "provider": "xiaohongshu-diandian",
                "prompt": "总结",
                "selectors": {"input_controls": ["textarea"], "selected_note_card": ".card", "assistant_message": ".message", "finished_message_class": "finished"},
                "note_id": missing_version_id,
                "title": "缺少版本",
                "summary": "这条记录缺少消费者要求的版本字段。",
            })
            BRIDGE.atomic_json(bridge.diandian_dir / f"{sensitive_id}.json", {
                "version": 1,
                "provider": "xiaohongshu-diandian",
                "prompt": "总结",
                "note_id": sensitive_id,
                "title": "包含凭据",
                "summary": "Authorization: Bearer abcdefghijklmnop",
            })

            plan = bridge.diandian_summary_plan({
                "run_id": run_id,
                "board_id": "board",
                "note_ids": [missing_version_id, sensitive_id],
            })

            self.assertEqual(plan["note_ids"], [missing_version_id, sensitive_id])

    def test_diandian_plan_rejects_boolean_versions_and_bom_records(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            boolean_version_id = "b" * 24
            bom_id = "m" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.diandian_enabled = True
            bridge.diandian_dir = root / ".xhs-favorites" / "diandian-summaries"
            bridge.diandian_dir.mkdir(parents=True)
            bridge.summary_plans = {}
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "出海电商"}
            BRIDGE.atomic_json(bridge.manual_sync_path, {"batch": "manual", "state": "running"})
            record = {
                "version": 1,
                "provider": "xiaohongshu-diandian",
                "prompt": "总结",
                "note_id": boolean_version_id,
                "title": "Example",
                "summary": "A complete safe summary.",
            }
            BRIDGE.atomic_json(
                bridge.diandian_dir / f"{boolean_version_id}.json",
                {**record, "version": True},
            )
            (bridge.diandian_dir / f"{bom_id}.json").write_text(
                "\ufeff" + json.dumps({**record, "note_id": bom_id}),
                encoding="utf-8",
            )

            plan = bridge.diandian_summary_plan({
                "run_id": "manual_board",
                "board_id": "board",
                "note_ids": [boolean_version_id, bom_id],
            })

            self.assertEqual(plan["note_ids"], [boolean_version_id, bom_id])

    def test_diandian_sensitive_scan_rejects_six_layers_of_encoding(self):
        encoded = "https://www.xiaohongshu.com/board/private"
        for _ in range(6):
            encoded = quote(encoded, safe="")

        self.assertTrue(BRIDGE.contains_diandian_credential_shape(encoded))

    def test_invalid_post_core_plan_stays_recoverable_until_empty_abandon(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.diandian_enabled = True
            bridge.diandian_dir = root / ".xhs-favorites" / "diandian-summaries"
            bridge.summary_plans = {}
            bridge.state_dir = root
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "出海电商"}
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "summary_plan_pending": True,
                "processed_boards": 1,
            })
            BRIDGE.atomic_json(root / "runs" / "manual_board.json", {
                "run_id": "manual_board",
                "state": "completed",
                "completed_at": "2026-08-12T01:02:03+00:00",
                "next_board_id": None,
            })

            with self.assertRaisesRegex(ValueError, "note_ids"):
                bridge.diandian_summary_plan({
                    "run_id": "manual_board",
                    "board_id": "board",
                    "note_ids": ["../outside"],
                })

            status = bridge.manual_sync_status()
            self.assertEqual(status["state"], "running")
            self.assertTrue(status["summary_plan_pending"])
            self.assertEqual(bridge.summary_plans, {})

            abandoned = bridge.diandian_summary_plan({
                "run_id": "manual_board",
                "board_id": "board",
                "note_ids": [],
            })
            completed = bridge.manual_sync_status()
            duplicate = bridge.diandian_summary_plan({
                "run_id": "manual_board",
                "board_id": "board",
                "note_ids": [],
            })
            delayed_nonempty = bridge.diandian_summary_plan({
                "run_id": "manual_board",
                "board_id": "board",
                "note_ids": ["a" * 24],
            })

            self.assertEqual(abandoned, {
                "enabled": False,
                "note_ids": [],
                "abandoned": True,
            })
            self.assertEqual(duplicate, abandoned)
            self.assertEqual(delayed_nonempty, abandoned)
            self.assertNotIn("manual_board", bridge.summary_plans)
            self.assertEqual(completed["state"], "completed")
            self.assertFalse(completed["summary_plan_pending"])
            self.assertEqual(completed["completed_at"], "2026-08-12T01:02:03+00:00")
            self.assertEqual(bridge.manual_sync_status()["completed_at"], completed["completed_at"])

    def test_empty_summary_plan_restores_the_core_next_board_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.diandian_enabled = True
            bridge.diandian_dir = root / ".xhs-favorites" / "diandian-summaries"
            bridge.summary_plans = {}
            bridge.state_dir = root
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "First", "next": "Next"}
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "current_board": "First：等待点点计划",
                "summary_plan_pending": True,
                "processed_run_ids": ["manual_board"],
            })
            BRIDGE.atomic_json(root / "runs" / "manual_board.json", {
                "run_id": "manual_board",
                "state": "completed",
                "next_board_id": "next",
            })

            bridge.diandian_summary_plan({
                "run_id": "manual_board",
                "board_id": "board",
                "note_ids": [],
            })

            status = bridge.manual_sync_status()
            self.assertEqual(status["state"], "running")
            self.assertEqual(status["current_board"], "Next")
            self.assertFalse(status["summary_plan_pending"])

    def test_diandian_skip_records_one_unresolved_note_and_keeps_the_core_run_alive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first_id = "f" * 24
            second_id = "g" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.summary_plans = {"manual_board": {first_id, second_id}}
            bridge.boards = {"board": "出海电商"}
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "summarized": 0,
                "summary_failed": 0,
                "summary_pending": 2,
            })

            result = bridge.skip_diandian_result({
                "run_id": "manual_board",
                "board_id": "board",
                "note_id": first_id,
                "reason": "attachment-not-supported",
            })

            self.assertEqual(result, {
                "skipped": True,
                "plan_complete": False,
                "finalization_started": False,
            })
            self.assertEqual(bridge.summary_plans["manual_board"], {second_id})
            status = bridge.manual_sync_status()
            self.assertEqual(status["state"], "running")
            self.assertEqual(status["summary_failed"], 1)
            self.assertEqual(status["summary_pending"], 1)
            report = json.loads(bridge.diandian_report_path.read_text(encoding="utf-8"))
            self.assertEqual(report["succeeded_note_ids"], [])
            self.assertEqual(report["unresolved"], [{
                "note_id": first_id,
                "status": "unresolved",
                "reason": "attachment-not-supported",
            }])
            serialized = json.dumps(report, ensure_ascii=False).lower()
            self.assertNotIn("board", serialized)
            self.assertNotIn("manual_board", serialized)
            self.assertNotIn("http", serialized)
            self.assertNotIn("token", serialized)

            duplicate = bridge.skip_diandian_result({
                "run_id": "manual_board",
                "board_id": "board",
                "note_id": first_id,
                "reason": "attachment-not-supported",
            })
            self.assertEqual(duplicate, {
                "skipped": True,
                "plan_complete": False,
                "finalization_started": False,
            })
            duplicate_status = bridge.manual_sync_status()
            self.assertEqual(duplicate_status["summary_failed"], 1)
            self.assertEqual(duplicate_status["summary_pending"], 1)

    def test_diandian_safety_halt_is_durable_idempotent_and_does_not_finalize(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first_id = "h" * 24
            second_id = "j" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.summary_plans = {"manual_board": {first_id, second_id}}
            bridge.boards = {"board": "出海电商"}
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "summary_failed": 0,
                "summary_pending": 2,
            })
            payload = {
                "run_id": "manual_board",
                "board_id": "board",
                "reason": "xhs-safety-stop",
            }

            first = bridge.halt_diandian_run(payload)
            duplicate = bridge.halt_diandian_run(payload)

            self.assertEqual(first, {
                "halted": True,
                "reason": "xhs-safety-stop",
                "plan_complete": True,
                "finalization_started": False,
            })
            self.assertEqual(duplicate, first)
            status = bridge.manual_sync_status()
            self.assertEqual(status["state"], "safety-stopped")
            self.assertIs(status["core_completed"], True)
            self.assertEqual(status["summary_failed"], 2)
            self.assertEqual(status["summary_pending"], 0)
            self.assertFalse(status["summary_finalizing"])
            self.assertNotIn("manual_board", bridge.summary_plans)
            report = json.loads(bridge.diandian_report_path.read_text(encoding="utf-8"))
            self.assertEqual(
                {entry["note_id"] for entry in report["unresolved"]},
                {first_id, second_id},
            )
            self.assertEqual(
                {entry["reason"] for entry in report["unresolved"]},
                {"safety-halt"},
            )

            generic_duplicate = bridge.halt_diandian_run({
                "run_id": "manual_board",
                "board_id": "board",
                "reason": "diandian-cdp-failed",
            })
            self.assertTrue(generic_duplicate["halted"])
            self.assertEqual(generic_duplicate["reason"], "xhs-safety-stop")
            after_generic = bridge.manual_sync_status()
            self.assertEqual(after_generic["state"], "safety-stopped")
            self.assertEqual(after_generic["summary_failed"], 2)
            report = json.loads(bridge.diandian_report_path.read_text(encoding="utf-8"))
            self.assertEqual(
                {entry["reason"] for entry in report["unresolved"]},
                {"safety-halt"},
            )

    def test_diandian_report_round_trips_success_and_unresolved_ids_into_run_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            succeeded_id = "s" * 24
            unresolved_id = "u" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"

            bridge.record_diandian_succeeded(succeeded_id)
            bridge.record_diandian_unresolved(unresolved_id, "attachment-not-supported")

            report = json.loads(bridge.diandian_report_path.read_text(encoding="utf-8"))
            self.assertEqual(report["succeeded_note_ids"], [succeeded_id])
            self.assertEqual(report["unresolved"], [{
                "note_id": unresolved_id,
                "status": "unresolved",
                "reason": "attachment-not-supported",
            }])
            serialized = json.dumps(report, ensure_ascii=False).lower()
            for forbidden in ("board_id", "run_id", "http", "token"):
                self.assertNotIn(forbidden, serialized)

            catalog_path = root / "catalog.json"
            curation_path = root / "curation.json"
            baseline_path = root / "baseline.json"
            baseline_output = root / "published-baseline.json"
            scope_output = root / "scope.json"
            BRIDGE.atomic_json(catalog_path, {
                "notes": {succeeded_id: {}, unresolved_id: {}},
            })
            BRIDGE.atomic_json(curation_path, {})
            BRIDGE.atomic_json(baseline_path, {
                "note_ids": [succeeded_id, unresolved_id],
            })
            scope_script = MODULE_PATH.with_name("prepare-curation-scope.mjs")

            result = subprocess.run(
                [
                    "node", str(scope_script),
                    "--catalog", str(catalog_path),
                    "--curation", str(curation_path),
                    "--baseline-knowledge", str(baseline_path),
                    "--baseline-output", str(baseline_output),
                    "--scope-output", str(scope_output),
                    "--include-run-report", str(bridge.diandian_report_path),
                    "--run-only", "true",
                ],
                capture_output=True,
                text=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            scope = json.loads(scope_output.read_text(encoding="utf-8"))
            self.assertEqual(
                set(scope["note_ids"]),
                {succeeded_id, unresolved_id},
            )

    def test_diandian_result_acknowledges_fast_is_idempotent_and_finalizes_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "i" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.processing_lock = threading.Lock()
            bridge.summary_plans = {"manual_board": {note_id}}
            bridge.boards = {"board": "出海电商"}
            bridge.board_order = ["board"]
            configure_point_v2(bridge, root, [note_id])
            bridge.diandian_save_record = lambda destination, title, summary_text, current_id: BRIDGE.atomic_json(destination, {
                "version": 1,
                "provider": "xiaohongshu-diandian",
                "prompt": "总结",
                "note_id": current_id,
                "title": title,
                "summary": summary_text,
                "request_sha256": BRIDGE.diandian_result_digest(title, summary_text),
            })
            run_path = bridge.state_dir / "runs" / "manual_board.json"
            BRIDGE.atomic_json(run_path, {
                "run_id": "manual_board",
                "state": "completed",
                "scanned": 1,
                "new": 1,
                "next_board_id": None,
            })
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "summarized": 0,
                "summary_failed": 0,
                "summary_pending": 1,
                "processed_run_ids": ["manual_board"],
                "processed_boards": 1,
                "scanned": 1,
                "new": 1,
            })
            rebuild_started = threading.Event()
            allow_rebuild = threading.Event()

            def rebuild():
                rebuild_started.set()
                self.assertTrue(allow_rebuild.wait(timeout=2))

            bridge.rebuild_knowledge_base = mock.Mock(side_effect=rebuild)
            bridge.publish_after_board = mock.Mock(return_value={"ok": True, "status": "published"})
            bridge.write_status = mock.Mock()
            payload = {
                "run_id": "manual_board",
                "board_id": "board",
                "note_id": note_id,
                "title": "示例笔记",
                "summary": "这是用于验证快速确认、幂等重放和后台完成的完整点点总结正文。",
            }

            first = bridge.save_diandian_result(payload)

            self.assertEqual(first, {
                "saved": True,
                "plan_complete": True,
                "finalization_started": True,
            })
            self.assertTrue(rebuild_started.wait(timeout=1))
            self.assertTrue(bridge.manual_sync_status()["summary_finalizing"])
            duplicate = bridge.save_diandian_result(payload)
            self.assertEqual(duplicate["saved"], True)
            self.assertEqual(duplicate["plan_complete"], True)

            allow_rebuild.set()
            bridge.summary_finalization_threads["manual_board"].join(timeout=2)

            self.assertFalse(bridge.manual_sync_status()["summary_finalizing"])
            self.assertEqual(bridge.manual_sync_status()["state"], "completed")
            self.assertEqual(bridge.rebuild_knowledge_base.call_count, 1)
            self.assertEqual(bridge.publish_after_board.call_count, 1)

    def test_saved_summary_requires_current_content_and_prompt_revisions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "v" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.diandian_dir = root / "diandian-summaries"
            bridge.diandian_dir.mkdir()
            bridge.catalog_path = root / "catalog.json"
            bridge.diandian_release = {"version": "1.2.0"}
            bridge.diandian_browser_contract = {"enabled": True, "version": 1}
            BRIDGE.atomic_json(bridge.catalog_path, {"notes": {note_id: {"content_sha256": "a" * 64}}})
            summary = "这是一个只包含合成文字并用于验证修订绑定的点点总结。"
            BRIDGE.atomic_json(bridge.diandian_dir / f"{note_id}.json", {
                "version": 2,
                "provider": "xiaohongshu-diandian",
                "prompt": "总结",
                "prompt_version": BRIDGE.diandian_prompt_version(bridge.diandian_release, bridge.diandian_browser_contract),
                "note_id": note_id,
                "title": "合成标题",
                "summary": summary,
                "content_sha256": "b" * 64,
                "request_sha256": "c" * 64,
                "summary_sha256": BRIDGE.hashlib.sha256(summary.encode("utf-8")).hexdigest(),
                "captured_at": "2026-08-23T00:00:00+00:00",
            })
            self.assertIsNone(bridge.saved_diandian_record(note_id))

    def test_diandian_result_uses_private_keyed_store_without_urls(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "c" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.diandian_enabled = True
            bridge.diandian_dir = root / ".xhs-favorites" / "diandian-summaries"
            bridge.summary_plans = {"manual_board": {note_id}}
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "出海电商"}
            configure_point_v2(bridge, root, [note_id])
            bridge.diandian_save_record = lambda destination, title, summary_text, note_id: BRIDGE.atomic_json(destination, {
                "version": 1,
                "provider": "xiaohongshu-diandian",
                "prompt": "总结",
                "note_id": note_id,
                "title": title,
                "summary": summary_text,
                "request_sha256": BRIDGE.diandian_result_digest(title, summary_text),
            })
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "summarized": 0,
            })

            result = bridge.save_diandian_result({
                "run_id": "manual_board",
                "board_id": "board",
                "note_id": note_id,
                "title": "示例笔记",
                "summary": "这是用于验证私有按笔记标识保存的完整点点总结正文。",
            })

            saved = json.loads((bridge.diandian_dir / f"{note_id}.json").read_text(encoding="utf-8"))
            self.assertEqual(result, {
                "saved": True,
                "plan_complete": True,
                "finalization_started": False,
            })
            self.assertEqual(saved["note_id"], note_id)
            self.assertFalse({"source_url", "url", "xsec_token", "cookie"} & set(saved))
            self.assertNotIn("xsec_token=", json.dumps(saved).lower())
            self.assertEqual(bridge.manual_sync_status()["summarized"], 1)
            report = json.loads(
                bridge.summary_report_path().read_text(encoding="utf-8")
            )
            self.assertEqual(report["succeeded_note_ids"], [note_id])
            self.assertEqual(report["unresolved"], [])

    def test_diandian_result_rejects_no_op_external_saver_without_advancing_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "n" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.diandian_enabled = True
            bridge.diandian_dir = root / ".xhs-favorites" / "diandian-summaries"
            bridge.summary_plans = {"manual_board": {note_id}}
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "出海电商"}
            bridge.diandian_save_record = lambda *args: None
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "summarized": 0,
            })

            with self.assertRaisesRegex(RuntimeError, "persist expected record"):
                bridge.save_diandian_result({
                    "run_id": "manual_board",
                    "board_id": "board",
                    "note_id": note_id,
                    "title": "示例笔记",
                    "summary": "这是一段足够长、用于验证外部保存器没有真正写入时不会被错误确认的点点总结正文。",
                })

            self.assertEqual(bridge.summary_plans["manual_board"], {note_id})
            self.assertEqual(bridge.manual_sync_status()["summarized"], 0)
            self.assertFalse((bridge.diandian_dir / f"{note_id}.json").exists())

    def test_diandian_result_accepts_real_saver_footer_cleanup_by_request_digest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "f" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.diandian_enabled = True
            bridge.diandian_dir = root / ".xhs-favorites" / "diandian-summaries"
            bridge.summary_plans = {"manual_board": {note_id}}
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "出海电商"}
            configure_point_v2(bridge, root, [note_id])
            bridge.diandian_save_record = BRIDGE.load_diandian_save_record(
                DIANDIAN_SKILL_SOURCE / "scripts" / "save_diandian_summary.py"
            )
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "summarized": 0,
            })
            raw_summary = (
                "这是一段足够长、用于验证真实保存器清理尾注后仍能获得成功确认的完整点点总结正文。"
                "\n\n如果你还想了解更多，可以继续问我。"
            )

            result = bridge.save_diandian_result({
                "run_id": "manual_board",
                "board_id": "board",
                "note_id": note_id,
                "title": "示例笔记",
                "summary": raw_summary,
            })

            saved = bridge.saved_diandian_record(note_id)
            self.assertTrue(result["saved"])
            self.assertIsNotNone(saved)
            self.assertNotIn("继续问我", saved["summary"])
            self.assertEqual(saved["request_sha256"], BRIDGE.diandian_result_digest("示例笔记", raw_summary))
            self.assertEqual(bridge.manual_sync_status()["summarized"], 1)

    def test_diandian_result_rejects_source_fields_before_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "e" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.diandian_enabled = True
            bridge.diandian_dir = root / ".xhs-favorites" / "diandian-summaries"
            bridge.summary_plans = {"manual_board": {note_id}}
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "出海电商"}
            bridge.diandian_save_record = mock.Mock()
            bridge.saved_diandian_record = mock.Mock()
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual", "state": "running", "summarized": 0,
            })

            with self.assertRaisesRegex(ValueError, "source"):
                bridge.save_diandian_result({
                    "run_id": "manual_board",
                    "board_id": "board",
                    "note_id": note_id,
                    "title": "示例笔记",
                    "summary": "这是一个足够长并且不应在失败后写入磁盘的完整总结正文。",
                    "source_url": "https://www.xiaohongshu.com/explore/example?xsec_token=secret",
                })

            bridge.diandian_save_record.assert_not_called()
            bridge.saved_diandian_record.assert_not_called()

    def test_cdp_summary_uses_a_fresh_target_and_saves_before_close_without_persisting_url(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first_id = "c" * 24
            second_id = "d" * 24
            board_id = "board"
            run_id = "manual_board"
            ai_url = "https://www.xiaohongshu.com/ai_chat"
            urls = {
                first_id: f"https://www.xiaohongshu.com/discovery/item/{first_id}?xsec_token=private-first&xsec_source=pc_share",
                second_id: f"https://www.xiaohongshu.com/discovery/item/{second_id}?xsec_token=private-second&xsec_source=pc_share",
            }
            summaries = {
                first_id: "First stable DianDian summary with enough safe content.",
                second_id: "Second stable DianDian summary with enough safe content.",
            }
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            bridge.diandian_enabled = True
            bridge.diandian_cdp_enabled = True
            bridge.diandian_cdp_spec = {
                "ai_chat_url": ai_url,
                "selectors": {
                    "input_controls": ["textarea"],
                    "selected_note_card": ".card",
                    "assistant_message": ".message",
                    "finished_message_class": "finished",
                },
                "prompt": "总结",
                "minimum_summary_chars": 20,
                "timings_ms": {
                    "response_wait": 300_000,
                    "reply_text_stable": 2_000,
                    "success_dwell": 1_500,
                },
            }
            bridge.diandian_save_record = BRIDGE.load_diandian_save_record(
                DIANDIAN_SKILL_SOURCE / "scripts" / "save_diandian_summary.py"
            )
            configure_point_v2(bridge, root, [first_id, second_id])
            bridge.summary_plans = {run_id: {first_id, second_id}}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.summary_halted = set()
            bridge.diandian_cdp_active = set()
            bridge.diandian_cdp_results = {}
            bridge.diandian_cdp_guard = threading.Lock()
            bridge.diandian_sleep = mock.Mock()
            bridge.diandian_completion_state = lambda current_run, current_board: {
                "plan_complete": not bridge.summary_plans.get(current_run),
                "finalization_started": False,
            }
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "run_board_ids": [board_id],
                "run_mode": "history",
                "local_only": False,
                "summary_pending": 2,
                "summarized": 0,
            })

            targets = []

            class FakeSession:
                def __init__(self):
                    self.finished = ""
                    self.value = ""
                    self.calls = []

                def call(self, method, **params):
                    self.calls.append((method, params))
                    if method == "Input.insertText":
                        self.value += params["text"]
                    return {}

                def evaluate(self, expression):
                    return json.dumps({
                        "href": ai_url,
                        "body": "DianDian chat is ready",
                        "ready": "complete",
                        "input_ready": True,
                        "msgs": 1 if self.finished else 0,
                        "fin": 1 if self.finished else 0,
                        "cards": 0,
                        "val": self.value,
                        "last": self.finished,
                    })

            class FakeTarget:
                def __init__(self):
                    self.session = FakeSession()
                    self.closed = False

                def close(self):
                    expected = first_id if len(targets) == 1 else second_id
                    self.assert_saved = bridge.saved_diandian_record(expected)
                    self.closed = True

            def open_target(initial_url):
                self.assertEqual(initial_url, "about:blank")
                target = FakeTarget()
                targets.append(target)
                return target

            def ask(session, note_url, *, spec, tries, sleep):
                note_id = BRIDGE.note_id_from_url(note_url)
                self.assertEqual(urlparse(note_url).query, "")
                self.assertIs(spec, bridge.diandian_cdp_spec)
                self.assertEqual(tries, 100)
                self.assertIs(sleep, bridge.diandian_sleep)
                session.call("Input.insertText", text=note_url)
                session.call("Input.insertText", text=" 总结")
                session.call("Input.dispatchKeyEvent", type="keyDown", key="Enter")
                session.call("Input.dispatchKeyEvent", type="keyUp", key="Enter")
                session._session.finished = summaries[note_id]
                return session._session.finished

            bridge.open_cdp_target = open_target
            bridge.diandian_cdp_ask = mock.Mock(side_effect=ask)

            for note_id in (first_id, second_id):
                result = bridge.run_diandian_cdp({
                    "run_id": run_id,
                    "board_id": board_id,
                    "note_id": note_id,
                    "title": f"Title {note_id[-1]}",
                    "url": urls[note_id],
                })
                self.assertTrue(result["saved"], result)

            self.assertEqual(len(targets), 2)
            self.assertTrue(all(target.closed and target.assert_saved for target in targets))
            self.assertTrue(all(target.session.calls[0] == ("Page.navigate", {"url": ai_url}) for target in targets))
            self.assertFalse(any(
                "cookie" in method.casefold() or method.startswith("Storage.")
                for target in targets for method, _ in target.session.calls
            ))
            private_bytes = b"\n".join(
                path.read_bytes() for path in root.rglob("*") if path.is_file()
            )
            for value in urls.values():
                self.assertNotIn(value.encode("utf-8"), private_bytes)

    def test_cdp_failure_keeps_the_target_and_old_summary_then_halts_remaining_notes_idempotently(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            current_id = "e" * 24
            remaining_id = "f" * 24
            board_id = "board"
            run_id = "manual_board"
            ai_url = "https://www.xiaohongshu.com/ai_chat"
            old_record = {
                "version": 1,
                "provider": "xiaohongshu-diandian",
                "prompt": "总结",
                "note_id": current_id,
                "title": "Old title",
                "summary": "Old summary remains valid after transport failure.",
            }
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            bridge.diandian_enabled = True
            bridge.diandian_cdp_enabled = True
            bridge.diandian_cdp_spec = {
                "ai_chat_url": ai_url,
                "selectors": {
                    "input_controls": ["textarea"],
                    "selected_note_card": ".card",
                    "assistant_message": ".message",
                    "finished_message_class": "finished",
                },
                "prompt": "总结",
                "minimum_summary_chars": 20,
                "timings_ms": {"response_wait": 300_000, "reply_text_stable": 2_000, "success_dwell": 1_500},
            }
            bridge.summary_plans = {run_id: {current_id, remaining_id}}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.summary_halted = set()
            bridge.diandian_cdp_active = set()
            bridge.diandian_cdp_results = {}
            bridge.diandian_cdp_guard = threading.Lock()
            bridge.diandian_sleep = mock.Mock()
            BRIDGE.atomic_json(bridge.diandian_dir / f"{current_id}.json", old_record)
            old_bytes = (bridge.diandian_dir / f"{current_id}.json").read_bytes()
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual", "state": "running", "run_board_ids": [board_id],
                "summary_pending": 2, "summary_failed": 0,
            })
            BRIDGE.atomic_json(bridge.state_dir / "runs" / f"{run_id}.json", {
                "run_id": run_id,
                "state": "completed",
                "next_board_id": None,
            })

            session = SimpleNamespace(
                call=mock.Mock(return_value={}),
                evaluate=mock.Mock(return_value=json.dumps({
                    "href": ai_url, "body": "DianDian chat is ready", "ready": "complete",
                    "input_ready": True, "msgs": 0, "fin": 0, "last": "",
                })),
            )
            target = SimpleNamespace(session=session, close=mock.Mock())
            bridge.open_cdp_target = mock.Mock(return_value=target)
            bridge.diandian_cdp_ask = mock.Mock(side_effect=TimeoutError("private URL must never escape"))
            payload = {
                "run_id": run_id,
                "board_id": board_id,
                "note_id": current_id,
                "title": "New title",
                "url": f"https://www.xiaohongshu.com/discovery/item/{current_id}?xsec_token=private-token",
            }

            first = bridge.run_diandian_cdp(payload)
            duplicate = bridge.run_diandian_cdp(payload)

            self.assertEqual(first, duplicate)
            self.assertEqual(first, {"saved": False, "halted": True, "reason": "transport-failed"})
            bridge.open_cdp_target.assert_called_once_with("about:blank")
            bridge.diandian_cdp_ask.assert_called_once()
            target.close.assert_not_called()
            self.assertEqual((bridge.diandian_dir / f"{current_id}.json").read_bytes(), old_bytes)
            self.assertNotIn(run_id, bridge.summary_plans)
            status = bridge.manual_sync_status()
            self.assertEqual(status["state"], "failed")
            self.assertIs(status["core_completed"], True)
            self.assertEqual(status["summary_halt_reason"], "transport-failed")
            self.assertIn("点点 AI", status["error"])
            self.assertIn("核心整理结果已保留", status["error"])
            report = json.loads(bridge.diandian_report_path.read_text(encoding="utf-8"))
            self.assertEqual({entry["note_id"] for entry in report["unresolved"]}, {current_id, remaining_id})

    def test_userscript_halt_endpoint_preserves_a_strict_non_safety_reason(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "z" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.diandian_report_path = root / "diandian-rerun-report.json"
            bridge.boards = {"board": "Board"}
            bridge.summary_plans = {"manual_board": {note_id}}
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "run_board_ids": ["board"],
                "summary_pending": 1,
                "summary_failed": 0,
            })

            result = bridge.halt_diandian_run({
                "run_id": "manual_board",
                "board_id": "board",
                "reason": "share-link-unavailable",
            })
            status = bridge.manual_sync_status()

            self.assertEqual(result["reason"], "share-link-unavailable")
            self.assertEqual(status["state"], "failed")
            self.assertIs(status["core_completed"], True)
            self.assertEqual(status["summary_halt_reason"], "share-link-unavailable")
            self.assertIn("分享链接", status["error"])
            self.assertIn("核心整理结果已保留", status["error"])
            report = json.loads(bridge.diandian_report_path.read_text(encoding="utf-8"))
            self.assertEqual(report["unresolved"], [{
                "note_id": note_id,
                "status": "unresolved",
                "reason": "share-link-unavailable",
            }])

            with self.assertRaisesRegex(ValueError, "halt reason"):
                bridge.halt_diandian_run({
                    "run_id": "manual_board",
                    "board_id": "board",
                    "reason": "arbitrary-client-value",
                })
            self.assertEqual(
                BRIDGE.normalize_diandian_halt_reason("diandian-cdp-failed"),
                "transport-failed",
            )

    def test_cdp_external_exceptions_are_durably_halted_without_closing_the_target(self):
        class ConnectionClosedLikeError(Exception):
            pass

        for external_error, stage in (
            (LookupError("composer unavailable"), "ask"),
            (ConnectionClosedLikeError("target disconnected"), "ask"),
            (ConnectionClosedLikeError("target disconnected during preflight"), "preflight"),
        ):
            with self.subTest(error=type(external_error).__name__, stage=stage), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                note_id = "j" * 24
                board_id = "board"
                run_id = "manual_board"
                ai_url = "https://www.xiaohongshu.com/ai_chat"
                bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
                bridge.state_dir = root / ".xhs-favorites"
                bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
                bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
                bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
                bridge.boards = {board_id: "Board"}
                bridge.board_order = [board_id]
                bridge.diandian_enabled = True
                bridge.diandian_cdp_enabled = True
                bridge.diandian_cdp_spec = {
                    "ai_chat_url": ai_url,
                    "selectors": {
                        "input_controls": ["textarea"],
                        "selected_note_card": ".card",
                        "assistant_message": ".message",
                        "finished_message_class": "finished",
                    },
                    "prompt": "总结",
                    "minimum_summary_chars": 20,
                    "timings_ms": {
                        "page_dom_stable": 0,
                        "response_wait": 300_000,
                        "reply_text_stable": 0,
                        "success_dwell": 0,
                    },
                }
                bridge.summary_plans = {run_id: {note_id}}
                bridge.summary_locks = {}
                bridge.summary_locks_guard = threading.Lock()
                bridge.summary_halted = set()
                bridge.diandian_cdp_active = set()
                bridge.diandian_cdp_results = {}
                bridge.diandian_cdp_guard = threading.Lock()
                bridge.diandian_sleep = mock.Mock()
                BRIDGE.atomic_json(bridge.manual_sync_path, {
                    "batch": "manual",
                    "state": "running",
                    "run_board_ids": [board_id],
                    "summary_pending": 1,
                    "summary_failed": 0,
                })
                session = SimpleNamespace(
                    call=mock.Mock(return_value={}),
                    evaluate=mock.Mock(return_value=json.dumps({
                        "href": ai_url,
                        "body": "DianDian chat is ready",
                        "ready": "complete",
                        "input_ready": True,
                        "cards": 0,
                        "msgs": 0,
                        "fin": 0,
                        "val": "",
                        "last": "",
                    })),
                )
                target = SimpleNamespace(session=session, close=mock.Mock())
                bridge.open_cdp_target = mock.Mock(return_value=target)
                bridge.diandian_cdp_ask = mock.Mock(side_effect=external_error)
                if stage == "preflight":
                    session.evaluate.side_effect = external_error

                result = bridge.run_diandian_cdp({
                    "run_id": run_id,
                    "board_id": board_id,
                    "note_id": note_id,
                    "title": "Title",
                    "url": f"https://www.xiaohongshu.com/discovery/item/{note_id}?xsec_token=private-token",
                })

                self.assertEqual(
                    result,
                    {"saved": False, "halted": True, "reason": "transport-failed"},
                )
                target.close.assert_not_called()
                if stage == "preflight":
                    bridge.diandian_cdp_ask.assert_not_called()
                self.assertNotIn(run_id, bridge.summary_plans)
                self.assertEqual(bridge.manual_sync_status()["state"], "failed")

    def test_cdp_waits_within_input_wait_for_a_visible_spa_composer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "q" * 24
            board_id = "board"
            run_id = "manual_board"
            ai_url = "https://www.xiaohongshu.com/ai_chat"
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            bridge.diandian_enabled = True
            bridge.diandian_cdp_enabled = True
            bridge.diandian_cdp_spec = {
                "ai_chat_url": ai_url,
                "selectors": {
                    "input_controls": ["textarea"],
                    "selected_note_card": ".card",
                    "assistant_message": ".message",
                    "finished_message_class": "finished",
                },
                "prompt": "总结",
                "minimum_summary_chars": 20,
                "timings_ms": {
                    "input_wait": 2_000,
                    "page_dom_stable": 0,
                    "response_wait": 3_000,
                    "reply_text_stable": 0,
                    "success_dwell": 0,
                },
            }
            bridge.summary_plans = {run_id: {note_id}}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.summary_halted = set()
            bridge.diandian_cdp_active = set()
            bridge.diandian_cdp_results = {}
            bridge.diandian_cdp_guard = threading.Lock()
            sleeps = []
            bridge.diandian_sleep = sleeps.append
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "run_board_ids": [board_id],
                "summary_pending": 1,
            })

            class DelayedComposerSession:
                def __init__(self):
                    self.evaluations = 0

                def call(self, method, **params):
                    return {}

                def evaluate(self, expression):
                    self.evaluations += 1
                    return json.dumps({
                        "href": ai_url,
                        "body": "DianDian chat is ready",
                        "ready": "complete",
                        "input_ready": self.evaluations >= 2,
                        "cards": 0,
                        "msgs": 0,
                        "fin": 0,
                        "val": "",
                        "last": "",
                    })

            session = DelayedComposerSession()
            target = SimpleNamespace(session=session, close=mock.Mock())
            bridge.open_cdp_target = mock.Mock(return_value=target)
            bridge.diandian_cdp_ask = mock.Mock(side_effect=LookupError("stop after readiness proof"))

            result = bridge.run_diandian_cdp({
                "run_id": run_id,
                "board_id": board_id,
                "note_id": note_id,
                "title": "Title",
                "url": f"https://www.xiaohongshu.com/discovery/item/{note_id}?xsec_token=private-token",
            })

            self.assertEqual(result["reason"], "transport-failed")
            bridge.diandian_cdp_ask.assert_called_once()
            self.assertGreaterEqual(session.evaluations, 3)
            self.assertEqual(sleeps[:2], [0.5, 0.0])
            target.close.assert_not_called()

    def test_cdp_waits_for_a_transient_card_and_retained_link_to_settle(self):
        note_url = "https://www.xiaohongshu.com/discovery/item/" + "x" * 24
        ai_url = "https://www.xiaohongshu.com/ai_chat"

        class TransitionSession:
            def __init__(self):
                self.states = [
                    {"cards": 1, "val": note_url},
                    {"cards": 1, "val": note_url},
                    {"cards": 1, "val": ""},
                    {"cards": 1, "val": ""},
                ]
                self.calls = []

            def call(self, method, **params):
                self.calls.append((method, params))
                return {}

            def evaluate(self, expression):
                state = self.states.pop(0) if self.states else {"cards": 1, "val": ""}
                return json.dumps({
                    "href": ai_url,
                    "body": "DianDian chat is ready",
                    "ready": "complete",
                    "input_ready": True,
                    "cards": state["cards"],
                    "msgs": 0,
                    "fin": 0,
                    "val": state["val"],
                    "last": "",
                })

        session = TransitionSession()

        class FakeClock:
            now = 0.0

            def monotonic(self):
                return self.now

            def sleep(self, seconds):
                sleeps.append(seconds)
                self.now += seconds

        clock = FakeClock()
        sleeps = []
        guarded = BRIDGE.GuardedDiandianSession(
            session,
            note_url,
            "总结",
            ai_url,
            "state-expression",
            lambda: False,
            context_wait_seconds=3,
            context_stable_seconds=2,
            context_sleep=clock.sleep,
            context_clock=clock.monotonic,
        )
        guarded._insert_count = 1

        guarded.call("Input.insertText", text=" 总结")

        self.assertEqual(session.calls, [("Input.insertText", {"text": " 总结"})])
        self.assertEqual(sleeps, [0.5, 2])

    def test_delayed_summary_plan_cannot_mutate_a_replacement_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "Board"}
            bridge.board_order = ["board"]
            bridge.summary_plans = {}
            bridge.diandian_enabled = True
            bridge.saved_diandian_record = mock.Mock(return_value=None)
            bridge.record_diandian_succeeded_batch = mock.Mock()
            old_batch = "manualold"
            old_run_id = bridge.manual_run_id(old_batch, "board")
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": old_batch,
                "state": "running",
                "run_board_ids": ["board"],
                "summary_plan_pending": True,
            })
            replacement = {
                "batch": "manualnew",
                "state": "starting",
                "run_board_ids": ["board"],
                "summary_plan_pending": True,
                "sentinel": "replacement-must-remain-byte-identical",
            }

            class SwapBatchOnEnter:
                def __enter__(self):
                    BRIDGE.atomic_json(bridge.manual_sync_path, replacement)
                    return self

                def __exit__(self, *_args):
                    return False

            bridge.summary_run_lock = mock.Mock(return_value=SwapBatchOnEnter())

            with self.assertRaisesRegex(ValueError, "batch"):
                bridge.diandian_summary_plan({
                    "run_id": old_run_id,
                    "board_id": "board",
                    "note_ids": ["z" * 24],
                })

            self.assertEqual(bridge.read_manual_sync(), replacement)
            self.assertEqual(bridge.summary_plans, {})
            bridge.saved_diandian_record.assert_not_called()
            bridge.record_diandian_succeeded_batch.assert_not_called()

    def test_cdp_context_wait_deadline_includes_repeated_stability_windows(self):
        note_url = "https://www.xiaohongshu.com/discovery/item/" + "y" * 24
        ai_url = "https://www.xiaohongshu.com/ai_chat"

        class FakeClock:
            now = 0.0

            def monotonic(self):
                return self.now

            def sleep(self, seconds):
                self.now += seconds

        class FlickeringSession:
            def __init__(self):
                self.evaluations = 0
                self.calls = []

            def call(self, method, **params):
                self.calls.append((method, params))
                return {}

            def evaluate(self, expression):
                self.evaluations += 1
                terminal = self.evaluations % 2 == 1
                return json.dumps({
                    "href": ai_url,
                    "body": "DianDian chat is ready",
                    "ready": "complete",
                    "input_ready": True,
                    "cards": 0 if terminal else 1,
                    "msgs": 0,
                    "fin": 0,
                    "val": note_url,
                    "last": "",
                })

        clock = FakeClock()
        session = FlickeringSession()
        guarded = BRIDGE.GuardedDiandianSession(
            session,
            note_url,
            "总结",
            ai_url,
            "state-expression",
            lambda: False,
            context_wait_seconds=3,
            context_stable_seconds=2,
            context_sleep=clock.sleep,
            context_clock=clock.monotonic,
        )
        guarded._insert_count = 1

        with self.assertRaisesRegex(BRIDGE.DiandianPageStop, "note-context-mismatch"):
            guarded.call("Input.insertText", text=" 总结")

        self.assertLessEqual(clock.now, 3)
        self.assertEqual(session.calls, [])

    def test_cdp_durable_halt_cancels_inflight_transport_before_any_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "k" * 24
            board_id = "board"
            run_id = "manual_board"
            ai_url = "https://www.xiaohongshu.com/ai_chat"
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            bridge.diandian_enabled = True
            bridge.diandian_cdp_enabled = True
            bridge.diandian_cdp_spec = {
                "ai_chat_url": ai_url,
                "selectors": {
                    "input_controls": ["textarea"],
                    "selected_note_card": ".card",
                    "assistant_message": ".message",
                    "finished_message_class": "finished",
                },
                "prompt": "总结",
                "minimum_summary_chars": 20,
                "timings_ms": {
                    "page_dom_stable": 0,
                    "response_wait": 300_000,
                    "reply_text_stable": 0,
                    "success_dwell": 0,
                },
            }
            bridge.summary_plans = {run_id: {note_id}}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.summary_halted = set()
            bridge.diandian_cdp_active = set()
            bridge.diandian_cdp_results = {}
            bridge.diandian_cdp_guard = threading.Lock()
            bridge.diandian_sleep = mock.Mock()
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "run_board_ids": [board_id],
                "summary_pending": 1,
                "summary_failed": 0,
            })

            class FakeSession:
                def __init__(self):
                    self.calls = []

                def call(self, method, **params):
                    self.calls.append((method, params))
                    return {}

                def evaluate(self, expression):
                    return json.dumps({
                        "href": ai_url,
                        "body": "DianDian chat is ready",
                        "ready": "complete",
                        "input_ready": True,
                        "cards": 0,
                        "msgs": 0,
                        "fin": 0,
                        "val": "",
                        "last": "",
                    })

            session = FakeSession()
            target = SimpleNamespace(session=session, close=mock.Mock())
            bridge.open_cdp_target = mock.Mock(return_value=target)
            transport_entered = threading.Event()
            transport_released = threading.Event()

            def ask(guarded, note_url, *, spec, tries, sleep):
                transport_entered.set()
                self.assertTrue(transport_released.wait(timeout=2))
                guarded.call("Input.insertText", text=note_url)
                return "This response must never be accepted after a durable halt."

            bridge.diandian_cdp_ask = ask
            result_holder = []
            request = {
                "run_id": run_id,
                "board_id": board_id,
                "note_id": note_id,
                "title": "Title",
                "url": f"https://www.xiaohongshu.com/discovery/item/{note_id}?xsec_token=private-token",
            }
            worker = threading.Thread(
                target=lambda: result_holder.append(bridge.run_diandian_cdp(request)),
                daemon=True,
            )
            worker.start()
            self.assertTrue(transport_entered.wait(timeout=2))

            halted = bridge.halt_diandian_run({
                "run_id": run_id,
                "board_id": board_id,
                "reason": "diandian-cdp-failed",
            })
            transport_released.set()
            worker.join(timeout=2)

            self.assertTrue(halted["halted"])
            self.assertFalse(worker.is_alive())
            self.assertEqual(
                result_holder,
                [{"saved": False, "halted": True, "reason": "run-halted"}],
            )
            self.assertFalse(any(method.startswith("Input.") for method, _ in session.calls))
            target.close.assert_not_called()
            self.assertNotIn(run_id, bridge.summary_plans)
            state = bridge.manual_sync_status()
            self.assertEqual(state["state"], "failed")
            self.assertEqual(state["summary_pending"], 0)

    def test_cdp_halt_empty_snapshot_revokes_a_later_active_registration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "r" * 24
            board_id = "board"
            run_id = "manual_board"
            ai_url = "https://www.xiaohongshu.com/ai_chat"
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            bridge.diandian_enabled = True
            bridge.diandian_cdp_enabled = True
            bridge.diandian_cdp_spec = {
                "ai_chat_url": ai_url,
                "selectors": {
                    "input_controls": ["textarea"],
                    "selected_note_card": ".card",
                    "assistant_message": ".message",
                    "finished_message_class": "finished",
                },
                "prompt": "总结",
                "minimum_summary_chars": 20,
                "timings_ms": {
                    "input_wait": 1_000,
                    "page_dom_stable": 0,
                    "context_wait": 1_000,
                    "note_context_stable": 0,
                    "response_wait": 1_000,
                    "reply_text_stable": 0,
                    "success_dwell": 0,
                    "single_note_wait": 2_000,
                },
            }
            bridge.summary_plans = {run_id: {note_id}}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.summary_halted = set()
            bridge.diandian_cdp_active = set()
            bridge.diandian_cdp_results = {}
            bridge.diandian_cdp_guard = threading.Lock()
            bridge.diandian_sleep = mock.Mock()
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "run_board_ids": [board_id],
                "summary_pending": 1,
                "summary_failed": 0,
            })

            class FakeSession:
                def __init__(self):
                    self.calls = []
                    self.value = ""

                def call(self, method, **params):
                    self.calls.append((method, params))
                    if method == "Input.insertText":
                        self.value += params["text"]
                    return {}

                def evaluate(self, expression):
                    return json.dumps({
                        "href": ai_url,
                        "body": "DianDian chat is ready",
                        "ready": "complete",
                        "input_ready": True,
                        "cards": 0,
                        "msgs": 0,
                        "fin": 0,
                        "val": self.value,
                        "last": "",
                    })

            session = FakeSession()
            target = SimpleNamespace(session=session, close=mock.Mock())
            bridge.open_cdp_target = mock.Mock(return_value=target)
            snapshot_taken = threading.Event()
            release_halt = threading.Event()
            ask_entered = threading.Event()
            allow_ask = threading.Event()
            ask_finished = threading.Event()
            input_attempted = threading.Event()
            halt_result = []
            request_result = []
            original_revoke = bridge.revoke_diandian_cdp_inputs
            first_revoke = True
            first_revoke_guard = threading.Lock()

            def pause_after_empty_snapshot(active_run_id):
                nonlocal first_revoke
                original_revoke(active_run_id)
                with first_revoke_guard:
                    should_pause = first_revoke
                    first_revoke = False
                if should_pause:
                    snapshot_taken.set()
                    self.assertTrue(release_halt.wait(timeout=2))

            bridge.revoke_diandian_cdp_inputs = pause_after_empty_snapshot

            def ask(guarded, note_url, *, spec, tries, sleep):
                ask_entered.set()
                self.assertTrue(allow_ask.wait(timeout=2))
                try:
                    guarded.call("Input.insertText", text=note_url)
                    input_attempted.set()
                    return "This result must not be accepted after halt intent exists."
                finally:
                    ask_finished.set()

            bridge.diandian_cdp_ask = ask
            halt = threading.Thread(
                target=lambda: halt_result.append(bridge.halt_diandian_cdp_run(
                    run_id,
                    board_id,
                    reason="transport-failed",
                    safety=False,
                )),
                daemon=True,
            )
            request = threading.Thread(
                target=lambda: request_result.append(bridge.run_diandian_cdp({
                    "run_id": run_id,
                    "board_id": board_id,
                    "note_id": note_id,
                    "title": "Title",
                    "url": f"https://www.xiaohongshu.com/discovery/item/{note_id}?xsec_token=private-token",
                })),
                daemon=True,
            )

            halt.start()
            self.assertTrue(snapshot_taken.wait(timeout=1))
            request.start()
            self.assertTrue(ask_entered.wait(timeout=1))
            allow_ask.set()
            self.assertTrue(ask_finished.wait(timeout=1))
            release_halt.set()
            halt.join(timeout=2)
            request.join(timeout=2)

            self.assertFalse(halt.is_alive())
            self.assertFalse(request.is_alive())
            self.assertFalse(any(method.startswith("Input.") for method, _ in session.calls))
            self.assertTrue(halt_result[0]["halted"])
            self.assertTrue(request_result[0]["halted"])
            state = bridge.manual_sync_status()
            self.assertEqual(state["state"], "failed")
            self.assertIn(
                run_id,
                bridge.read_manual_sync()["summary_halted_run_ids"],
            )
            target.close.assert_not_called()

    def test_cdp_save_is_the_commit_point_when_a_concurrent_halt_arrives_during_dwell(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "m" * 24
            board_id = "board"
            run_id = "manual_board"
            ai_url = "https://www.xiaohongshu.com/ai_chat"
            summary = "A committed stable DianDian summary with enough safe content."
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            bridge.diandian_enabled = True
            bridge.diandian_cdp_enabled = True
            bridge.diandian_cdp_spec = {
                "ai_chat_url": ai_url,
                "selectors": {
                    "input_controls": ["textarea"],
                    "selected_note_card": ".card",
                    "assistant_message": ".message",
                    "finished_message_class": "finished",
                },
                "prompt": "总结",
                "minimum_summary_chars": 20,
                "timings_ms": {
                    "page_dom_stable": 0,
                    "response_wait": 300_000,
                    "reply_text_stable": 0,
                    "success_dwell": 1_500,
                },
            }
            bridge.diandian_save_record = BRIDGE.load_diandian_save_record(
                DIANDIAN_SKILL_SOURCE / "scripts" / "save_diandian_summary.py"
            )
            configure_point_v2(bridge, root, [note_id])
            bridge.summary_plans = {run_id: {note_id}}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.summary_halted = set()
            bridge.diandian_cdp_active = set()
            bridge.diandian_cdp_results = {}
            bridge.diandian_cdp_guard = threading.Lock()
            bridge.diandian_completion_state = mock.Mock()
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "run_board_ids": [board_id],
                "summary_pending": 1,
                "summary_failed": 0,
                "summarized": 0,
            })

            class FakeSession:
                def __init__(self):
                    self.finished = ""
                    self.value = ""

                def call(self, method, **params):
                    if method == "Input.insertText":
                        self.value += params["text"]
                    return {}

                def evaluate(self, expression):
                    return json.dumps({
                        "href": ai_url,
                        "body": "DianDian chat is ready",
                        "ready": "complete",
                        "input_ready": True,
                        "cards": 0,
                        "msgs": 1 if self.finished else 0,
                        "fin": 1 if self.finished else 0,
                        "val": self.value,
                        "last": self.finished,
                    })

            session = FakeSession()
            target = SimpleNamespace(session=session, close=mock.Mock())
            bridge.open_cdp_target = mock.Mock(return_value=target)
            dwell_entered = threading.Event()
            dwell_released = threading.Event()

            def controlled_sleep(seconds):
                if seconds == 1.5:
                    dwell_entered.set()
                    self.assertTrue(dwell_released.wait(timeout=2))

            bridge.diandian_sleep = controlled_sleep

            def ask(guarded, note_url, *, spec, tries, sleep):
                guarded.call("Input.insertText", text=note_url)
                guarded.call("Input.insertText", text=" 总结")
                guarded.call("Input.dispatchKeyEvent", type="keyDown", key="Enter")
                guarded.call("Input.dispatchKeyEvent", type="keyUp", key="Enter")
                guarded._session.finished = summary
                return summary

            bridge.diandian_cdp_ask = ask
            result_holder = []
            request = {
                "run_id": run_id,
                "board_id": board_id,
                "note_id": note_id,
                "title": "Committed title",
                "url": f"https://www.xiaohongshu.com/discovery/item/{note_id}?xsec_token=private-token",
            }
            worker = threading.Thread(
                target=lambda: result_holder.append(bridge.run_diandian_cdp(request)),
                daemon=True,
            )
            worker.start()
            self.assertTrue(dwell_entered.wait(timeout=2))
            self.assertIsNotNone(bridge.saved_diandian_record(note_id))
            self.assertEqual(bridge.manual_sync_status()["summarized"], 1)

            bridge.halt_diandian_run({
                "run_id": run_id,
                "board_id": board_id,
                "reason": "diandian-cdp-failed",
            })
            dwell_released.set()
            worker.join(timeout=2)

            self.assertFalse(worker.is_alive())
            self.assertEqual(
                result_holder,
                [{"saved": True, "halted": True, "reason": "run-halted"}],
            )
            self.assertEqual(bridge.saved_diandian_record(note_id)["summary"], summary)
            self.assertEqual(bridge.manual_sync_status()["summarized"], 1)
            target.close.assert_not_called()
            bridge.diandian_completion_state.assert_not_called()

    def test_cdp_external_ask_has_an_organizer_owned_single_note_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "w" * 24
            board_id = "board"
            run_id = "manual_board"
            ai_url = "https://www.xiaohongshu.com/ai_chat"
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            bridge.diandian_enabled = True
            bridge.diandian_cdp_enabled = True
            bridge.diandian_cdp_spec = {
                "ai_chat_url": ai_url,
                "selectors": {
                    "input_controls": ["textarea"],
                    "selected_note_card": ".card",
                    "assistant_message": ".message",
                    "finished_message_class": "finished",
                },
                "prompt": "总结",
                "minimum_summary_chars": 20,
                "timings_ms": {
                    "input_wait": 1_000,
                    "page_dom_stable": 0,
                    "context_wait": 1_000,
                    "note_context_stable": 0,
                    "response_wait": 300_000,
                    "reply_text_stable": 0,
                    "success_dwell": 0,
                    "single_note_wait": 20,
                },
            }
            bridge.summary_plans = {run_id: {note_id}}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.summary_halted = set()
            bridge.diandian_cdp_active = set()
            bridge.diandian_cdp_results = {}
            bridge.diandian_cdp_guard = threading.Lock()
            bridge.diandian_sleep = mock.Mock()
            bridge.diandian_save_record = mock.Mock()
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "run_board_ids": [board_id],
                "summary_pending": 1,
                "summary_failed": 0,
            })

            class FakeSession:
                def __init__(self):
                    self.calls = []
                    self.value = ""
                    self.finished = ""

                def call(self, method, **params):
                    self.calls.append((method, params))
                    if method == "Input.insertText":
                        self.value += params["text"]
                    return {}

                def evaluate(self, expression):
                    return json.dumps({
                        "href": ai_url,
                        "body": "DianDian chat is ready",
                        "ready": "complete",
                        "input_ready": True,
                        "cards": 0,
                        "msgs": 1 if self.finished else 0,
                        "fin": 1 if self.finished else 0,
                        "val": self.value,
                        "last": self.finished,
                    })

            session = FakeSession()
            target = SimpleNamespace(session=session, close=mock.Mock())
            bridge.open_cdp_target = mock.Mock(return_value=target)
            ask_entered = threading.Event()
            ask_release = threading.Event()
            ask_exited = threading.Event()
            summary = "A late summary must never be saved after the organizer deadline."

            def ask(guarded, note_url, *, spec, tries, sleep):
                ask_entered.set()
                ask_release.wait(timeout=2)
                try:
                    guarded.call("Input.insertText", text=note_url)
                    guarded.call("Input.insertText", text=" 总结")
                    guarded.call("Input.dispatchKeyEvent", type="keyDown", key="Enter")
                    guarded.call("Input.dispatchKeyEvent", type="keyUp", key="Enter")
                    guarded._session.finished = summary
                    return summary
                finally:
                    ask_exited.set()

            bridge.diandian_cdp_ask = ask
            result_holder = []
            request = {
                "run_id": run_id,
                "board_id": board_id,
                "note_id": note_id,
                "title": "Title",
                "url": f"https://www.xiaohongshu.com/discovery/item/{note_id}?xsec_token=private-token",
            }
            worker = threading.Thread(
                target=lambda: result_holder.append(bridge.run_diandian_cdp(request)),
                daemon=True,
            )
            worker.start()
            self.assertTrue(ask_entered.wait(timeout=1))
            finished_before_release = not worker.is_alive() or worker.join(timeout=0.25) is None and not worker.is_alive()
            ask_release.set()
            worker.join(timeout=2)
            self.assertTrue(ask_exited.wait(timeout=2))

            self.assertTrue(finished_before_release, "the bridge must not wait for a hung external ask")
            self.assertEqual(
                result_holder,
                [{"saved": False, "halted": True, "reason": "single-note-timeout"}],
            )
            self.assertFalse(any(method.startswith("Input.") for method, _ in session.calls))
            bridge.diandian_save_record.assert_not_called()
            target.close.assert_not_called()
            self.assertEqual(bridge.diandian_cdp_active, set())
            self.assertEqual(bridge.manual_sync_status()["state"], "failed")

    def test_cdp_preflight_deadline_blocks_transport_spawn_and_input_dispatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "d" * 24
            board_id = "board"
            run_id = "manual_board"
            ai_url = "https://www.xiaohongshu.com/ai_chat"
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            bridge.diandian_enabled = True
            bridge.diandian_cdp_enabled = True
            bridge.diandian_cdp_spec = {
                "ai_chat_url": ai_url,
                "selectors": {
                    "input_controls": ["textarea"],
                    "selected_note_card": ".card",
                    "assistant_message": ".message",
                    "finished_message_class": "finished",
                },
                "prompt": "总结",
                "minimum_summary_chars": 20,
                "timings_ms": {
                    "input_wait": 1_000,
                    "page_dom_stable": 0,
                    "context_wait": 1_000,
                    "note_context_stable": 0,
                    "response_wait": 300_000,
                    "reply_text_stable": 0,
                    "success_dwell": 0,
                    "single_note_wait": 100,
                },
            }
            bridge.summary_plans = {run_id: {note_id}}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.summary_halted = set()
            bridge.diandian_cdp_active = set()
            bridge.diandian_cdp_results = {}
            bridge.diandian_cdp_guard = threading.Lock()
            bridge.diandian_sleep = mock.Mock()
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual",
                "state": "running",
                "run_board_ids": [board_id],
                "summary_pending": 1,
                "summary_failed": 0,
            })

            class FakeSession:
                def __init__(self):
                    self.calls = []

                def call(self, method, **params):
                    self.calls.append((method, params))
                    return {}

                def evaluate(self, expression):
                    return json.dumps({
                        "href": ai_url,
                        "body": "DianDian chat is ready",
                        "ready": "complete",
                        "input_ready": True,
                        "cards": 0,
                        "msgs": 0,
                        "fin": 0,
                        "val": "",
                        "last": "",
                    })

            class ImmediateThread:
                def __init__(self, *, target, **_kwargs):
                    self.target = target

                def start(self):
                    self.target()

            session = FakeSession()
            target = SimpleNamespace(session=session, close=mock.Mock())
            bridge.open_cdp_target = mock.Mock(return_value=target)
            ask_called = mock.Mock()

            def ask(guarded, note_url, *, spec, tries, sleep):
                ask_called()
                guarded.call("Input.insertText", text=note_url)
                return "This transport must never start after the absolute deadline."

            bridge.diandian_cdp_ask = ask
            request = {
                "run_id": run_id,
                "board_id": board_id,
                "note_id": note_id,
                "title": "Title",
                "url": f"https://www.xiaohongshu.com/discovery/item/{note_id}?xsec_token=private-token",
            }
            with (
                mock.patch.object(BRIDGE.time, "monotonic", side_effect=[100.0, 101.0]),
                mock.patch.object(BRIDGE.threading, "Thread", ImmediateThread),
            ):
                result = bridge.run_diandian_cdp(request)

            self.assertEqual(
                result,
                {"saved": False, "halted": True, "reason": "single-note-timeout"},
            )
            ask_called.assert_not_called()
            self.assertFalse(any(method.startswith("Input.") for method, _ in session.calls))
            target.close.assert_not_called()

    def test_expired_cdp_worker_cannot_mutate_a_replacement_manual_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old_batch = "manualold"
            new_batch = "manualnew"
            board_id = "board"
            old_run = f"{old_batch}_{board_id}"
            note_id = "z" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            bridge.summary_plans = {old_run: {note_id}}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.summary_halted = set()
            bridge.diandian_save_record = mock.Mock()
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": old_batch,
                "state": "running",
                "started_at": "2000-01-01T00:00:00+00:00",
                "run_board_ids": [board_id],
                "summary_pending": 1,
                "summary_failed": 0,
                "summarized": 0,
            })
            validation_entered = threading.Event()
            validation_release = threading.Event()
            original_validate = bridge.validate_manual_board_run
            validate_calls = 0

            def blocking_validate(run_id, candidate_board_id):
                nonlocal validate_calls
                original_validate(run_id, candidate_board_id)
                validate_calls += 1
                if validate_calls == 1:
                    validation_entered.set()
                    self.assertTrue(validation_release.wait(timeout=2))

            bridge.validate_manual_board_run = blocking_validate
            errors = []

            def save_from_old_worker():
                try:
                    bridge.save_diandian_result({
                        "run_id": old_run,
                        "board_id": board_id,
                        "note_id": note_id,
                        "title": "Old title",
                        "summary": "Old worker summary must never enter the replacement batch.",
                    }, defer_finalization=True)
                except Exception as error:
                    errors.append(error)

            worker = threading.Thread(
                target=save_from_old_worker,
                daemon=True,
            )
            worker.start()
            self.assertTrue(validation_entered.wait(timeout=1))

            bridge.manual_sync_status()
            expired = bridge.read_manual_sync()
            self.assertIn(old_run, expired.get("summary_halted_run_ids", []))
            self.assertIn(old_run, bridge.summary_halted)
            replacement = {
                "batch": new_batch,
                "state": "running",
                "started_at": BRIDGE.datetime.now().astimezone().isoformat(),
                "run_board_ids": [board_id],
                "summary_pending": 0,
                "summary_failed": 0,
                "summarized": 0,
            }
            BRIDGE.atomic_json(bridge.manual_sync_path, replacement)
            replacement_bytes = bridge.manual_sync_path.read_bytes()
            validation_release.set()
            worker.join(timeout=2)

            self.assertFalse(worker.is_alive())
            self.assertTrue(errors)
            self.assertIsInstance(errors[0], ValueError)
            self.assertEqual(bridge.manual_sync_path.read_bytes(), replacement_bytes)
            bridge.diandian_save_record.assert_not_called()
            self.assertFalse((bridge.diandian_dir / f"{note_id}.json").exists())

    def test_finalization_completion_cannot_overwrite_a_concurrent_halt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = "manualrace"
            board_id = "board"
            run_id = f"{batch}_{board_id}"
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            bridge.summary_plans = {run_id: set()}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.summary_halted = set()
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "running",
                "started_at": BRIDGE.datetime.now().astimezone().isoformat(),
                "run_board_ids": [board_id],
                "summary_pending": 0,
                "summary_failed": 0,
                "summary_finalizing": True,
                "current_board": "Board：正在更新点点 AI 结果",
            })
            complete_commit = threading.Event()
            complete_release = threading.Event()
            original_atomic = BRIDGE.atomic_json

            def tracking_atomic(path, value):
                if (
                    Path(path) == bridge.manual_sync_path
                    and value.get("state") == "completed"
                    and threading.current_thread().name == "test-finalization-complete"
                ):
                    complete_commit.set()
                    self.assertTrue(complete_release.wait(timeout=2))
                original_atomic(path, value)

            completion = threading.Thread(
                target=bridge.complete_manual_after_diandian,
                args=(run_id, board_id, {"state": "completed", "next_board_id": None}, None, ""),
                name="test-finalization-complete",
                daemon=True,
            )
            with mock.patch.object(BRIDGE, "atomic_json", side_effect=tracking_atomic):
                completion.start()
                self.assertTrue(complete_commit.wait(timeout=1))
                halt = threading.Thread(
                    target=bridge.halt_diandian_cdp_run,
                    args=(run_id, board_id),
                    kwargs={"reason": "transport-failed", "safety": False},
                    daemon=True,
                )
                halt.start()
                self.assertTrue(halt.is_alive())
                complete_release.set()
                completion.join(timeout=2)
                halt.join(timeout=2)

            self.assertFalse(completion.is_alive())
            self.assertFalse(halt.is_alive())
            self.assertEqual(bridge.read_manual_sync()["state"], "failed")

    def test_safety_halt_wins_before_finalizer_publish_claim_without_calling_publisher(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = "manualpublishrace"
            board_id = "board"
            run_id = f"{batch}_{board_id}"
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            bridge.processing_lock = threading.Lock()
            bridge.summary_plans = {run_id: set()}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.summary_finalizing = {run_id}
            bridge.summary_finalized = set()
            bridge.summary_halted = set()
            bridge.summary_finalization_threads = {}
            bridge.publish_config = {"repository": "unused", "branch": "main"}
            bridge.rebuild_knowledge_base = mock.Mock()
            bridge.publish_public_site = mock.Mock(
                return_value={"ok": True, "status": "published"}
            )
            bridge.write_status = mock.Mock()
            BRIDGE.atomic_json(bridge.state_dir / "runs" / f"{run_id}.json", {
                "run_id": run_id,
                "state": "completed",
                "next_board_id": None,
            })
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "running",
                "run_board_ids": [board_id],
                "summary_pending": 0,
                "summary_failed": 0,
                "summary_finalizing": True,
                "current_board": "Board：正在更新点点 AI 结果",
            })
            publish_check_entered = threading.Event()
            publish_check_release = threading.Event()

            def pause_during_publish_check(_board_id, _run_id):
                publish_check_entered.set()
                if not publish_check_release.wait(timeout=2):
                    raise RuntimeError("publish race barrier timed out")
                return None

            bridge.next_board_id = mock.Mock(side_effect=pause_during_publish_check)
            finalizer = threading.Thread(
                target=bridge.run_diandian_finalization,
                args=(run_id, board_id),
                name="test-finalization-publish-race",
                daemon=True,
            )
            finalizer.start()
            self.assertTrue(publish_check_entered.wait(timeout=1))

            try:
                halted = bridge.halt_diandian_run({
                    "run_id": run_id,
                    "board_id": board_id,
                    "reason": "xhs-safety-stop",
                })
            finally:
                publish_check_release.set()
            finalizer.join(timeout=2)

            self.assertFalse(finalizer.is_alive())
            bridge.publish_public_site.assert_not_called()
            self.assertEqual(halted, {
                "halted": True,
                "reason": "xhs-safety-stop",
                "plan_complete": True,
                "finalization_started": False,
            })
            state = bridge.read_manual_sync()
            self.assertEqual(state["state"], "safety-stopped")
            self.assertIs(state["core_completed"], True)
            self.assertFalse(state["summary_finalizing"])
            self.assertIn(run_id, state["summary_halted_run_ids"])

    def test_terminal_manual_state_never_leaks_a_finalizing_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = "manualdone"
            board_id = "board"
            run_id = f"{batch}_{board_id}"
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.boards = {board_id: "Board"}
            bridge.summary_plans = {run_id: set()}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.summary_finalizing = set()
            bridge.summary_finalized = set()
            bridge.summary_halted = set()
            BRIDGE.atomic_json(bridge.state_dir / "runs" / f"{run_id}.json", {
                "run_id": run_id, "state": "completed",
            })
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "completed",
                "run_board_ids": [board_id],
            })

            self.assertFalse(bridge.start_diandian_finalization(run_id, board_id))
            self.assertFalse(bridge.start_diandian_finalization(run_id, board_id))
            self.assertNotIn(run_id, bridge.summary_finalizing)

    def test_thread_start_failure_rolls_back_finalization_claim_and_manual_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            batch = "manualretry"
            board_id = "board"
            run_id = f"{batch}_{board_id}"
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.boards = {board_id: "Board"}
            bridge.summary_plans = {run_id: set()}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.summary_finalizing = set()
            bridge.summary_finalized = set()
            bridge.summary_halted = set()
            BRIDGE.atomic_json(bridge.state_dir / "runs" / f"{run_id}.json", {
                "run_id": run_id, "state": "completed",
            })
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "running",
                "run_board_ids": [board_id],
                "current_board": "Board",
            })
            original_state = bridge.manual_sync_path.read_bytes()

            with (
                mock.patch.object(BRIDGE.threading.Thread, "start", side_effect=RuntimeError("no threads")),
                self.assertRaisesRegex(RuntimeError, "no threads"),
            ):
                bridge.start_diandian_finalization(run_id, board_id)

            self.assertEqual(bridge.manual_sync_path.read_bytes(), original_state)
            self.assertNotIn(run_id, bridge.summary_finalizing)
            self.assertNotIn(run_id, bridge.summary_finalization_threads)

    def test_cdp_safety_or_stale_page_halts_before_calling_external_transport_and_leaves_target_open(self):
        cases = [
            ("safety", "访问频繁 300031", 0, 0, "safety-stopped", "xhs-safety-stop"),
            ("login", "请先登录后继续", 0, 0, "failed", "login-required"),
            ("stale", "DianDian chat is ready", 1, 1, "failed", "stale-target"),
        ]
        for name, body, msgs, fin, state, reason in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                note_id = "g" * 24
                board_id = "board"
                run_id = "manual_board"
                ai_url = "https://www.xiaohongshu.com/ai_chat"
                bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
                bridge.state_dir = root / ".xhs-favorites"
                bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
                bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
                bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
                bridge.boards = {board_id: "Board"}
                bridge.board_order = [board_id]
                bridge.diandian_enabled = True
                bridge.diandian_cdp_enabled = True
                bridge.diandian_cdp_spec = {
                    "ai_chat_url": ai_url, "prompt": "总结", "minimum_summary_chars": 20,
                    "selectors": {
                        "input_controls": ["textarea"],
                        "selected_note_card": ".card",
                        "assistant_message": ".message",
                        "finished_message_class": "finished",
                    },
                    "selectors": {"input_controls": ["textarea"], "selected_note_card": ".card", "assistant_message": ".message", "finished_message_class": "finished"},
                    "timings_ms": {"response_wait": 300_000, "reply_text_stable": 2_000, "success_dwell": 1_500},
                }
                bridge.summary_plans = {run_id: {note_id}}
                bridge.summary_locks = {}
                bridge.summary_locks_guard = threading.Lock()
                bridge.summary_halted = set()
                bridge.diandian_cdp_active = set()
                bridge.diandian_cdp_results = {}
                bridge.diandian_cdp_guard = threading.Lock()
                bridge.diandian_sleep = mock.Mock()
                BRIDGE.atomic_json(bridge.manual_sync_path, {
                    "batch": "manual", "state": "running", "run_board_ids": [board_id], "summary_pending": 1,
                })
                session = SimpleNamespace(
                    call=mock.Mock(return_value={}),
                    evaluate=mock.Mock(return_value=json.dumps({
                        "href": ai_url, "body": body, "ready": "complete",
                        "input_ready": True, "msgs": msgs, "fin": fin, "last": "stale" if fin else "",
                    })),
                )
                target = SimpleNamespace(session=session, close=mock.Mock())
                bridge.open_cdp_target = mock.Mock(return_value=target)
                bridge.diandian_cdp_ask = mock.Mock()

                result = bridge.run_diandian_cdp({
                    "run_id": run_id, "board_id": board_id, "note_id": note_id,
                    "title": "Title",
                    "url": f"https://www.xiaohongshu.com/discovery/item/{note_id}?xsec_token=private-token",
                })

                self.assertEqual(result, {"saved": False, "halted": True, "reason": reason})
                bridge.diandian_cdp_ask.assert_not_called()
                target.close.assert_not_called()
                self.assertEqual(bridge.manual_sync_status()["state"], state)

    def test_diandian_result_and_skip_reject_note_id_path_traversal(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.diandian_dir = root / ".xhs-favorites" / "diandian-summaries"
            bridge.summary_plans = {"manual_board": set()}
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "出海电商"}
            bridge.diandian_save_record = mock.Mock()
            bridge.saved_diandian_record = mock.Mock()
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual", "state": "running", "summarized": 0,
            })

            with self.assertRaisesRegex(ValueError, "note_id"):
                bridge.save_diandian_result({
                    "run_id": "manual_board",
                    "board_id": "board",
                    "note_id": "../manual-sync",
                    "title": "Example",
                    "summary": "This is a complete and sufficiently long safe summary.",
                })
            with self.assertRaisesRegex(ValueError, "note_id"):
                bridge.skip_diandian_result({
                    "run_id": "manual_board",
                    "board_id": "board",
                    "note_id": "../manual-sync",
                    "reason": "attachment-not-supported",
                })

            bridge.diandian_save_record.assert_not_called()
            bridge.saved_diandian_record.assert_not_called()

    def test_core_import_completes_before_optional_diandian_enrichment_finishes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first_id = "f" * 24
            second_id = "g" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.diandian_enabled = True
            bridge.diandian_dir = root / "summaries"
            bridge.summary_plans = {}
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.state_dir = root
            bridge.processing_lock = BRIDGE.threading.Lock()
            bridge.boards = {"board": "出海电商"}
            bridge.board_order = ["board"]
            configure_point_v2(bridge, root, [first_id, second_id])
            batch = "manual"
            run_id = bridge.manual_run_id(batch, "board")
            bridge.diandian_save_record = lambda destination, title, summary_text, note_id: BRIDGE.atomic_json(destination, {
                "version": 1,
                "provider": "xiaohongshu-diandian",
                "prompt": "总结",
                "note_id": note_id,
                "title": title,
                "summary": summary_text,
                "request_sha256": BRIDGE.diandian_result_digest(title, summary_text),
            })
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch, "state": "running", "summarized": 0,
            })
            payload = {
                "run_id": run_id,
                "board_id": "board",
                "urls": [f"https://www.xiaohongshu.com/explore/{first_id}"],
            }

            def finish_import(active_run_id, _board_id, _unique):
                BRIDGE.atomic_json(root / "runs" / f"{active_run_id}.json", {
                    "run_id": active_run_id,
                    "state": "completed",
                    "scanned": 1,
                    "new": 0,
                    "next_board_id": None,
                })

            bridge.process_import = mock.Mock(side_effect=finish_import)
            bridge.rebuild_knowledge_base = mock.Mock()
            bridge.publish_after_board = mock.Mock(return_value=None)

            status, result = bridge.import_sync(payload)

            self.assertEqual(status, BRIDGE.HTTPStatus.OK)
            self.assertTrue(result["ok"])
            bridge.process_import.assert_called_once()
            between_core_and_plan = bridge.manual_sync_status()
            self.assertEqual(between_core_and_plan["state"], "running")
            self.assertTrue(between_core_and_plan["summary_plan_pending"])
            self.assertEqual(bridge.rebuild_knowledge_base.call_count, 0)

            plan = bridge.diandian_summary_plan({
                "run_id": run_id,
                "board_id": "board",
                "note_ids": [first_id, second_id],
            })
            self.assertEqual(plan["note_ids"], [first_id, second_id])
            self.assertEqual(bridge.manual_sync_status()["state"], "running")
            self.assertFalse(bridge.manual_sync_status()["summary_plan_pending"])

            bridge.save_diandian_result({
                "run_id": run_id,
                "board_id": "board",
                "note_id": first_id,
                "title": "第一篇",
                "summary": "第一篇已经获得足够长并且可以通过边界校验的完整点点总结正文。",
            })
            self.assertEqual(bridge.rebuild_knowledge_base.call_count, 0)
            self.assertEqual(bridge.manual_sync_status()["state"], "running")
            bridge.save_diandian_result({
                "run_id": run_id,
                "board_id": "board",
                "note_id": second_id,
                "title": "第二篇",
                "summary": "第二篇已经获得足够长并且可以通过边界校验的完整点点总结正文。",
            })

            bridge.summary_finalization_threads[run_id].join(timeout=2)

            self.assertEqual(bridge.rebuild_knowledge_base.call_count, 1)
            self.assertEqual(bridge.manual_sync_status()["state"], "completed")

    def test_rebuild_passes_same_private_summary_directory_to_both_builders(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.builder = root / "build-knowledge-base.mjs"
            bridge.public_builder = root / "build-public-site.mjs"
            bridge.catalog_path = root / "catalog.json"
            bridge.config_path = root / "config.json"
            bridge.curation = root / "curation.json"
            bridge.profile = root / "profile.json"
            bridge.knowledge_base = root / "knowledge-base"
            bridge.workspace = root
            bridge.diandian_dir = root / "private-summaries"
            bridge.resource_registry = None

            with mock.patch.object(BRIDGE.subprocess, "run", return_value=mock.Mock(returncode=0)) as run:
                bridge.rebuild_knowledge_base()

            self.assertEqual(run.call_count, 2)
            for call in run.call_args_list:
                command = call.args[0]
                position = command.index("--diandian-dir")
                self.assertEqual(Path(command[position + 1]), bridge.diandian_dir)

    def test_rebuild_restores_previous_public_generation_when_knowledge_build_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.builder = root / "build-knowledge-base.mjs"
            bridge.public_builder = root / "build-public-site.mjs"
            bridge.catalog_path = root / "catalog.json"
            bridge.config_path = root / "config.json"
            bridge.curation = root / "curation.json"
            bridge.profile = root / "profile.json"
            bridge.knowledge_base = root / "knowledge-base"
            bridge.workspace = root
            bridge.diandian_dir = root / "private-summaries"
            bridge.resource_registry = None
            public_output = root / "site" / "data" / "knowledge.json"
            public_output.parent.mkdir(parents=True)
            public_output.write_bytes(b"previous-public-generation")
            calls = []

            def run(command, **_kwargs):
                calls.append(Path(command[1]).name)
                if Path(command[1]) == bridge.public_builder:
                    public_output.write_bytes(b"new-public-generation")
                    return SimpleNamespace(returncode=0, stdout="", stderr="")
                return SimpleNamespace(returncode=1, stdout="", stderr="injected failure")

            with mock.patch.object(BRIDGE.subprocess, "run", side_effect=run):
                with self.assertRaisesRegex(RuntimeError, "knowledge base build failed"):
                    bridge.rebuild_knowledge_base()

            self.assertEqual(calls, ["build-public-site.mjs", "build-knowledge-base.mjs"])
            self.assertEqual(public_output.read_bytes(), b"previous-public-generation")

    def test_local_open_note_opens_the_lookup_in_the_shared_sop_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture = json.loads(
                (Path(__file__).parents[1] / "test-fixtures" / "open-original-current-browser.json")
                .read_text(encoding="utf-8")
            )
            note_id = fixture["note_id"]
            board_id = fixture["board_id"]
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.catalog_path = root / "catalog.json"
            BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {
                note_id: {"source_board_ids": [board_id]},
            }})
            bridge.all_boards = [{"id": board_id, "name": "测试收藏夹", "available": True}]
            bridge.open_sop_browser_page = mock.Mock(return_value={"id": "target"})

            with mock.patch.object(BRIDGE.subprocess, "Popen") as popen:
                result = bridge.open_original_note(note_id)

            self.assertEqual(result, {"status": "opened"})
            popen.assert_not_called()
            bridge.open_sop_browser_page.assert_called_once()
            navigation = urlparse(bridge.open_sop_browser_page.call_args.args[0])
            self.assertEqual(navigation.scheme, "https")
            self.assertEqual(navigation.netloc, "www.xiaohongshu.com")
            self.assertEqual(navigation.path, f"/board/{board_id}")
            self.assertEqual(parse_qs(navigation.query), {
                key: [value] for key, value in fixture["required_query"].items()
            })
            self.assertNotIn("navigation_url", result)

    def test_local_note_organization_status_returns_only_current_pending_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "n" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.catalog_path = root / "catalog.json"
            BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {
                note_id: {"note_id": note_id, "content_sha256": "b" * 64},
            }})
            bridge.saved_diandian_record = mock.Mock(return_value={
                "version": 2,
                "provider": "xiaohongshu-diandian",
                "summary": "Synthetic captured summary",
                "summary_sha256": "c" * 64,
            })

            result = bridge.note_organization_status(note_id)

            self.assertEqual(result, {
                "schema_version": 2,
                "note_id": note_id,
                "status": "pending_review",
                "reason_code": "audit_pending",
                "display_summary": "Synthetic captured summary",
                "evidence_methods": [{
                    "method": "point",
                    "provider": "xiaohongshu-diandian",
                    "version": "2",
                    "result_sha256": "c" * 64,
                }],
                "blockers": ["audit_pending"],
            })
            self.assertNotIn("content_sha256", result)
            self.assertNotIn("source_url", result)

            bridge.saved_diandian_record.return_value = None
            with self.assertRaisesRegex(ValueError, "current captured summary"):
                bridge.note_organization_status(note_id)

    def test_sop_runtime_contract_fails_closed_without_its_fixed_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with mock.patch.object(BRIDGE.subprocess, "Popen") as popen, self.assertRaisesRegex(
                ValueError, "SOP browser runtime contract"
            ):
                BRIDGE.resolve_sop_browser_contract(root)
            popen.assert_not_called()

    def test_sop_runtime_contract_rejects_any_reparse_point(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime"
            profile = runtime / ".secrets" / "browser-profiles" / "cdp-chrome"
            profile.mkdir(parents=True)
            port_file = runtime / ".secrets" / "cdp-port.txt"
            port_file.write_text("9222\n", encoding="ascii")
            launcher = runtime / "scripts" / "启动扫描浏览器.bat"
            launcher.parent.mkdir(parents=True)
            launcher.write_text("@echo off\n", encoding="utf-8")
            with mock.patch.object(
                BRIDGE,
                "path_is_reparse_point",
                side_effect=lambda path: Path(path) == profile,
            ), self.assertRaisesRegex(
                ValueError, "SOP browser runtime contract"
            ):
                BRIDGE.resolve_sop_browser_contract(runtime)

    def test_private_runtime_paths_and_secrets_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            plain_file = root / "secret"
            plain_file.write_text("a" * 64, encoding="ascii")
            self.assertEqual(
                BRIDGE.require_plain_directory(root, "private runtime"),
                root,
            )
            self.assertEqual(
                BRIDGE.require_plain_file(plain_file, "private secret"),
                plain_file,
            )
            with mock.patch.object(
                BRIDGE, "path_is_reparse_point", return_value=True
            ):
                with self.assertRaisesRegex(ValueError, "redirected"):
                    BRIDGE.require_plain_directory(root, "private runtime")
                with self.assertRaisesRegex(ValueError, "redirected"):
                    BRIDGE.require_plain_file(plain_file, "private secret")

        self.assertEqual(
            BRIDGE.require_hex_secret("a" * 64, "bridge token"),
            "a" * 64,
        )
        for value in ("a" * 63, "A" * 64, 'a";alert(1)//', "a" * 64 + "\nextra"):
            with self.subTest(value=value), self.assertRaisesRegex(
                ValueError, "missing or invalid"
            ):
                BRIDGE.require_hex_secret(value, "bridge token")

    def test_manual_run_ids_keep_long_board_ids_distinct(self):
        batch = "manual20260822010101000000"
        shared = "a" * 79
        first_board = shared + "b"
        second_board = shared + "c"
        first = BRIDGE.Bridge.manual_run_id(batch, first_board)
        second = BRIDGE.Bridge.manual_run_id(batch, second_board)

        self.assertNotEqual(first, second)
        self.assertEqual(len(first), 80)
        self.assertEqual(len(second), 80)
        self.assertRegex(first, BRIDGE.RUN_ID)
        expected_digest = BRIDGE.hashlib.sha256(
            f"{batch}\0{first_board}".encode("utf-8")
        ).hexdigest()[:16]
        self.assertTrue(first.endswith("_" + expected_digest))
        self.assertEqual(
            BRIDGE.Bridge.manual_run_id("shortbatch", "board"),
            "shortbatch_board",
        )

    def test_sop_port_registry_rejects_extra_lines_without_endpoint_access(self):
        with tempfile.TemporaryDirectory() as directory:
            port_file = Path(directory) / "cdp-port.txt"
            port_file.write_text("9222\n9223\n", encoding="ascii")
            with mock.patch.object(BRIDGE, "build_opener") as opened, self.assertRaisesRegex(
                RuntimeError, "port registry"
            ):
                BRIDGE.read_sop_devtools_endpoint(port_file)
            opened.assert_not_called()

    def test_sop_port_registry_rejects_a_reparse_point_before_endpoint_access(self):
        with tempfile.TemporaryDirectory() as directory:
            port_file = Path(directory) / "cdp-port.txt"
            port_file.write_text("9222\n", encoding="ascii")
            with mock.patch.object(
                BRIDGE, "path_is_reparse_point", return_value=True
            ), mock.patch.object(
                BRIDGE,
                "loopback_devtools_json",
                return_value={
                    "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/id"
                },
            ) as endpoint_access, self.assertRaisesRegex(RuntimeError, "port registry"):
                BRIDGE.read_sop_devtools_endpoint(port_file)
            endpoint_access.assert_not_called()

    def test_diandian_cdp_target_uses_the_same_dynamic_sop_port_registry(self):
        bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
        bridge.sop_port_file = Path("dynamic-cdp-port.txt")
        target = object()
        with mock.patch.object(
            BRIDGE, "open_sop_cdp_target", return_value=target
        ) as open_target:
            result = bridge.open_cdp_target("about:blank")

        self.assertIs(result, target)
        open_target.assert_called_once_with(bridge.sop_port_file, "about:blank")

    def test_cdp_session_exposes_only_call_and_evaluate_without_cookie_or_storage_access(self):
        class FakeConnection:
            def __init__(self):
                self.sent = []
                self.timeouts = []

            def send(self, payload):
                self.sent.append(json.loads(payload))

            def recv(self, timeout=None):
                self.timeouts.append(timeout)
                request = self.sent[-1]
                if request["method"] == "Runtime.evaluate":
                    result = {"result": {"type": "string", "value": "ready"}}
                else:
                    result = {"frameId": "frame-1"}
                return json.dumps({"id": request["id"], "result": result})

        connection = FakeConnection()
        session = BRIDGE.CDPSession(connection)

        self.assertEqual(
            session.call("Page.navigate", url="https://www.xiaohongshu.com/ai_chat"),
            {"frameId": "frame-1"},
        )
        self.assertEqual(session.evaluate("document.readyState"), "ready")
        self.assertEqual(
            [request["method"] for request in connection.sent],
            ["Page.navigate", "Runtime.evaluate"],
        )
        self.assertEqual(len(connection.timeouts), 2)
        self.assertTrue(all(0 < timeout <= 10 for timeout in connection.timeouts))
        for method in ("Storage.getCookies", "Network.getCookies", "Network.setCookie"):
            with self.subTest(method=method), self.assertRaisesRegex(ValueError, "Cookie|Storage"):
                session.call(method)
        self.assertEqual(len(connection.sent), 2)

    def test_cdp_session_has_one_overall_deadline_despite_unrelated_events(self):
        class NoisyConnection:
            def __init__(self):
                self.timeouts = []

            def send(self, payload):
                pass

            def recv(self, timeout=None):
                self.timeouts.append(timeout)
                return json.dumps({"method": "Page.lifecycleEvent"})

        connection = NoisyConnection()
        session = BRIDGE.CDPSession(connection)
        with mock.patch.object(
            BRIDGE.time,
            "monotonic",
            side_effect=[0, 0, 4, 8, 10.1],
        ), self.assertRaisesRegex(RuntimeError, "timed out"):
            session.call("Page.navigate", url="https://www.xiaohongshu.com/ai_chat")

        self.assertEqual(connection.timeouts, [10, 6, 2])

    def test_shared_sop_page_open_rejects_non_xiaohongshu_destinations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.sop_port_file = root / "cdp-port.txt"
            with mock.patch.object(BRIDGE.subprocess, "Popen") as popen:
                for url in (
                    "http://www.xiaohongshu.com/explore",
                    "https://attacker.invalid/",
                    "https://user:password@www.xiaohongshu.com/explore",
                ):
                    with self.subTest(url=url), self.assertRaisesRegex(ValueError, "Xiaohongshu"):
                        bridge.open_sop_browser_page(url)
            popen.assert_not_called()

    def test_shared_sop_page_open_fails_closed_when_the_port_registry_is_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.sop_port_file = root / "missing-cdp-port.txt"

            with mock.patch.object(BRIDGE.subprocess, "Popen") as popen, self.assertRaisesRegex(
                RuntimeError, "port registry"
            ):
                bridge.open_sop_browser_page("https://www.xiaohongshu.com/explore")

            popen.assert_not_called()
            self.assertFalse((root / ".xhs-favorites" / "browser-profile").exists())

    def test_local_open_note_http_route_requires_manager_token_origin_and_exact_payload(self):
        fixture = json.loads(
            (Path(__file__).parents[1] / "test-fixtures" / "open-original-current-browser.json")
            .read_text(encoding="utf-8")
        )
        token = "a" * 64
        bridge = SimpleNamespace(
            port=0,
            token=token,
            open_original_note=mock.Mock(return_value={"status": "opened"}),
        )
        server = BRIDGE.ThreadingHTTPServer((BRIDGE.HOST, 0), BRIDGE.make_handler(bridge))
        bridge.port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def post(payload, *, supplied_token=token, origin=BRIDGE.MANAGER_ORIGIN):
            request = Request(
                f"http://{BRIDGE.HOST}:{bridge.port}/notes/open",
                data=json.dumps(payload).encode("utf-8"),
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
            status, body = post({"note_id": fixture["note_id"]})
            self.assertEqual(status, 202)
            self.assertEqual(body, {
                "ok": True,
                "status": "opened",
            })
            bridge.open_original_note.assert_called_once_with(fixture["note_id"])

            bridge.open_original_note.reset_mock()
            for status, body in (
                post({"note_id": fixture["note_id"]}, supplied_token="b" * 64),
                post({"note_id": fixture["note_id"]}, origin="https://attacker.invalid"),
            ):
                self.assertEqual(status, 401)
                self.assertEqual(body, {"ok": False})
            status, body = post({"note_id": fixture["note_id"], "unexpected": True})
            self.assertEqual(status, 400)
            self.assertEqual(body["ok"], False)
            self.assertFalse(bridge.open_original_note.called)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_manual_organization_only_opens_a_shared_sop_tab_after_explicit_trigger(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.trigger_lock = BRIDGE.threading.Lock()
            bridge.processing_lock = BRIDGE.threading.Lock()
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.board_order = ["first"]
            bridge.boards = {"first": "First"}
            bridge.workspace = root
            bridge.state_dir = root / ".xhs-favorites"
            bridge.config_path = root / "config.json"
            bridge.port = 47631
            bridge.profile_url = "https://www.xiaohongshu.com/user/profile/testprofile?tab=fav&subTab=board"
            bridge.open_sop_browser_page = mock.Mock(return_value={"id": "target"})

            with mock.patch.object(BRIDGE.subprocess, "Popen") as popen:
                bridge.open_sop_browser_page.assert_not_called()
                status = bridge.trigger_manual_sync()

            self.assertEqual(status["state"], "starting")
            self.assertEqual(status["board_count"], 1)
            self.assertNotIn("batch", status)
            popen.assert_not_called()
            bridge.open_sop_browser_page.assert_called_once()
            launched_url = bridge.open_sop_browser_page.call_args.args[0]
            self.assertIn("/user/profile/testprofile", launched_url)
            self.assertIn("xhs_kb_sync=1", launched_url)
            self.assertIn("xhs_kb_mode=incremental", launched_url)
            with self.assertRaisesRegex(BRIDGE.BridgeBusyError, "already running"):
                bridge.trigger_manual_sync()

    def test_manual_organization_can_freeze_a_one_time_board_scope_without_changing_settings(self):
        fixture = json.loads(
            (Path(__file__).parents[1] / "test-fixtures" / "single-board-run-scope.json")
            .read_text(encoding="utf-8")
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.trigger_lock = BRIDGE.threading.Lock()
            bridge.processing_lock = BRIDGE.threading.Lock()
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.all_boards = fixture["configured_boards"]
            bridge.boards = {
                board["id"]: board["name"]
                for board in bridge.all_boards
                if board["enabled"] and board["available"]
            }
            bridge.board_order = list(bridge.boards)
            original_board_order = list(bridge.board_order)
            bridge.workspace = root
            bridge.state_dir = root / ".xhs-favorites"
            bridge.config_path = root / "config.json"
            bridge.config_path.write_text(
                json.dumps({"version": 1, "boards": bridge.all_boards}),
                encoding="utf-8",
            )
            original_config = bridge.config_path.read_text(encoding="utf-8")
            bridge.port = 47631
            bridge.profile_url = "https://www.xiaohongshu.com/user/profile/testprofile?tab=fav&subTab=board"
            bridge.open_sop_browser_page = mock.Mock(return_value={"id": "target"})

            with mock.patch.object(BRIDGE.subprocess, "Popen") as popen:
                status = bridge.trigger_manual_sync(fixture["target_request"])

            internal = bridge.read_manual_sync()
            self.assertEqual(status["state"], "starting")
            self.assertEqual(status["board_count"], 1)
            self.assertEqual(internal["requested_board_ids"], fixture["expected_target_scope"])
            self.assertEqual(internal["run_board_ids"], fixture["expected_target_scope"])
            self.assertEqual(internal["run_mode"], fixture["expected_mode"])
            self.assertEqual(bridge.board_order, original_board_order)
            self.assertEqual(bridge.config_path.read_text(encoding="utf-8"), original_config)
            popen.assert_not_called()
            launched = urlparse(bridge.open_sop_browser_page.call_args.args[0])
            self.assertEqual(parse_qs(launched.query)["xhs_kb_mode"], [fixture["expected_mode"]])
            self.assertNotIn("requested_board_ids", status)
            self.assertNotIn("run_board_ids", status)

    def test_single_note_validation_derives_one_source_board_and_keeps_target_private(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "t" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.trigger_lock = BRIDGE.threading.Lock()
            bridge.processing_lock = BRIDGE.threading.Lock()
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.catalog_path = root / "catalog.json"
            bridge.diandian_dir = root / "diandian-summaries"
            bridge.diandian_enabled = True
            bridge.diandian_cdp_enabled = True
            bridge.all_boards = [
                {"id": "eligible", "name": "Eligible", "enabled": True, "available": True, "advertised_count": 3},
                {"id": "disabled", "name": "Disabled", "enabled": False, "available": True, "advertised_count": 2},
            ]
            bridge.boards = {"eligible": "Eligible"}
            bridge.board_order = ["eligible"]
            bridge.workspace = root
            bridge.state_dir = root / ".xhs-favorites"
            bridge.config_path = root / "config.json"
            bridge.config_path.write_text(
                json.dumps({"version": 1, "boards": bridge.all_boards}),
                encoding="utf-8",
            )
            original_config = bridge.config_path.read_bytes()
            bridge.port = 47631
            bridge.profile_url = "https://www.xiaohongshu.com/user/profile/testprofile?tab=fav&subTab=board"
            bridge.open_sop_browser_page = mock.Mock(return_value={"id": "target"})
            BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {
                note_id: {"note_id": note_id, "source_board_ids": ["disabled", "eligible"]},
            }})
            configure_point_v2(bridge, root, [note_id])
            write_point_v2_record(bridge, note_id, "Existing title", "Existing valid summary that must not block a forced rerun.")
            self.assertIsNotNone(bridge.saved_diandian_record(note_id))

            with mock.patch.object(BRIDGE.subprocess, "Popen") as popen:
                public_status = bridge.trigger_manual_sync({"note_id": note_id})

            private_state = bridge.read_manual_sync()
            batch = private_state["batch"]
            popen.assert_not_called()
            launched_url = bridge.open_sop_browser_page.call_args.args[0]
            self.assertEqual(private_state["run_board_ids"], ["eligible"])
            self.assertEqual(private_state["run_mode"], "history")
            self.assertEqual(private_state["target_note_id"], note_id)
            self.assertIs(private_state["local_only"], True)
            self.assertEqual(bridge.board_context(batch, "eligible")["target_note_id"], note_id)
            self.assertNotIn("target_note_id", public_status)
            self.assertNotIn("local_only", public_status)
            self.assertNotIn(note_id, launched_url)
            self.assertNotIn("xhs_kb_open_note", launched_url)
            self.assertNotIn("local_only", launched_url)
            self.assertEqual(parse_qs(urlparse(launched_url).query)["xhs_kb_mode"], ["history"])
            self.assertEqual(bridge.config_path.read_bytes(), original_config)
            self.assertEqual(bridge.board_order, ["eligible"])

    def test_single_note_force_plan_replaces_an_existing_summary_but_batch_plans_still_skip_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "r" * 24
            other_id = "s" * 24
            board_id = "board"
            batch = "manualforce"
            run_id = f"{batch}_{board_id}"
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / ".xhs-favorites"
            bridge.diandian_dir = bridge.state_dir / "diandian-summaries"
            bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.catalog_path = bridge.state_dir / "catalog.json"
            bridge.diandian_enabled = True
            bridge.diandian_cdp_enabled = True
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            bridge.summary_plans = {}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.diandian_save_record = BRIDGE.load_diandian_save_record(
                DIANDIAN_SKILL_SOURCE / "scripts" / "save_diandian_summary.py"
            )
            BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {
                note_id: {"note_id": note_id, "source_board_ids": [board_id]},
                other_id: {"note_id": other_id, "source_board_ids": [board_id]},
            }})
            configure_point_v2(bridge, root, [note_id, other_id])
            write_point_v2_record(bridge, note_id, "Old title", "Old valid summary before an explicit local rerun.")
            self.assertIsNotNone(bridge.saved_diandian_record(note_id))
            self.assertEqual(bridge.single_note_run_target(note_id), (note_id, board_id))
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "running",
                "run_board_ids": [board_id],
                "run_mode": "history",
                "target_note_id": note_id,
                "local_only": True,
                "summary_plan_pending": True,
            })

            plan = bridge.diandian_summary_plan({
                "run_id": run_id,
                "board_id": board_id,
                "note_ids": [note_id],
            })
            self.assertEqual(plan["note_ids"], [note_id])
            saved = bridge.save_diandian_result({
                "run_id": run_id,
                "board_id": board_id,
                "note_id": note_id,
                "title": "New title",
                "summary": "New valid summary atomically replaces the existing record.",
            }, defer_finalization=True)
            self.assertTrue(saved["saved"])
            self.assertEqual(bridge.saved_diandian_record(note_id)["title"], "New title")

            batch_run_id = "manualbatch_board"
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manualbatch",
                "state": "running",
                "run_board_ids": [board_id],
                "run_mode": "history",
                "local_only": False,
                "summary_plan_pending": True,
            })
            bridge.summary_plans = {}
            skipped = bridge.diandian_summary_plan({
                "run_id": batch_run_id,
                "board_id": board_id,
                "note_ids": [note_id, other_id],
            })
            self.assertEqual(skipped["note_ids"], [other_id])

    def test_single_note_validation_rejects_ineligible_requests_before_launch(self):
        note_id = "v" * 24

        def make_bridge(root: Path, *, enabled=True, note=None, saved=False):
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.trigger_lock = BRIDGE.threading.Lock()
            bridge.processing_lock = BRIDGE.threading.Lock()
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.catalog_path = root / "catalog.json"
            bridge.diandian_dir = root / "diandian-summaries"
            bridge.diandian_enabled = enabled
            bridge.diandian_cdp_enabled = enabled
            bridge.all_boards = [
                {"id": "eligible", "name": "Eligible", "enabled": True, "available": True, "advertised_count": 1},
                {"id": "disabled", "name": "Disabled", "enabled": False, "available": True, "advertised_count": 1},
            ]
            bridge.boards = {"eligible": "Eligible"}
            bridge.board_order = ["eligible"]
            bridge.workspace = root
            bridge.state_dir = root / ".xhs-favorites"
            bridge.config_path = root / "config.json"
            bridge.port = 47631
            bridge.profile_url = "https://www.xiaohongshu.com/user/profile/testprofile?tab=fav&subTab=board"
            BRIDGE.atomic_json(bridge.catalog_path, {
                "version": 1,
                "notes": {} if note is None else {note_id: note},
            })
            if saved:
                BRIDGE.atomic_json(bridge.diandian_dir / f"{note_id}.json", {
                    "version": 1,
                    "provider": "xiaohongshu-diandian",
                    "prompt": "总结",
                    "note_id": note_id,
                    "title": "Already complete",
                    "summary": "A current valid saved summary.",
                })
            return bridge

        cases = [
            ("extra-field", True, {"note_id": note_id, "source_board_ids": ["eligible"]}, False, {"note_id": note_id, "unexpected": True}),
            ("null-note-id", True, {"note_id": note_id, "source_board_ids": ["eligible"]}, False, {"note_id": None}),
            ("empty-note-id", True, {"note_id": note_id, "source_board_ids": ["eligible"]}, False, {"note_id": ""}),
            ("traversal-note-id", True, {"note_id": note_id, "source_board_ids": ["eligible"]}, False, {"note_id": "../private"}),
            ("unicode-note-id", True, {"note_id": note_id, "source_board_ids": ["eligible"]}, False, {"note_id": "笔记😀"}),
            ("unknown-note", True, None, False, {"note_id": note_id}),
            ("disabled-diandian", False, {"note_id": note_id, "source_board_ids": ["eligible"]}, False, {"note_id": note_id}),
            ("no-eligible-source", True, {"note_id": note_id, "source_board_ids": ["disabled"]}, False, {"note_id": note_id}),
            ("unstable-membership", True, {"note_id": "different", "source_board_ids": ["eligible"]}, False, {"note_id": note_id}),
        ]
        for name, enabled, note, saved, payload in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                bridge = make_bridge(Path(directory), enabled=enabled, note=note, saved=saved)
                with mock.patch.object(BRIDGE.subprocess, "Popen") as popen, self.assertRaises(ValueError):
                    bridge.trigger_manual_sync(payload)
                popen.assert_not_called()
                self.assertFalse(bridge.manual_sync_path.exists())

        with tempfile.TemporaryDirectory() as directory:
            bridge = make_bridge(
                Path(directory),
                note={"note_id": note_id, "source_board_ids": ["eligible"]},
            )
            bridge.catalog_path.write_text("[]", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "catalog"):
                bridge.trigger_manual_sync({"note_id": note_id})

    def test_single_note_target_is_only_returned_by_authenticated_matching_board_context(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "w" * 24
            token = "a" * 64
            batch = "manualtarget"
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.port = 0
            bridge.token = token
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.all_boards = [
                {"id": "eligible", "name": "Eligible", "enabled": True, "available": True, "advertised_count": 1},
                {"id": "other", "name": "Other", "enabled": True, "available": True, "advertised_count": 1},
            ]
            bridge.boards = {"eligible": "Eligible", "other": "Other"}
            bridge.board_order = ["eligible", "other"]
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "running",
                "run_board_ids": ["eligible"],
                "target_note_id": note_id,
                "local_only": True,
            })
            server = BRIDGE.ThreadingHTTPServer((BRIDGE.HOST, 0), BRIDGE.make_handler(bridge))
            bridge.port = server.server_address[1]
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            def get(board_id, supplied_token):
                request = Request(
                    f"http://{BRIDGE.HOST}:{bridge.port}/sync/board-context?batch={batch}&board_id={board_id}",
                    headers={"X-XHS-Bridge-Token": supplied_token},
                )
                try:
                    with urlopen(request, timeout=2) as response:
                        return response.status, json.loads(response.read().decode("utf-8"))
                except HTTPError as error:
                    return error.code, json.loads(error.read().decode("utf-8"))

            try:
                status, body = get("eligible", token)
                self.assertEqual(status, BRIDGE.HTTPStatus.OK)
                self.assertEqual(body["board"]["target_note_id"], note_id)
                self.assertNotIn("local_only", body["board"])
                self.assertEqual(get("eligible", "b" * 64), (BRIDGE.HTTPStatus.NOT_FOUND, {"ok": False}))
                wrong_status, wrong_body = get("other", token)
                self.assertEqual(wrong_status, BRIDGE.HTTPStatus.BAD_REQUEST)
                self.assertNotIn(note_id, json.dumps(wrong_body))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_single_note_import_rejects_other_or_extra_notes_before_run_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target_id = "a" * 24
            other_id = "b" * 24
            batch = "manualtarget"
            board_id = "board"
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            run_id = bridge.manual_run_id(batch, board_id)
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "running",
                "run_board_ids": [board_id],
                "run_mode": "history",
                "target_note_id": target_id,
                "local_only": True,
            })
            original_state = bridge.manual_sync_path.read_bytes()

            for urls in (
                [f"https://www.xiaohongshu.com/explore/{other_id}"],
                [
                    f"https://www.xiaohongshu.com/explore/{target_id}",
                    f"https://www.xiaohongshu.com/explore/{other_id}",
                ],
            ):
                with self.subTest(urls=len(urls)), self.assertRaisesRegex(ValueError, "target"):
                    bridge.prepare_import({
                        "run_id": run_id,
                        "board_id": board_id,
                        "urls": urls,
                    })
                self.assertEqual(bridge.manual_sync_path.read_bytes(), original_state)

            accepted_run_id, accepted = bridge.prepare_import({
                "run_id": run_id,
                "board_id": board_id,
                "urls": [f"https://www.xiaohongshu.com/explore/{target_id}"],
            })
            self.assertEqual(accepted_run_id, run_id)
            self.assertEqual(set(accepted), {target_id})

    def test_single_note_summary_plan_rejects_mismatches_and_allows_safe_empty_abandonment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target_id = "c" * 24
            other_id = "d" * 24
            batch = "manualtarget"
            board_id = "board"
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            bridge.summary_plans = {}
            bridge.saved_diandian_record = mock.Mock()
            bridge.record_diandian_succeeded_batch = mock.Mock()
            run_id = bridge.manual_run_id(batch, board_id)
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "running",
                "run_board_ids": [board_id],
                "run_mode": "history",
                "target_note_id": target_id,
                "local_only": True,
                "summary_plan_pending": True,
            })
            BRIDGE.atomic_json(root / "runs" / f"{run_id}.json", {
                "run_id": run_id,
                "state": "completed",
                "completed_at": "2026-08-13T01:02:03+00:00",
                "next_board_id": None,
            })
            original_state = bridge.manual_sync_path.read_bytes()

            for note_ids in ([other_id], [target_id, other_id]):
                with self.subTest(note_ids=len(note_ids)), self.assertRaisesRegex(ValueError, "target"):
                    bridge.diandian_summary_plan({
                        "run_id": run_id,
                        "board_id": board_id,
                        "note_ids": note_ids,
                    })
                self.assertEqual(bridge.summary_plans, {})
                self.assertEqual(bridge.manual_sync_path.read_bytes(), original_state)
                bridge.saved_diandian_record.assert_not_called()
                bridge.record_diandian_succeeded_batch.assert_not_called()

            abandoned = bridge.diandian_summary_plan({
                "run_id": run_id,
                "board_id": board_id,
                "note_ids": [],
            })
            self.assertEqual(abandoned, {
                "enabled": False,
                "note_ids": [],
                "abandoned": True,
            })
            self.assertEqual(bridge.summary_plans, {})
            bridge.saved_diandian_record.assert_not_called()
            bridge.record_diandian_succeeded_batch.assert_not_called()
            resolved = bridge.read_manual_sync()
            self.assertEqual(resolved["state"], "completed")
            self.assertFalse(resolved["summary_plan_pending"])

    def test_manual_organization_rejects_invalid_one_time_scopes_before_launch(self):
        fixture = json.loads(
            (Path(__file__).parents[1] / "test-fixtures" / "single-board-run-scope.json")
            .read_text(encoding="utf-8")
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.trigger_lock = BRIDGE.threading.Lock()
            bridge.processing_lock = BRIDGE.threading.Lock()
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.all_boards = fixture["configured_boards"]
            bridge.boards = {
                board["id"]: board["name"]
                for board in bridge.all_boards
                if board["enabled"] and board["available"]
            }
            bridge.board_order = list(bridge.boards)
            bridge.workspace = root
            bridge.config_path = root / "config.json"
            bridge.port = 47631
            bridge.profile_url = "https://www.xiaohongshu.com/user/profile/testprofile?tab=fav&subTab=board"

            with mock.patch.object(BRIDGE.subprocess, "Popen") as popen:
                for payload in fixture["invalid_requests"]:
                    with self.subTest(payload=payload), self.assertRaises(ValueError):
                        bridge.trigger_manual_sync(payload)

            self.assertFalse(popen.called)
            self.assertFalse(bridge.manual_sync_path.exists())

    def test_manual_scope_http_route_requires_manager_token_and_origin(self):
        fixture = json.loads(
            (Path(__file__).parents[1] / "test-fixtures" / "single-board-run-scope.json")
            .read_text(encoding="utf-8")
        )
        token = "a" * 64
        bridge = SimpleNamespace(
            port=0,
            token=token,
            trigger_manual_sync=mock.Mock(return_value={"state": "starting", "board_count": 1}),
        )
        server = BRIDGE.ThreadingHTTPServer((BRIDGE.HOST, 0), BRIDGE.make_handler(bridge))
        bridge.port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def post(*, supplied_token=token, origin=BRIDGE.MANAGER_ORIGIN):
            request = Request(
                f"http://{BRIDGE.HOST}:{bridge.port}/sync/start",
                data=json.dumps(fixture["target_request"]).encode("utf-8"),
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
            self.assertEqual(body, {"ok": True, "state": "starting", "board_count": 1})
            bridge.trigger_manual_sync.assert_called_once_with(fixture["target_request"])

            bridge.trigger_manual_sync.reset_mock()
            for status, body in (
                post(supplied_token="b" * 64),
                post(origin="https://attacker.invalid"),
            ):
                self.assertEqual(status, BRIDGE.HTTPStatus.UNAUTHORIZED)
                self.assertEqual(body, {"ok": False})
            bridge.trigger_manual_sync.assert_not_called()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_cdp_summary_http_route_is_authenticated_and_forwards_only_the_exact_transient_payload(self):
        token = "a" * 64
        note_id = "z" * 24
        payload = {
            "run_id": "manual_board",
            "board_id": "board",
            "note_id": note_id,
            "title": "Title",
            "url": f"https://www.xiaohongshu.com/discovery/item/{note_id}?xsec_token=private",
        }
        bridge = SimpleNamespace(
            port=0,
            token=token,
            run_diandian_cdp=mock.Mock(return_value={
                "saved": True,
                "halted": False,
                "plan_complete": False,
                "finalization_started": False,
            }),
        )
        server = BRIDGE.ThreadingHTTPServer((BRIDGE.HOST, 0), BRIDGE.make_handler(bridge))
        bridge.port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def post(supplied_token):
            request = Request(
                f"http://{BRIDGE.HOST}:{bridge.port}/sync/diandian-cdp",
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Content-Type": "application/json",
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
            status, body = post(token)
            self.assertEqual(status, BRIDGE.HTTPStatus.OK)
            self.assertTrue(body["saved"])
            bridge.run_diandian_cdp.assert_called_once_with(payload)
            self.assertEqual(post("b" * 64), (BRIDGE.HTTPStatus.UNAUTHORIZED, {"ok": False}))
            bridge.run_diandian_cdp.assert_called_once()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_targeted_discovery_and_restart_keep_navigation_inside_the_frozen_scope(self):
        fixture = json.loads(
            (Path(__file__).parents[1] / "test-fixtures" / "single-board-run-scope.json")
            .read_text(encoding="utf-8")
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "config.json"
            config_path.write_text(
                json.dumps({"version": 1, "boards": fixture["configured_boards"]}),
                encoding="utf-8",
            )
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.config_path = config_path
            bridge.catalog_path = root / "catalog.json"
            bridge.userscript = root / "installed.user.js"
            bridge.userscript_template = root / "template.user.js"
            bridge.userscript_template.write_text(
                "__PORT__ __TOKEN__ __INSTALL_CAPABILITY__ __BOARDS__",
                encoding="utf-8",
            )
            bridge.port = 47631
            bridge.token = "a" * 64
            bridge.install_capability = "c" * 64
            bridge.processing_lock = BRIDGE.threading.Lock()
            bridge.manual_sync_path = root / "manual.json"
            batch = "manualtarget"
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "starting",
                "requested_board_ids": fixture["expected_target_scope"],
                "run_board_ids": fixture["expected_target_scope"],
                "run_mode": fixture["expected_mode"],
                "processed_run_ids": [],
            })
            config = json.loads(config_path.read_text(encoding="utf-8"))
            bridge.all_boards, bridge.boards = bridge.normalize_boards(config)
            bridge.board_order = list(bridge.boards)

            active = bridge.discover_boards({"batch": batch, "boards": [
                {"id": "boardalpha", "name": "Alpha renamed", "advertised_count": 13},
                {"id": "boardbeta", "name": "Beta", "advertised_count": 4},
                {"id": "boardnew", "name": "New", "advertised_count": 2},
            ]})

            self.assertEqual([item["id"] for item in active], fixture["expected_target_scope"])
            state = bridge.read_manual_sync()
            self.assertEqual(state["run_board_ids"], fixture["expected_target_scope"])
            self.assertEqual(state["board_count"], 1)
            saved = json.loads(config_path.read_text(encoding="utf-8"))
            enabled_by_id = {board["id"]: board["enabled"] for board in saved["boards"]}
            self.assertTrue(enabled_by_id["boardalpha"])
            self.assertTrue(enabled_by_id["boardbeta"])
            self.assertFalse(enabled_by_id["boarddisabled"])
            self.assertTrue(enabled_by_id["boardnew"])

            restarted = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            restarted.manual_sync_path = bridge.manual_sync_path
            restarted.all_boards = list(bridge.all_boards)
            restarted.boards = dict(bridge.boards)
            restarted.board_order = list(bridge.board_order)
            target = fixture["expected_target_scope"][0]
            context = restarted.board_context(batch, target)
            self.assertEqual(context["id"], target)
            run_id = restarted.manual_run_id(batch, target)
            self.assertIsNone(restarted.next_board_id(target, run_id))
            with self.assertRaisesRegex(ValueError, "scope"):
                restarted.board_context(batch, "boardbeta")
            with self.assertRaisesRegex(ValueError, "scope"):
                restarted.validate_manual_board_run(
                    restarted.manual_run_id(batch, "boardbeta"),
                    "boardbeta",
                )
            with self.assertRaisesRegex(ValueError, "scope"):
                restarted.record_manual_failure({
                    "run_id": restarted.manual_run_id(batch, "boardbeta"),
                    "board_id": "boardbeta",
                    "error": "unrelated board failure",
                })
            self.assertEqual(restarted.read_manual_sync()["state"], "running")

    def test_single_note_discovery_confirms_scope_without_mutating_board_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "config.json"
            configured_boards = [
                {"id": "target", "name": "Configured name", "enabled": True, "available": True, "advertised_count": 1},
                {"id": "other", "name": "Other", "enabled": True, "available": True, "advertised_count": 2},
            ]
            config_path.write_text(
                json.dumps({"version": 1, "boards": configured_boards}),
                encoding="utf-8",
            )
            original_config = config_path.read_bytes()
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.config_path = config_path
            bridge.catalog_path = root / "catalog.json"
            bridge.processing_lock = threading.Lock()
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.all_boards, bridge.boards = bridge.normalize_boards({
                "version": 1,
                "boards": configured_boards,
            })
            bridge.board_order = list(bridge.boards)
            bridge.userscript = root / "installed.user.js"
            bridge.userscript_template = root / "template.user.js"
            bridge.userscript_template.write_text(
                "__DIANDIAN_MATCH_LINE__ __PORT__ __TOKEN__ __INSTALL_CAPABILITY__ __BOARDS__ __DIANDIAN_CONTRACT__",
                encoding="utf-8",
            )
            bridge.port = 47631
            bridge.token = "a" * 64
            bridge.install_capability = "b" * 64
            bridge.diandian_browser_contract = {"enabled": False}
            batch = "manualvalidation"
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "starting",
                "requested_board_ids": ["target"],
                "run_board_ids": ["target"],
                "run_mode": "history",
                "target_note_id": "n" * 24,
                "local_only": True,
                "processed_run_ids": [],
            })

            active = bridge.discover_boards({"batch": batch, "boards": [
                {"id": "target", "name": "Live renamed name", "advertised_count": 99},
                {"id": "newboard", "name": "New board", "advertised_count": 3},
            ]})

            self.assertEqual(active, [{"id": "target", "name": "Configured name"}])
            self.assertEqual(config_path.read_bytes(), original_config)
            self.assertEqual(bridge.board_order, ["target", "other"])
            self.assertEqual([board["name"] for board in bridge.all_boards], ["Configured name", "Other"])
            state = bridge.read_manual_sync()
            self.assertEqual(state["run_board_ids"], ["target"])
            self.assertEqual(state["target_note_id"], "n" * 24)
            self.assertIs(state["local_only"], True)

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

    def test_manual_organization_terminal_state_ignores_late_failure_and_rejects_start(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "Board"}
            bridge.board_order = ["board"]
            bridge.summary_plans = {}
            batch = "manualterminal"
            run_id = bridge.manual_run_id(batch, "board")
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "running",
                "run_board_ids": ["board"],
                "processed_run_ids": [],
                "scanned": 0,
                "new": 0,
            })

            bridge.record_manual_result(run_id, "board", {
                "state": "completed",
                "scanned": 1,
                "new": 1,
                "next_board_id": None,
            })
            completed = bridge.read_manual_sync()
            bridge.record_manual_failure({
                "run_id": run_id,
                "board_id": "board",
                "error": "late client timeout",
            })
            with self.assertRaisesRegex(ValueError, "batch"):
                bridge.record_manual_started(run_id, "board")

            self.assertEqual(bridge.read_manual_sync(), completed)

    def test_active_processing_cannot_be_terminalized_by_client_failure_or_timeout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.processing_lock = threading.Lock()
            bridge.boards = {"board": "Board"}
            bridge.board_order = ["board"]
            bridge.summary_plans = {}
            batch = "manualactive"
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
            bridge.processing_lock.acquire()
            try:
                status = bridge.record_manual_failure({
                    "run_id": run_id,
                    "board_id": "board",
                    "error": "late browser timeout",
                })
                self.assertEqual(status["state"], "running")
                self.assertEqual(bridge.manual_sync_status()["state"], "running")
                self.assertEqual(bridge.read_manual_sync()["state"], "running")
            finally:
                bridge.processing_lock.release()

            self.assertEqual(bridge.manual_sync_status()["state"], "failed")

    def test_manual_organization_failure_is_not_overwritten_by_late_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "Board"}
            bridge.board_order = ["board"]
            bridge.summary_plans = {}
            batch = "manualterminal"
            run_id = bridge.manual_run_id(batch, "board")
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "running",
                "run_board_ids": ["board"],
                "processed_run_ids": [],
                "scanned": 0,
                "new": 0,
            })

            bridge.record_manual_failure({
                "run_id": run_id,
                "board_id": "board",
                "error": "collection failed",
            })
            failed = bridge.read_manual_sync()
            bridge.record_manual_result(run_id, "board", {
                "state": "completed",
                "scanned": 1,
                "new": 1,
                "next_board_id": None,
            })

            self.assertEqual(bridge.read_manual_sync(), failed)

    def test_manual_organization_safety_stop_is_terminal_and_keeps_partial_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "Board"}
            bridge.board_order = ["board"]
            bridge.summary_plans = {}
            batch = "manualsafety"
            run_id = bridge.manual_run_id(batch, "board")
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "running",
                "run_board_ids": ["board"],
                "processed_run_ids": [],
                "scanned": 0,
                "new": 0,
            })

            bridge.record_manual_result(run_id, "board", {
                "state": "safety-stopped",
                "scanned": 3,
                "new": 1,
            })
            stopped = bridge.read_manual_sync()
            bridge.record_manual_failure({
                "run_id": run_id,
                "board_id": "board",
                "error": "late transport failure",
            })

            self.assertEqual(stopped["state"], "safety-stopped")
            self.assertEqual(stopped["scanned"], 3)
            self.assertEqual(stopped["new"], 1)
            self.assertEqual(bridge.read_manual_sync(), stopped)

    def test_lost_core_response_cannot_fail_a_processed_run_waiting_for_summary_plan(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.boards = {"board": "Board"}
            bridge.board_order = ["board"]
            bridge.diandian_enabled = True
            bridge.summary_plans = {}
            batch = "manualresponse"
            run_id = bridge.manual_run_id(batch, "board")
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "running",
                "run_board_ids": ["board"],
                "processed_run_ids": [],
                "scanned": 0,
                "new": 0,
            })

            bridge.record_manual_result(run_id, "board", {
                "state": "completed",
                "scanned": 1,
                "new": 1,
                "next_board_id": None,
            })
            waiting = bridge.read_manual_sync()
            self.assertEqual(waiting["state"], "running")
            self.assertTrue(waiting["summary_plan_pending"])

            bridge.record_manual_failure({
                "run_id": run_id,
                "board_id": "board",
                "error": "client lost the completed response",
            })
            bridge.record_manual_started(run_id, "board")

            self.assertEqual(bridge.read_manual_sync(), waiting)

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

    def test_manual_organization_running_state_expires_and_can_be_restarted(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.trigger_lock = BRIDGE.threading.Lock()
            bridge.processing_lock = BRIDGE.threading.Lock()
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.board_order = ["first"]
            bridge.boards = {"first": "First"}
            bridge.workspace = root
            bridge.state_dir = root / ".xhs-favorites"
            bridge.config_path = root / "config.json"
            bridge.port = 47631
            bridge.profile_url = "https://www.xiaohongshu.com/user/profile/testprofile?tab=fav&subTab=board"
            bridge.open_sop_browser_page = mock.Mock(return_value={"id": "target"})
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual-stale",
                "state": "running",
                "started_at": "2000-01-01T00:00:00+00:00",
                "processed_run_ids": ["manual-stale_first"],
                "board_count": 2,
                "processed_boards": 1,
            })

            expired = bridge.manual_sync_status()

            self.assertEqual(expired["state"], "failed")
            self.assertIn("重新点击", expired["error"])
            with mock.patch.object(BRIDGE.subprocess, "Popen") as popen:
                restarted = bridge.trigger_manual_sync()

            self.assertEqual(restarted["state"], "starting")
            popen.assert_not_called()
            bridge.open_sop_browser_page.assert_called_once()

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

    def test_discovery_renames_existing_boards_adds_new_boards_and_keeps_history(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config_path = root / "config.json"
            config_path.write_text(json.dumps({"version": 1, "boards": [
                {"id": "first", "name": "Old name", "enabled": True},
                {"id": "missing", "name": "Historical", "enabled": True},
            ]}), encoding="utf-8")
            catalog_path = root / "catalog.json"
            catalog_path.write_text(json.dumps({"version": 1, "notes": {
                "note": {"source_board_ids": ["first"], "source_boards": ["Old name"]},
            }}), encoding="utf-8")
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.config_path = config_path
            bridge.catalog_path = catalog_path
            bridge.userscript = root / "installed.user.js"
            bridge.userscript_template = root / "template.user.js"
            bridge.userscript_template.write_text("__PORT__ __TOKEN__ __BOARDS__", encoding="utf-8")
            bridge.port = 47631
            bridge.token = "a" * 64
            bridge.install_capability = "c" * 64
            bridge.processing_lock = BRIDGE.threading.Lock()
            bridge.manual_sync_path = root / "manual.json"
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manualbatch", "state": "starting", "processed_run_ids": [],
            })
            config = json.loads(config_path.read_text(encoding="utf-8"))
            bridge.all_boards, bridge.boards = bridge.normalize_boards(config)
            bridge.board_order = list(bridge.boards)

            active = bridge.discover_boards({"batch": "manualbatch", "boards": [
                {"id": "first", "name": "New name", "advertised_count": 12},
                {"id": "newboard", "name": "New board", "advertised_count": 3},
            ]})

            saved = json.loads(config_path.read_text(encoding="utf-8"))
            by_id = {item["id"]: item for item in saved["boards"]}
            self.assertEqual(by_id["first"]["name"], "New name")
            self.assertTrue(by_id["newboard"]["enabled"])
            self.assertFalse(by_id["missing"]["available"])
            self.assertEqual([item["name"] for item in active], ["New name", "New board"])
            catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
            self.assertEqual(catalog["notes"]["note"]["source_boards"], ["New name"])

    def test_discovery_never_overwrites_a_terminal_or_replacement_manual_state(self):
        replacements = [
            {
                "batch": "manualbatch",
                "state": "failed",
                "error": "a concurrent failure won the run",
            },
            {
                "batch": "manualreplacement",
                "state": "running",
                "current_board": "Replacement",
            },
        ]
        for replacement in replacements:
            with self.subTest(replacement=replacement), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config_path = root / "config.json"
                config_path.write_text(json.dumps({"version": 1, "boards": [
                    {"id": "first", "name": "First", "enabled": True},
                ]}), encoding="utf-8")
                bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
                bridge.config_path = config_path
                bridge.catalog_path = root / "catalog.json"
                bridge.userscript = root / "installed.user.js"
                bridge.userscript_template = root / "template.user.js"
                bridge.userscript_template.write_text(
                    "__PORT__ __TOKEN__ __INSTALL_CAPABILITY__ __BOARDS__",
                    encoding="utf-8",
                )
                bridge.port = 47631
                bridge.token = "a" * 64
                bridge.install_capability = "c" * 64
                bridge.processing_lock = threading.Lock()
                bridge.manual_sync_path = root / "manual.json"
                BRIDGE.atomic_json(bridge.manual_sync_path, {
                    "batch": "manualbatch",
                    "state": "starting",
                    "processed_run_ids": [],
                })
                config = json.loads(config_path.read_text(encoding="utf-8"))
                bridge.all_boards, bridge.boards = bridge.normalize_boards(config)
                bridge.board_order = list(bridge.boards)

                def replace_manual_state(_renamed):
                    with bridge.get_manual_sync_lock():
                        BRIDGE.atomic_json(bridge.manual_sync_path, replacement)

                bridge.update_catalog_board_names = replace_manual_state
                with self.assertRaisesRegex(ValueError, "discovery|batch"):
                    bridge.discover_boards({"batch": "manualbatch", "boards": [
                        {"id": "first", "name": "First", "advertised_count": 1},
                    ]})

                self.assertEqual(bridge.read_manual_sync(), replacement)

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

    def test_enabled_video_analysis_waits_for_bounded_platform_result(self):
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
            completed = SimpleNamespace(
                returncode=0,
                stdout=json.dumps({"queued": 1, "downloaded": 1, "safety_stopped": False}),
                stderr="",
            )
            with mock.patch.object(BRIDGE, "run_bounded_subprocess", return_value=completed) as run:
                result = bridge.cache_missing_media({
                    "a" * 24: "https://www.xiaohongshu.com/explore/" + "a" * 24
                })
            self.assertEqual(result["state"], "completed")
            self.assertEqual(result["downloaded"], 1)
            run.assert_called_once()
            command = run.call_args.args[0]
            self.assertIn(str(bridge.state_dir / "platform-request.lock"), command)
            self.assertEqual(
                run.call_args.kwargs["input_text"],
                "https://www.xiaohongshu.com/explore/" + "a" * 24,
            )

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
            "notes": [{"note_id": "ok", "detail_fetched": True, "comment_evidence_checked": True}],
            "failures": [{"note_id": "gone", "reason": "detail unavailable"}],
        }), {"ok", "gone"})
        self.assertEqual([note["note_id"] for note in notes], ["ok"])
        self.assertEqual(failures[0]["note_id"], "gone")

    def test_fetch_payload_contract_accepts_safety_stop_and_rejects_unknown_fields(self):
        notes, failures = BRIDGE.parse_fetch_payload(json.dumps({
            "notes": [{"note_id": "ok", "detail_fetched": True, "comment_evidence_checked": True, "title": "bounded"}],
            "failures": [{"note_id": "later", "reason": "safety stop"}],
        }), {"ok", "later"})
        self.assertEqual(notes[0]["note_id"], "ok")
        self.assertEqual(failures[0]["reason"], "safety stop")

        with self.assertRaisesRegex(ValueError, "invalid notes"):
            BRIDGE.parse_fetch_payload(json.dumps({
                "notes": [{"note_id": "ok", "detail_fetched": True, "comment_evidence_checked": True, "unexpected": "x"}],
                "failures": [],
            }), {"ok"})
        with self.assertRaisesRegex(ValueError, "invalid notes"):
            BRIDGE.parse_fetch_payload(json.dumps({
                "notes": [{"note_id": "ok", "detail_fetched": True, "comment_evidence_checked": True, "title": "x" * 501}],
                "failures": [],
            }), {"ok"})
        with self.assertRaisesRegex(ValueError, "invalid payload"):
            BRIDGE.parse_fetch_payload(json.dumps({
                "notes": [], "failures": [], "xsec_token": "must-never-cross-the-boundary",
            }), set())
        with self.assertRaisesRegex(ValueError, "invalid payload"):
            BRIDGE.parse_fetch_payload(json.dumps({"notes": []}), set())
        with self.assertRaisesRegex(ValueError, "invalid notes"):
            BRIDGE.parse_fetch_payload(json.dumps({
                "notes": [{"note_id": "ok"}], "failures": [],
            }), {"ok"})

    def test_detail_subprocess_enforces_stdout_and_stderr_limits_before_exit(self):
        for stream_name in ("stdout", "stderr"):
            with self.subTest(stream=stream_name):
                source = (
                    "import sys,time; "
                    f"sys.{stream_name}.buffer.write(b'x' * 4096); "
                    f"sys.{stream_name}.flush(); time.sleep(10)"
                )
                started = time.monotonic()
                with self.assertRaisesRegex(ValueError, "output limit"):
                    BRIDGE.run_bounded_subprocess(
                        [sys.executable, "-c", source],
                        input_text="",
                        cwd=Path.cwd(),
                        env=None,
                        timeout=5,
                        stdout_limit=1024,
                        stderr_limit=1024,
                    )
                self.assertLess(time.monotonic() - started, 4)

    def test_detail_subprocess_timeout_kills_and_reaps_the_child(self):
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            BRIDGE.run_bounded_subprocess(
                [sys.executable, "-c", "import time; time.sleep(10)"],
                input_text="",
                cwd=Path.cwd(),
                env=None,
                timeout=0.1,
                stdout_limit=1024,
                stderr_limit=1024,
            )
        self.assertLess(time.monotonic() - started, 4)

    def test_detail_subprocess_descendant_cannot_hold_pipes_past_deadline(self):
        source = (
            "import subprocess,sys; "
            "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(10)'])"
        )
        started = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            BRIDGE.run_bounded_subprocess(
                [sys.executable, "-c", source],
                input_text="",
                cwd=Path.cwd(),
                env=None,
                timeout=0.2,
                stdout_limit=1024,
                stderr_limit=1024,
            )
        self.assertLess(time.monotonic() - started, 2)

    def test_terminal_manual_runs_reject_late_import_before_processing(self):
        for terminal_state in ("completed", "failed", "safety-stopped"):
            with self.subTest(state=terminal_state), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
                bridge.state_dir = root / "state"
                bridge.status_path = bridge.state_dir / "bridge-status.json"
                bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
                bridge.processing_lock = threading.Lock()
                bridge.boards = {"board": "Board"}
                bridge.board_order = ["board"]
                bridge.summary_plans = {}
                batch = "manualterminal"
                run_id = bridge.manual_run_id(batch, "board")
                BRIDGE.atomic_json(bridge.manual_sync_path, {
                    "batch": batch,
                    "state": terminal_state,
                    "run_board_ids": ["board"],
                    "processed_run_ids": [],
                })
                original_state = bridge.manual_sync_path.read_bytes()
                bridge.process_import = mock.Mock()

                with (
                    mock.patch.object(BRIDGE, "run_bounded_subprocess") as fetch,
                    mock.patch.object(BRIDGE.subprocess, "run") as child,
                    self.assertRaisesRegex(ValueError, "batch"),
                ):
                    bridge.import_sync({
                        "run_id": run_id,
                        "board_id": "board",
                        "urls": ["https://www.xiaohongshu.com/explore/" + "a" * 24],
                    })

                bridge.process_import.assert_not_called()
                fetch.assert_not_called()
                child.assert_not_called()
                self.assertEqual(bridge.manual_sync_path.read_bytes(), original_state)

    def test_import_rechecks_manual_state_after_prepare_before_processing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root / "state"
            bridge.status_path = bridge.state_dir / "bridge-status.json"
            bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
            bridge.processing_lock = threading.Lock()
            bridge.boards = {"board": "Board"}
            bridge.board_order = ["board"]
            bridge.summary_plans = {}
            batch = "manualrace"
            run_id = bridge.manual_run_id(batch, "board")
            terminal = {
                "batch": batch,
                "state": "failed",
                "run_board_ids": ["board"],
                "processed_run_ids": [],
                "error": "late terminal transition",
            }

            def prepare(_payload):
                BRIDGE.atomic_json(bridge.manual_sync_path, terminal)
                return run_id, {"a" * 24: "https://www.xiaohongshu.com/explore/" + "a" * 24}

            bridge.prepare_import = mock.Mock(side_effect=prepare)
            bridge.process_import = mock.Mock()
            with self.assertRaisesRegex(ValueError, "batch"):
                bridge.import_sync({"run_id": run_id, "board_id": "board", "urls": ["unused"]})

            bridge.process_import.assert_not_called()
            self.assertEqual(bridge.read_manual_sync(), terminal)

    def test_no_pending_import_commits_local_generation_before_media_and_rolls_back_failure(self):
        for generation_fails in (True, False):
            with self.subTest(generation_fails=generation_fails), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                note_id = "a" * 24
                bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
                bridge.workspace = root
                bridge.state_dir = root / ".xhs-favorites"
                bridge.status_path = bridge.state_dir / "bridge-status.json"
                bridge.catalog_path = root / "catalog.json"
                bridge.boards = {"board": "Board"}
                bridge.board_order = ["board"]
                bridge.published_since = None
                bridge.next_board_id = mock.Mock(return_value=None)
                bridge.publish_after_board = mock.Mock(return_value=None)
                BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {
                    note_id: {
                        "note_id": note_id,
                        "comment_evidence_checked": True,
                        "source_board_ids": [],
                        "source_boards": [],
                    },
                }})
                original_catalog = bridge.catalog_path.read_bytes()
                events = []
                original_tag = bridge.tag_catalog_sources

                def tag_sources(board_id, note_ids):
                    events.append("tag")
                    original_tag(board_id, note_ids)

                def rebuild():
                    events.append("knowledge")
                    if generation_fails:
                        raise RuntimeError("injected generation failure")

                bridge.tag_catalog_sources = tag_sources
                bridge.rebuild_knowledge_base = rebuild
                bridge.cache_missing_media = mock.Mock(
                    side_effect=lambda _candidates: events.append("media") or {"state": "disabled"}
                )

                bridge.process_import("manual_board", "board", {
                    note_id: f"https://www.xiaohongshu.com/explore/{note_id}",
                })

                result = json.loads(
                    (bridge.state_dir / "runs" / "manual_board.json").read_text(encoding="utf-8")
                )
                if generation_fails:
                    self.assertEqual(result["state"], "failed")
                    self.assertEqual(bridge.catalog_path.read_bytes(), original_catalog)
                    self.assertEqual(events, ["tag", "knowledge"])
                    bridge.cache_missing_media.assert_not_called()
                else:
                    self.assertEqual(result["state"], "completed")
                    self.assertEqual(events, ["tag", "knowledge", "media"])
                    saved = json.loads(bridge.catalog_path.read_text(encoding="utf-8"))
                    self.assertEqual(saved["notes"][note_id]["source_board_ids"], ["board"])

    def test_import_counts_only_ids_that_were_not_already_in_the_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old_id = "o" * 24
            new_id = "n" * 24
            failed_id = "f" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.workspace = root
            bridge.state_dir = root / ".xhs-favorites"
            bridge.status_path = bridge.state_dir / "bridge-status.json"
            bridge.catalog_path = root / "catalog.json"
            bridge.python = Path("python")
            bridge.fetcher = Path("fetch-xhs-details.py")
            bridge.xhs_dir = root / "xhs"
            bridge.organizer = Path("organize-favorites.mjs")
            bridge.boards = {"board": "Board"}
            bridge.board_order = ["board"]
            bridge.published_since = None
            events = []
            bridge.cache_missing_media = mock.Mock(
                side_effect=lambda _candidates: events.append("media") or {"state": "disabled"}
            )
            bridge.tag_catalog_sources = mock.Mock()
            bridge.rebuild_knowledge_base = mock.Mock(
                side_effect=lambda: events.append("knowledge")
            )
            bridge.next_board_id = mock.Mock(return_value=None)
            bridge.publish_after_board = mock.Mock(return_value=None)
            BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {
                old_id: {"note_id": old_id, "comment_evidence_checked": False},
            }})
            fetch_payload = json.dumps({
                "notes": [
                    {"note_id": old_id, "detail_fetched": True, "comment_evidence_checked": True},
                    {"note_id": new_id, "detail_fetched": True, "comment_evidence_checked": True},
                ],
                "failures": [{"note_id": failed_id, "reason": "request failed"}],
            })
            completed = SimpleNamespace(returncode=0, stdout=fetch_payload, stderr="")
            organized = SimpleNamespace(returncode=0, stdout="", stderr="")

            def fetch_process(*_args, **_kwargs):
                events.append("fetch")
                return completed

            def run_process(*_args, **_kwargs):
                events.append("organizer")
                return organized

            with (
                mock.patch.object(BRIDGE, "run_bounded_subprocess", side_effect=fetch_process),
                mock.patch.object(BRIDGE.subprocess, "run", side_effect=run_process),
            ):
                bridge.process_import("manual_board", "board", {
                    old_id: f"https://www.xiaohongshu.com/explore/{old_id}",
                    new_id: f"https://www.xiaohongshu.com/explore/{new_id}",
                    failed_id: f"https://www.xiaohongshu.com/explore/{failed_id}",
                })

            result = json.loads(
                (bridge.state_dir / "runs" / "manual_board.json").read_text(encoding="utf-8")
            )
            self.assertEqual(result["state"], "completed")
            self.assertEqual(result["new"], 1)
            self.assertEqual(result["skipped"], 1)
            self.assertEqual(events, ["fetch", "organizer", "knowledge", "media"])

    def test_import_restores_catalog_and_report_when_local_generation_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old_id = "o" * 24
            new_id = "n" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.workspace = root
            bridge.state_dir = root / ".xhs-favorites"
            bridge.status_path = bridge.state_dir / "bridge-status.json"
            bridge.catalog_path = root / "catalog.json"
            bridge.python = Path("python")
            bridge.fetcher = Path("fetch-xhs-details.py")
            bridge.xhs_dir = root / "xhs"
            bridge.organizer = Path("organize-favorites.mjs")
            bridge.boards = {"board": "Board"}
            bridge.board_order = ["board"]
            bridge.published_since = None
            bridge.cache_missing_media = mock.Mock()
            bridge.tag_catalog_sources = mock.Mock()
            bridge.rebuild_knowledge_base = mock.Mock(side_effect=RuntimeError("injected generation failure"))
            bridge.next_board_id = mock.Mock(return_value=None)
            bridge.publish_after_board = mock.Mock(return_value=None)
            BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {
                old_id: {"note_id": old_id, "comment_evidence_checked": True},
            }})
            original_catalog = bridge.catalog_path.read_bytes()
            report = root / "xhs-favorites" / f"{BRIDGE.datetime.now().astimezone():%Y-%m-%d}.md"
            report.parent.mkdir(parents=True)
            report.write_bytes(b"previous-report")
            fetch_result = SimpleNamespace(
                returncode=0,
                stdout=json.dumps({
                    "notes": [{"note_id": new_id, "detail_fetched": True, "comment_evidence_checked": True}],
                    "failures": [],
                }),
                stderr="",
            )
            def run_process(*_args, **_kwargs):
                BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {
                    old_id: {"note_id": old_id},
                    new_id: {"note_id": new_id},
                }})
                report.write_bytes(b"partial-new-report")
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            with (
                mock.patch.object(BRIDGE, "run_bounded_subprocess", return_value=fetch_result),
                mock.patch.object(BRIDGE.subprocess, "run", side_effect=run_process),
            ):
                bridge.process_import("manual_board", "board", {
                    new_id: f"https://www.xiaohongshu.com/explore/{new_id}",
                })

            result = json.loads(
                (bridge.state_dir / "runs" / "manual_board.json").read_text(encoding="utf-8")
            )
            self.assertEqual(result["state"], "failed")
            self.assertEqual(bridge.catalog_path.read_bytes(), original_catalog)
            self.assertEqual(report.read_bytes(), b"previous-report")
            bridge.cache_missing_media.assert_not_called()

    def test_import_safety_stop_keeps_fetched_metadata_local_and_stops_follow_up_work(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fetched_id = "a" * 24
            stopped_id = "b" * 24
            unrequested_id = "c" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.workspace = root
            bridge.state_dir = root / ".xhs-favorites"
            bridge.status_path = bridge.state_dir / "bridge-status.json"
            bridge.catalog_path = root / "catalog.json"
            bridge.python = Path("python")
            bridge.fetcher = Path("fetch-xhs-details.py")
            bridge.xhs_dir = root / "xhs"
            bridge.organizer = Path("organize-favorites.mjs")
            bridge.boards = {"board": "Board"}
            bridge.board_order = ["board"]
            bridge.published_since = None
            bridge.cache_missing_media = mock.Mock()
            bridge.tag_catalog_sources = mock.Mock()
            bridge.rebuild_knowledge_base = mock.Mock()
            bridge.next_board_id = mock.Mock(return_value=None)
            bridge.publish_after_board = mock.Mock(return_value={"status": "published"})
            BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {}})
            fetch_payload = json.dumps({
                "notes": [{"note_id": fetched_id, "detail_fetched": True, "comment_evidence_checked": True}],
                "failures": [
                    {"note_id": stopped_id, "reason": "safety stop"},
                    {"note_id": unrequested_id, "reason": "safety stop"},
                ],
            })
            completed = SimpleNamespace(returncode=0, stdout=fetch_payload, stderr="")
            organizer_inputs = []

            def organize_process(*_args, **kwargs):
                payload = json.loads(kwargs["input"])
                organizer_inputs.append(payload)
                BRIDGE.atomic_json(bridge.catalog_path, {
                    "version": 1,
                    "notes": {note["note_id"]: note for note in payload["notes"]},
                })
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            with (
                mock.patch.object(BRIDGE, "run_bounded_subprocess", return_value=completed) as fetch_process,
                mock.patch.object(BRIDGE.subprocess, "run", side_effect=organize_process),
            ):
                bridge.process_import("manual_board", "board", {
                    fetched_id: f"https://www.xiaohongshu.com/explore/{fetched_id}",
                    stopped_id: f"https://www.xiaohongshu.com/explore/{stopped_id}",
                    unrequested_id: f"https://www.xiaohongshu.com/explore/{unrequested_id}",
                })

            result = json.loads(
                (bridge.state_dir / "runs" / "manual_board.json").read_text(encoding="utf-8")
            )
            self.assertEqual(result["state"], "safety-stopped")
            self.assertEqual(result["new"], 1)
            self.assertEqual(result["media"]["state"], "safety-stopped")
            self.assertIsNone(result["next_board_id"])
            bridge.cache_missing_media.assert_not_called()
            bridge.next_board_id.assert_not_called()
            bridge.publish_after_board.assert_not_called()
            bridge.rebuild_knowledge_base.assert_called_once()
            self.assertEqual(organizer_inputs, [{
                "notes": [{
                    "note_id": fetched_id,
                    "detail_fetched": True,
                    "comment_evidence_checked": True,
                }],
            }])
            saved_catalog = json.loads(bridge.catalog_path.read_text(encoding="utf-8"))
            self.assertEqual(set(saved_catalog["notes"]), {fetched_id})
            fetch_command = fetch_process.call_args.args[0]
            self.assertIn("--lock-file", fetch_command)
            self.assertIn(str(bridge.state_dir / "platform-request.lock"), fetch_command)
            self.assertIn("--safety-stop-file", fetch_command)
            safety_stop = bridge.state_dir / "media-download-safety-stop.json"
            self.assertTrue(safety_stop.is_file())
            self.assertEqual(
                json.loads(safety_stop.read_text(encoding="utf-8"))["reason"],
                "platform-safety-limit",
            )

    def test_existing_media_safety_stop_terminates_import_before_any_platform_work(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "a" * 24
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.workspace = root
            bridge.state_dir = root / ".xhs-favorites"
            bridge.status_path = bridge.state_dir / "bridge-status.json"
            bridge.catalog_path = root / "catalog.json"
            bridge.boards = {"board": "Board"}
            bridge.board_order = ["board"]
            bridge.published_since = None
            bridge.next_board_id = mock.Mock(return_value=None)
            bridge.publish_after_board = mock.Mock(return_value=None)
            bridge.cache_missing_media = mock.Mock()
            BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {}})
            BRIDGE.atomic_json(
                bridge.state_dir / "media-download-safety-stop.json",
                {"reason": "platform-safety-limit"},
            )

            with (
                mock.patch.object(BRIDGE, "run_bounded_subprocess") as fetch,
                mock.patch.object(BRIDGE.subprocess, "run") as organizer,
            ):
                bridge.process_import("manual_board", "board", {
                    note_id: f"https://www.xiaohongshu.com/explore/{note_id}",
                })

            result = json.loads(
                (bridge.state_dir / "runs" / "manual_board.json").read_text(encoding="utf-8")
            )
            self.assertEqual(result["state"], "safety-stopped")
            self.assertIsNone(result["next_board_id"])
            fetch.assert_not_called()
            organizer.assert_not_called()
            bridge.cache_missing_media.assert_not_called()
            bridge.next_board_id.assert_not_called()
            bridge.publish_after_board.assert_not_called()

    def test_delayed_media_safety_stop_is_terminal_before_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "a" * 24
            fake_media = root / "fake-media.py"
            fake_media.write_text(
                "import argparse,json,time\n"
                "from pathlib import Path\n"
                "parser=argparse.ArgumentParser(add_help=False)\n"
                "parser.add_argument('--safety-stop-file')\n"
                "args,_=parser.parse_known_args()\n"
                "input()\n"
                "time.sleep(0.05)\n"
                "target=Path(args.safety_stop_file)\n"
                "target.parent.mkdir(parents=True,exist_ok=True)\n"
                "target.write_text('{\"reason\":\"platform-safety-limit\"}',encoding='utf-8')\n"
                "print(json.dumps({'queued':1,'downloaded':0,'safety_stopped':True}))\n"
                "raise SystemExit(2)\n",
                encoding="utf-8",
            )
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.workspace = root
            bridge.state_dir = root / ".xhs-favorites"
            bridge.status_path = bridge.state_dir / "bridge-status.json"
            bridge.catalog_path = root / "catalog.json"
            bridge.curation = root / "curation.json"
            bridge.curation.write_text("{}", encoding="utf-8")
            bridge.media_dir = bridge.state_dir / "media"
            bridge.media_dir.mkdir(parents=True)
            bridge.run_dir = bridge.state_dir / "runs"
            bridge.run_dir.mkdir(parents=True)
            bridge.python = Path(sys.executable)
            bridge.media_fetcher = fake_media
            bridge.xhs_dir = root / "xhs"
            bridge.video_analysis_enabled = True
            bridge.boards = {"board": "Board"}
            bridge.board_order = ["board"]
            bridge.published_since = None
            bridge.tag_catalog_sources = mock.Mock()
            bridge.rebuild_knowledge_base = mock.Mock()
            bridge.next_board_id = mock.Mock(return_value=None)
            bridge.publish_after_board = mock.Mock(return_value={"status": "published"})
            BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {
                note_id: {
                    "note_id": note_id,
                    "type": "视频",
                    "comment_evidence_checked": True,
                },
            }})

            bridge.process_import("manual_board", "board", {
                note_id: f"https://www.xiaohongshu.com/explore/{note_id}",
            })

            result = json.loads(
                (bridge.run_dir / "manual_board.json").read_text(encoding="utf-8")
            )
            self.assertEqual(result["state"], "safety-stopped")
            self.assertEqual(result["media"]["state"], "safety-stopped")
            self.assertIsNone(result["next_board_id"])
            bridge.next_board_id.assert_not_called()
            bridge.publish_after_board.assert_not_called()

    def test_fetch_payload_must_exactly_partition_requested_notes(self):
        with self.assertRaises(ValueError):
            BRIDGE.parse_fetch_payload(json.dumps({
                "notes": [{"note_id": "ok", "detail_fetched": True, "comment_evidence_checked": True}],
                "failures": [],
            }), {"ok", "missing"})
        with self.assertRaises(ValueError):
            BRIDGE.parse_fetch_payload(json.dumps({
                "notes": [{"note_id": "ok", "detail_fetched": True, "comment_evidence_checked": True}],
                "failures": [{"note_id": "ok", "reason": "request failed"}],
            }), {"ok"})

    def test_error_redacts_xsec_token(self):
        for raw in [
            "bad https://x/?xsec_token=secret&x=1",
            "request failed: xsec_token: secret",
            'request failed: "xsec_token": "secret"',
            "request failed: xsec\u200b_token：secret",
        ]:
            with self.subTest(raw=raw):
                message = BRIDGE.sanitize_error(raw)
                self.assertNotIn("secret", message)
                self.assertIn("[REDACTED]", message)

    def test_error_redacts_encoded_or_invisible_private_source_data(self):
        values = [
            "bad xsec_%E2%80%8Btoken%3Dsecret",
            'request failed: {"xsec\\u005ftoken":"secret"}',
            'request failed: {"xsec\\u200b_token":"secret"}',
            "bad https%26%23%35%38%3B%26%23%34%37%3B%26%23%34%37%3Bwww%26period%3Bxiaohongshu%26period%3Bcom%26sol%3Bboard%26sol%3Bprivate",
        ]
        for value in values:
            with self.subTest(value=value):
                message = BRIDGE.sanitize_error(value)
                self.assertNotIn("secret", message)
                self.assertNotIn("private", message)
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

    def test_single_note_local_only_run_never_invokes_publisher_during_core_or_finalization(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "p" * 24
            batch = "manualvalidation"
            board_id = "board"
            bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
            bridge.state_dir = root
            bridge.catalog_path = root / "catalog.json"
            bridge.status_path = root / "bridge-status.json"
            bridge.manual_sync_path = root / "manual-sync.json"
            bridge.processing_lock = threading.Lock()
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            bridge.published_since = None
            bridge.publish_config = {"enabled": True}
            bridge.summary_plans = {}
            bridge.summary_locks = {}
            bridge.summary_locks_guard = threading.Lock()
            bridge.summary_finalizing = set()
            bridge.summary_finalized = set()
            bridge.summary_halted = set()
            bridge.publish_public_site = mock.Mock(return_value={"ok": True, "status": "published"})
            bridge.cache_missing_media = mock.Mock(return_value={"state": "not-started"})
            bridge.tag_catalog_sources = mock.Mock()
            bridge.rebuild_knowledge_base = mock.Mock()
            run_id = bridge.manual_run_id(batch, board_id)
            BRIDGE.atomic_json(bridge.catalog_path, {"version": 1, "notes": {
                note_id: {"note_id": note_id, "comment_evidence_checked": True},
            }})
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "running",
                "run_board_ids": [board_id],
                "target_note_id": note_id,
                "local_only": True,
                "processed_run_ids": [],
            })

            bridge.process_import(
                run_id,
                board_id,
                {note_id: f"https://www.xiaohongshu.com/explore/{note_id}"},
            )
            bridge.run_diandian_finalization(run_id, board_id)

            bridge.publish_public_site.assert_not_called()
            core_result = json.loads((root / "runs" / f"{run_id}.json").read_text(encoding="utf-8"))
            self.assertNotIn("publish", core_result)
            public_status = bridge.manual_sync_status()
            self.assertNotIn("target_note_id", public_status)
            self.assertNotIn("local_only", public_status)

    def test_publish_timeout_is_reported_without_failing_local_sync(self):
        bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
        bridge.publisher = Path("publish-huggingface.mjs")
        bridge.workspace = Path(".").resolve()
        bridge.publish_config = {
            "repository": "https://huggingface.co/spaces/example/favsense",
            "branch": "main",
        }
        with mock.patch.object(
            BRIDGE,
            "run_bounded_subprocess",
            side_effect=BRIDGE.subprocess.TimeoutExpired(["node", "publisher"], 180),
        ) as bounded:
            result = bridge.publish_public_site()
        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "failed")
        self.assertIn("timed out", result["error"])
        command = bounded.call_args.args[0]
        options = bounded.call_args.kwargs
        self.assertEqual(command[0], "node")
        self.assertEqual(options["timeout"], 180)
        self.assertGreater(options["stdout_limit"], 0)
        self.assertGreater(options["stderr_limit"], 0)

    def test_publish_uses_the_process_tree_bounded_runner(self):
        bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
        bridge.publisher = Path("publish-huggingface.mjs")
        bridge.workspace = Path(".").resolve()
        bridge.publish_config = {
            "repository": "https://huggingface.co/spaces/example/favsense",
            "branch": "main",
        }
        completed = subprocess.CompletedProcess(
            ["node", "publisher"],
            0,
            stdout=json.dumps({"ok": True, "status": "unchanged"}),
            stderr="",
        )
        with mock.patch.object(
            BRIDGE, "run_bounded_subprocess", return_value=completed
        ) as bounded:
            result = bridge.publish_public_site()

        self.assertEqual(result["status"], "unchanged")
        bounded.assert_called_once()
        self.assertEqual(bounded.call_args.kwargs["input_text"], "")
        self.assertIsNone(bounded.call_args.kwargs["env"])


class DetailFetcherTest(unittest.IsolatedAsyncioTestCase):
    def test_platform_safety_signal_covers_verification_and_frequency_wording(self):
        for message in [
            "300031",
            "请完成验证码",
            "滑块验证",
            "请完成验证",
            "访问频繁，请稍后再试",
            "操作频繁",
            "请求频繁",
            "安全验证",
            "安全限制",
            "HTTP 429",
            "status_code=429",
            "status-code: 429",
            "状态码：429",
            "错误码 429",
        ]:
            with self.subTest(message=message):
                self.assertIsNotNone(FETCHER.SAFETY_SIGNAL.search(message))
        self.assertIsNone(FETCHER.SAFETY_SIGNAL.search("detail unavailable"))
        self.assertIsNone(FETCHER.SAFETY_SIGNAL.search("这篇内容有 429 个赞"))
        self.assertIsNone(FETCHER.SAFETY_SIGNAL.search("episode 429"))

    async def test_each_note_is_requested_once_and_failures_do_not_stop_the_batch(self):
        class FakeHtml:
            def __init__(self, calls):
                self.calls = calls

            async def request_url(self, url):
                self.calls.append(url)
                if url == "gone":
                    return ""
                if url == "broken":
                    raise RuntimeError("https://x/?xsec_token=secret")
                return "ok"

        class FakeConvert:
            @staticmethod
            def _extract_object(html):
                return html

            @staticmethod
            def _convert_object(script):
                if not script:
                    return {}
                return {"note": {"noteDetailMap": {"ok": {
                    "note": {"noteId": "ok", "title": "A note"},
                    "comments": [{"content": "Useful detail", "userInfo": {"userId": "private"}}],
                }}}}

        class FakeExplore:
            @staticmethod
            def run(namespace):
                return {"作品标题": namespace["title"]}

        class FakeApp:
            def __init__(self):
                self.calls = []
                self.html = FakeHtml(self.calls)
                self.convert = FakeConvert()
                self.explore = FakeExplore()

            @staticmethod
            def json_to_namespace(value):
                return value

        app = FakeApp()
        ok, no_detail = await FETCHER.extract_note(app, "ok", "ok")
        gone, unavailable = await FETCHER.extract_note(app, "gone", "gone")
        broken, failed = await FETCHER.extract_note(app, "broken", "broken")

        self.assertIsNotNone(ok)
        self.assertEqual(ok["comment_evidence"], [{"text": "Useful detail", "reply": False}])
        self.assertNotIn("private", json.dumps(ok))
        self.assertIsNone(no_detail)
        self.assertIsNone(gone)
        self.assertEqual(unavailable, {"note_id": "gone", "reason": "detail unavailable"})
        self.assertIsNone(broken)
        self.assertEqual(failed, {"note_id": "broken", "reason": "request failed"})
        self.assertEqual(app.calls, ["ok", "gone", "broken"])

    async def test_platform_safety_signal_stops_before_requesting_remaining_notes(self):
        class FakeHtml:
            def __init__(self):
                self.calls = []

            async def request_url(self, url):
                self.calls.append(url)
                if url == "blocked":
                    return "访问频繁 300031"
                raise AssertionError("the batch continued after a safety signal")

        class FakeConvert:
            @staticmethod
            def _extract_object(_html):
                return ""

            @staticmethod
            def _convert_object(_script):
                return {}

        class FakeApp:
            def __init__(self, **_kwargs):
                self.html = FakeHtml()
                self.convert = FakeConvert()
                self.explore = SimpleNamespace(run=lambda _value: {})

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            @staticmethod
            def json_to_namespace(value):
                return value

        app = FakeApp()
        with tempfile.TemporaryDirectory() as directory:
            safety_stop = Path(directory) / "media-download-safety-stop.json"
            with mock.patch.object(FETCHER, "replace_insecure_clients", new=mock.AsyncMock()):
                notes, failures = await FETCHER.fetch(
                    [("blocked", "first"), ("later", "second")],
                    lambda **_kwargs: app,
                    0,
                    safety_stop,
                )
            self.assertTrue(safety_stop.is_file())

        self.assertEqual(notes, [])
        self.assertEqual(failures, [
            {"note_id": "first", "reason": "safety stop"},
            {"note_id": "second", "reason": "safety stop"},
        ])
        self.assertEqual(app.html.calls, ["blocked"])

    async def test_external_safety_stop_prevents_detail_fetcher_initialization(self):
        with tempfile.TemporaryDirectory() as directory:
            safety_stop = Path(directory) / "media-download-safety-stop.json"
            safety_stop.write_text("{}", encoding="utf-8")
            xhs_class = mock.Mock(side_effect=AssertionError("fetcher was initialized"))

            notes, failures = await FETCHER.fetch(
                [("first", "a" * 24), ("second", "b" * 24)],
                xhs_class,
                0,
                safety_stop,
            )

        self.assertEqual(notes, [])
        self.assertEqual(failures, [
            {"note_id": "a" * 24, "reason": "safety stop"},
            {"note_id": "b" * 24, "reason": "safety stop"},
        ])
        xhs_class.assert_not_called()

    def test_detail_and_media_workers_share_one_platform_flight_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "platform-request.lock"
            first = FETCHER.acquire_single_flight(lock)
            try:
                with self.assertRaises(FileExistsError):
                    FETCHER.acquire_single_flight(lock)
            finally:
                first.close()

    async def test_structured_safety_state_wins_over_stale_parseable_note(self):
        note_id = "a" * 24

        class FakeHtml:
            @staticmethod
            async def request_url(_url):
                return "访问频繁 300031"

        class FakeConvert:
            @staticmethod
            def _extract_object(html):
                return html

            @staticmethod
            def _convert_object(_script):
                return {
                    "errorCode": 300031,
                    "note": {"noteDetailMap": {note_id: {
                        "note": {"noteId": note_id, "title": "stale"},
                    }}},
                }

        app = SimpleNamespace(
            html=FakeHtml(),
            convert=FakeConvert(),
            explore=SimpleNamespace(run=lambda _value: {"作品ID": note_id, "作品标题": "stale"}),
            json_to_namespace=lambda value: value,
        )
        note, failure = await FETCHER.extract_note(app, "signed-url", note_id)
        self.assertIsNone(note)
        self.assertEqual(failure, {"note_id": note_id, "reason": "safety stop"})

    async def test_note_content_about_verification_is_not_a_control_signal(self):
        note_id = "b" * 24

        class FakeHtml:
            @staticmethod
            async def request_url(_url):
                return "<div>验证码识别教程：如何处理访问频繁</div>"

        class FakeConvert:
            @staticmethod
            def _extract_object(html):
                return html

            @staticmethod
            def _convert_object(_script):
                return {"note": {"noteDetailMap": {note_id: {
                    "note": {"noteId": note_id, "title": "验证码识别教程"},
                }}}}

        app = SimpleNamespace(
            html=FakeHtml(),
            convert=FakeConvert(),
            explore=SimpleNamespace(run=lambda _value: {"作品ID": note_id, "作品标题": "验证码识别教程"}),
            json_to_namespace=lambda value: value,
        )
        note, failure = await FETCHER.extract_note(app, "signed-url", note_id)
        self.assertIsNone(failure)
        self.assertEqual(note["title"], "验证码识别教程")

    def test_note_state_and_normalizer_reject_mismatched_note_identity(self):
        requested = "r" * 24
        other = "o" * 24
        mismatched_map = {
            "note": {"noteDetailMap": {other: {"note": {"noteId": other}}}},
        }
        mismatched_entity = {
            "note": {"noteDetailMap": {requested: {"note": {"noteId": other}}}},
        }
        mismatched_mobile = {
            "noteData": {"data": {"noteData": {"noteId": other}}},
        }

        self.assertEqual(FETCHER.note_and_comments_from_state(mismatched_map, requested), ({}, []))
        self.assertEqual(FETCHER.note_and_comments_from_state(mismatched_entity, requested), ({}, []))
        self.assertEqual(FETCHER.note_and_comments_from_state(mismatched_mobile, requested), ({}, []))
        with self.assertRaisesRegex(ValueError, "identity"):
            FETCHER.normalize({"作品ID": other, "作品标题": "Wrong note"}, requested)

    async def test_exception_and_captured_diagnostic_safety_signals_are_sanitized(self):
        class ExceptionHtml:
            async def request_url(self, _url):
                raise RuntimeError("HTTP 429 for signed private request")

        exception_app = SimpleNamespace(html=ExceptionHtml())
        note, failure = await FETCHER.extract_note(exception_app, "private-url", "first")
        self.assertIsNone(note)
        self.assertEqual(failure, {"note_id": "first", "reason": "safety stop"})
        self.assertNotIn("private", json.dumps(failure))

        class DiagnosticHtml:
            async def request_url(self, _url):
                return "ok"

        class DiagnosticConvert:
            @staticmethod
            def _extract_object(html):
                return html

            @staticmethod
            def _convert_object(_script):
                return {"note": {"noteDetailMap": {"second": {
                    "note": {"noteId": "second", "title": "Title"},
                }}}}

        class DiagnosticExplore:
            @staticmethod
            def run(_namespace):
                print("请完成验证码")
                return {}

        diagnostic_app = SimpleNamespace(
            html=DiagnosticHtml(),
            convert=DiagnosticConvert(),
            explore=DiagnosticExplore(),
            json_to_namespace=lambda value: value,
        )
        note, failure = await FETCHER.extract_note(diagnostic_app, "signed-url", "second")
        self.assertIsNone(note)
        self.assertEqual(failure, {"note_id": "second", "reason": "safety stop"})

    def test_comment_evidence_is_bounded_and_removes_identity(self):
        comments = [{
            "content": "Top-level lesson",
            "likeCount": "8",
            "userInfo": {"nickname": "Private name", "userId": "private-id"},
            "subComments": [{"content": "Author clarification", "userId": "also-private"}],
        }]
        evidence = FETCHER.normalize_comments(comments)
        self.assertEqual(evidence, [
            {"text": "Top-level lesson", "reply": False, "liked_count": "8"},
            {"text": "Author clarification", "reply": True},
        ])
        self.assertNotIn("private", json.dumps(evidence))


if __name__ == "__main__":
    unittest.main()
