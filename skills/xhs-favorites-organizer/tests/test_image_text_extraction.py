import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import time
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
            class Process:
                stdout = io.BytesIO(b"  Safe   extracted text  ")
                stderr = io.BytesIO()
                returncode = 0

                def wait(self, timeout=None):
                    return self.returncode

                def terminate(self):
                    self.returncode = 1

                def kill(self):
                    self.returncode = 1

            def run_engine(_command, **_options):
                return Process()
            runner = mock.Mock(side_effect=run_engine)
            result = module.extract_cached_images(media, root / "analysis", engine=engine, allowed_note_ids={allowed}, runner=runner)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["processed"], 1)
            self.assertEqual(result["records"][0]["note_id"], allowed)
            self.assertNotIn("text", result["records"][0])
            self.assertEqual(runner.call_count, 1)

    def test_engine_output_is_spooled_and_rejected_before_an_unbounded_read(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); media = root / "media"; media.mkdir()
            allowed = "a" * 24
            (media / f"{allowed}.jpg").write_text(
                "import sys\nsys.stdout.buffer.write(b'x' * 800001)\n",
                encoding="utf-8",
            )

            result = module.extract_cached_images(
                media, root / "analysis", engine=Path(sys.executable).resolve(),
                allowed_note_ids={allowed},
            )
            self.assertEqual(result["status"], "partial")
            self.assertEqual(result["records"], [{
                "note_id": allowed, "status": "failed", "reason_code": "ocr_output_too_large",
            }])
            self.assertFalse((root / "analysis" / allowed / "visual-ocr.json").exists())

    def test_engine_stderr_and_timeout_are_bounded_with_real_children(self):
        module = load_module()
        executable = str(Path(sys.executable).resolve())
        _, _, stderr_reason = module._run_engine(
            [executable, "-c", "import sys; sys.stderr.buffer.write(b'x' * 65537)"],
            timeout=5, max_bytes=65536,
        )
        self.assertEqual(stderr_reason, "ocr_output_too_large")
        _, _, timeout_reason = module._run_engine(
            [executable, "-c", "import time; time.sleep(5)"],
            timeout=0.05, max_bytes=65536,
        )
        self.assertEqual(timeout_reason, "ocr_timed_out")

    def test_pipe_inheriting_descendant_cannot_hold_the_extractor_open(self):
        module = load_module()
        executable = str(Path(sys.executable).resolve())
        child = (
            "import subprocess,sys; "
            "subprocess.Popen([sys.executable,'-c','import time; time.sleep(5)'],"
            "stdout=sys.stdout,stderr=sys.stderr)"
        )
        started = time.monotonic()
        _, _, reason = module._run_engine(
            [executable, "-c", child], timeout=0.1, max_bytes=65536,
        )
        self.assertEqual(reason, "")
        self.assertLess(time.monotonic() - started, 2)

    @unittest.skipUnless(os.name == "nt", "Windows suspended-launch contract")
    def test_fast_parent_cannot_outrun_windows_job_assignment(self):
        module = load_module()
        executable = str(Path(sys.executable).resolve())
        child = (
            "import subprocess,sys; "
            "subprocess.Popen([sys.executable,'-c','import time; time.sleep(5)'],"
            "stdout=sys.stdout,stderr=sys.stderr)"
        )

        def delayed_popen(*args, **options):
            process = subprocess.Popen(*args, **options)
            time.sleep(0.25)
            return process

        started = time.monotonic()
        returncode, _, reason = module._run_engine(
            [executable, "-c", child], delayed_popen,
            timeout=1, max_bytes=65536,
        )
        self.assertEqual((returncode, reason), (0, ""))
        self.assertLess(time.monotonic() - started, 2)

    def test_dispatcher_never_falls_back_after_safety_stop(self):
        module = load_module()
        self.assertEqual(module.dispatch_evidence_methods({"safety_stopped": True, "cached_image": True, "cached_video": True, "ocr_available": True, "transcriber_available": True}), [])
        self.assertEqual(module.dispatch_evidence_methods({"safety_stopped": False, "cached_image": True, "cached_video": True, "ocr_available": False, "transcriber_available": True}), ["local_transcription"])


if __name__ == "__main__":
    unittest.main()
