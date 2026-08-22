import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "extract-pending-image-text.py"


def load_module():
    spec = importlib.util.spec_from_file_location("image_text", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ImageTextExtractionTests(unittest.TestCase):
    def test_missing_engine_returns_exact_unavailable_without_execution(self):
        module = load_module()
        runner = mock.Mock()
        with tempfile.TemporaryDirectory() as directory:
            result = module.extract_cached_images(
                Path(directory), Path(directory) / "analysis", engine=None,
                allowed_note_ids={"a" * 24}, runner=runner,
            )
        self.assertEqual(result, {"status": "ocr_unavailable", "processed": 0, "failed": 0, "records": []})
        runner.assert_not_called()

    def test_only_sealed_cached_images_are_sent_to_configured_engine(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); media = root / "media"; media.mkdir()
            allowed = "a" * 24; outside = "b" * 24
            (media / f"{allowed}.jpg").write_bytes(b"synthetic-image")
            (media / f"{outside}.png").write_bytes(b"synthetic-image")
            engine = root / "ocr.exe"; engine.write_bytes(b"synthetic-engine")
            runner = mock.Mock(return_value=mock.Mock(returncode=0, stdout="  Safe   extracted text  ", stderr=""))
            result = module.extract_cached_images(media, root / "analysis", engine=engine, allowed_note_ids={allowed}, runner=runner)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["processed"], 1)
            self.assertEqual(result["records"][0]["note_id"], allowed)
            self.assertNotIn("text", result["records"][0])
            self.assertEqual(runner.call_count, 1)

    def test_dispatcher_never_falls_back_after_safety_stop(self):
        module = load_module()
        self.assertEqual(module.dispatch_evidence_methods({"safety_stopped": True, "cached_image": True, "cached_video": True, "ocr_available": True, "transcriber_available": True}), [])
        self.assertEqual(module.dispatch_evidence_methods({"safety_stopped": False, "cached_image": True, "cached_video": True, "ocr_available": False, "transcriber_available": True}), ["local_transcription"])


if __name__ == "__main__":
    unittest.main()
