import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "skills" / "xhs-favorites-organizer" / "scripts" / "download-pending-media.py"


class PendingMediaQueueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SCRIPT.is_file():
            raise AssertionError("download-pending-media.py must exist")
        spec = importlib.util.spec_from_file_location("pending_media", SCRIPT)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_queue_excludes_curated_cached_and_invalid_notes(self):
        with tempfile.TemporaryDirectory() as temporary:
            media = Path(temporary)
            cached_id = "b" * 24
            (media / f"{cached_id}.mp4").write_bytes(b"cached")
            catalog = {
                "notes": {
                    "a" * 24: {"type": "视频", "title": "pending", "published_at": "2026-02-01_00:00:00"},
                    cached_id: {"type": "视频", "title": "cached"},
                    "c" * 24: {"type": "图文", "title": "curated"},
                    "d" * 24: {"type": "视频", "title": "old", "published_at": "2025-12-31_23:59:59"},
                    "not-a-note-id": {"type": "视频", "title": "invalid"},
                }
            }
            queue = self.module.build_pending_queue(
                catalog,
                {"c" * 24: {"summary": "done"}},
                media,
                max_items=10,
                published_since="2026-01-01",
            )
            self.assertEqual([item["note_id"] for item in queue], ["a" * 24])
            self.assertEqual(queue[0]["url"], f"https://www.xiaohongshu.com/explore/{'a' * 24}")

    def test_queue_limit_is_deterministic(self):
        catalog = {"notes": {character * 24: {"type": "视频"} for character in "abcdef"}}
        with tempfile.TemporaryDirectory() as temporary:
            queue = self.module.build_pending_queue(catalog, {}, Path(temporary), max_items=2)
        self.assertEqual([item["note_id"] for item in queue], ["a" * 24, "b" * 24])

    def test_queue_excludes_notes_before_configured_date(self):
        catalog = {"notes": {
            "a" * 24: {"type": "视频", "published_at": "2026-01-01_00:00:00"},
            "b" * 24: {"type": "视频", "published_at": "2025-12-31_23:59:59"},
            "c" * 24: {"type": "视频"},
        }}
        with tempfile.TemporaryDirectory() as temporary:
            queue = self.module.build_pending_queue(
                catalog, {}, Path(temporary), max_items=10, published_since="2026-01-01"
            )
        self.assertEqual([item["note_id"] for item in queue], ["a" * 24])

    def test_safety_limit_detection_covers_platform_stop_signals(self):
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
        ]:
            with self.subTest(message=message):
                self.assertTrue(self.module.contains_safety_limit(message))
        self.assertFalse(self.module.contains_safety_limit("detail unavailable"))
        self.assertFalse(self.module.contains_safety_limit("这篇内容有 429 个赞"))
        self.assertFalse(self.module.contains_safety_limit("episode 429"))
        self.assertFalse(self.module.safety_limit_detected("验证码识别教程", None))

    def test_safety_limit_in_exception_stops_the_batch(self):
        self.assertTrue(
            self.module.safety_limit_detected("", RuntimeError("request stopped: 300031"))
        )
        self.assertFalse(
            self.module.safety_limit_detected("", RuntimeError("detail unavailable"))
        )

    def test_media_lock_allows_only_one_worker(self):
        with tempfile.TemporaryDirectory() as temporary:
            lock = Path(temporary) / "media.lock"
            first = self.module.acquire_single_flight(lock)
            try:
                with self.assertRaises(FileExistsError):
                    self.module.acquire_single_flight(lock)
            finally:
                first.close()
                lock.unlink()

    def test_stale_media_lock_is_reclaimed(self):
        with tempfile.TemporaryDirectory() as temporary:
            lock = Path(temporary) / "media.lock"
            lock.write_text('{"pid": 999999999, "created_at": "2026-01-01T00:00:00Z"}', encoding="utf-8")
            handle = self.module.acquire_single_flight(lock)
            try:
                self.assertFalse(handle.closed)
            finally:
                handle.close()
                self.assertEqual(
                    __import__("json").loads(lock.read_text(encoding="utf-8"))["pid"],
                    __import__("os").getpid(),
                )
                lock.unlink()

    def test_signed_queue_accepts_only_xiaohongshu_note_urls(self):
        valid = "https://www.xiaohongshu.com/discovery/item/" + "a" * 24 + "?xsec_token=temporary"
        queue = self.module.build_signed_queue(valid, max_items=3)
        self.assertEqual(queue[0]["note_id"], "a" * 24)
        self.assertEqual(queue[0]["url"], valid)
        for invalid in [
            "https://example.com/explore/" + "a" * 24,
            "https://attacker@www.xiaohongshu.com/explore/" + "a" * 24,
            "http://www.xiaohongshu.com/explore/" + "a" * 24,
        ]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.module.build_signed_queue(invalid, max_items=3)

    def test_error_classification_never_returns_request_content(self):
        self.assertEqual(self.module.classify_error(RuntimeError("client has been closed xsec_token=secret")), "client-closed")
        self.assertEqual(self.module.classify_error(TimeoutError("https://example.invalid/private")), "timeout")
        self.assertEqual(self.module.classify_error(RuntimeError("unexpected private text")), "runtimeerror")


class MediaSafetySentinelTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("pending_media_sentinel", SCRIPT)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    async def test_worker_checks_external_safety_stop_before_requests_and_after_delay(self):
        module = self.module
        source = types.ModuleType("source")

        class FakeXHS:
            instances = []

            def __init__(self, **_kwargs):
                self.calls = []
                self.__class__.instances.append(self)

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def extract(self, url, *, download, data):
                self.calls.append((url, download, data))

        source.XHS = FakeXHS
        queue = [
            {"note_id": "a" * 24, "url": "first", "media_type": "unknown"},
            {"note_id": "b" * 24, "url": "second", "media_type": "unknown"},
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media_dir = root / "media"
            media_dir.mkdir()
            safety_stop = root / "media-download-safety-stop.json"
            safety_stop.write_text("{}", encoding="utf-8")
            with (
                mock.patch.dict(sys.modules, {"source": source}),
                mock.patch.object(module, "replace_insecure_clients", new=mock.AsyncMock()),
            ):
                stopped_before_first = await module.download_queue(
                    queue, root, media_dir, 0, safety_stop
                )
            self.assertTrue(stopped_before_first["safety_stopped"])
            self.assertEqual(stopped_before_first["results"], [])
            self.assertEqual(FakeXHS.instances[-1].calls, [])

            safety_stop.unlink()

            async def create_stop_after_delay(_delay):
                safety_stop.write_text("{}", encoding="utf-8")

            with (
                mock.patch.dict(sys.modules, {"source": source}),
                mock.patch.object(module, "replace_insecure_clients", new=mock.AsyncMock()),
                mock.patch.object(module.asyncio, "sleep", side_effect=create_stop_after_delay),
            ):
                stopped_after_delay = await module.download_queue(
                    queue, root, media_dir, 1, safety_stop
                )
            self.assertTrue(stopped_after_delay["safety_stopped"])
            self.assertEqual(
                [call[0] for call in FakeXHS.instances[-1].calls],
                ["first"],
            )

    async def test_worker_publishes_safety_stop_before_releasing_platform_lock(self):
        module = self.module
        source = types.ModuleType("source")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media_dir = root / "media"
            media_dir.mkdir()
            safety_stop = root / "media-download-safety-stop.json"

            class FakeXHS:
                def __init__(self, **_kwargs):
                    pass

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *_args):
                    if not safety_stop.is_file():
                        raise AssertionError("safety sentinel was delayed until after client shutdown")

                @staticmethod
                async def extract(_url, *, download, data):
                    self.assertTrue(download)
                    self.assertFalse(data)
                    print("status_code=429")

            source.XHS = FakeXHS
            with (
                mock.patch.dict(sys.modules, {"source": source}),
                mock.patch.object(module, "replace_insecure_clients", new=mock.AsyncMock()),
            ):
                outcome = await module.download_queue(
                    [{"note_id": "a" * 24, "url": "first", "media_type": "unknown"}],
                    root,
                    media_dir,
                    0,
                    safety_stop,
                )

            self.assertTrue(outcome["safety_stopped"])
            self.assertEqual(outcome["results"][0]["status"], "safety-stop")


class SecureClientReplacementTests(unittest.IsolatedAsyncioTestCase):
    async def test_download_component_receives_the_replacement_client(self):
        try:
            import httpx  # noqa: F401
        except ImportError:
            self.skipTest("httpx is provided by the pinned XHS-Downloader runtime")
        module = PendingMediaQueueTests.module

        class OldClient:
            def __init__(self):
                self.closed = False

            async def aclose(self):
                self.closed = True

        old_request = OldClient()
        old_download = OldClient()
        manager = type("Manager", (), {
            "request_client": old_request,
            "download_client": old_download,
            "blank_headers": {},
            "proxy": None,
            "timeout": 1,
        })()
        app = type("App", (), {
            "manager": manager,
            "html": type("Html", (), {"client": old_request})(),
            "downloader": type("Downloader", (), {"client": old_download})(),
        })()

        await module.replace_insecure_clients(app)
        try:
            self.assertIs(app.html.client, manager.request_client)
            self.assertIs(app.downloader.client, manager.download_client)
            self.assertTrue(old_request.closed)
            self.assertTrue(old_download.closed)
        finally:
            await manager.request_client.aclose()
            await manager.download_client.aclose()


if __name__ == "__main__":
    unittest.main()
