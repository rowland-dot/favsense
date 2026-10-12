import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "scripts" / "extract-pending-image-text.py"
RUNNER = Path(__file__).parents[1] / "scripts" / "run-video-analysis.ps1"


def process_is_running(pid):
    if os.name == "nt":
        listing = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True, text=True, check=False,
        )
        return str(pid) in listing.stdout
    stat = Path(f"/proc/{pid}/stat")
    if stat.parent.parent.exists():
        try:
            # A zombie has exited; only its parent has yet to collect it.
            return stat.read_text(encoding="utf-8").rsplit(")", 1)[1].split()[0] != "Z"
        except FileNotFoundError:
            return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


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
            result = module.extract_cached_images(
                media,
                root / "analysis",
                engine=engine,
                allowed_note_ids={allowed},
                content_sha256_by_id={allowed: "c" * 64},
                runner=runner,
            )
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["processed"], 1)
            self.assertEqual(result["records"][0]["note_id"], allowed)
            self.assertNotIn("text", result["records"][0])
            self.assertEqual(runner.call_count, 1)

    def test_redirected_note_output_is_rejected_before_running_the_engine(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "media"
            analysis = root / "analysis"
            media.mkdir()
            allowed = "a" * 24
            (media / f"{allowed}.jpg").write_bytes(b"synthetic-image")
            engine = root / "ocr.exe"
            engine.write_bytes(b"synthetic-engine")
            note_dir = analysis / allowed
            note_dir.mkdir(parents=True)
            runner = mock.Mock()

            with mock.patch.object(
                module,
                "_is_plain_directory",
                side_effect=lambda path: Path(path) != note_dir,
            ):
                result = module.extract_cached_images(
                    media,
                    analysis,
                    engine=engine,
                    allowed_note_ids={allowed},
                    content_sha256_by_id={allowed: "c" * 64},
                    runner=runner,
                )

            runner.assert_not_called()
            self.assertEqual(result["processed"], 0)
            self.assertEqual(result["failed"], 1)
            self.assertEqual(
                result["records"][0]["reason_code"],
                "ocr_output_path_unavailable",
            )

    def test_success_artifact_binds_the_catalog_revision_and_tool_contract(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); media = root / "media"; media.mkdir()
            allowed = "a" * 24
            content_sha256 = "b" * 64
            (media / f"{allowed}.jpg").write_bytes(b"synthetic-image")
            engine = root / "ocr.exe"; engine.write_bytes(b"synthetic-engine")

            class Process:
                stdout = io.BytesIO(b"revision bound OCR text")
                stderr = io.BytesIO()
                returncode = 0

                def wait(self, timeout=None):
                    return self.returncode

                def terminate(self):
                    self.returncode = 1

                def kill(self):
                    self.returncode = 1

            result = module.extract_cached_images(
                media,
                root / "analysis",
                engine=engine,
                allowed_note_ids={allowed},
                content_sha256_by_id={allowed: content_sha256},
                runner=lambda *_args, **_kwargs: Process(),
            )

            self.assertEqual(result["processed"], 1)
            artifact = json.loads(
                (root / "analysis" / allowed / "visual-ocr.json").read_text(encoding="utf-8")
            )
            self.assertEqual(artifact["schema_version"], 1)
            self.assertEqual(artifact["content_sha256"], content_sha256)
            self.assertEqual(artifact["status"], "extracted")
            self.assertEqual(artifact["method"], "local_image_ocr")
            self.assertTrue(artifact["provider"])
            tool_version = module.ocr_tool_version(engine)
            self.assertEqual(artifact["tool_version"], tool_version)
            self.assertEqual(
                artifact["result_sha256"],
                module.hashlib.sha256(artifact["text"].encode("utf-8")).hexdigest(),
            )
            engine.write_bytes(b"different-synthetic-engine")
            self.assertNotEqual(tool_version, module.ocr_tool_version(engine))

    def test_engine_identity_drift_during_execution_fails_closed(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); media = root / "media"; media.mkdir()
            allowed = "a" * 24
            (media / f"{allowed}.jpg").write_bytes(b"synthetic-image")
            engine = root / "ocr.exe"; engine.write_bytes(b"original-engine")

            class Process:
                stdout = io.BytesIO(b"text from changed engine")
                stderr = io.BytesIO()
                returncode = 0

                def wait(self, timeout=None):
                    return self.returncode

                def terminate(self):
                    self.returncode = 1

                def kill(self):
                    self.returncode = 1

            def replace_engine(*_args, **_kwargs):
                engine.write_bytes(b"replacement-engine")
                return Process()

            result = module.extract_cached_images(
                media,
                root / "analysis",
                engine=engine,
                allowed_note_ids={allowed},
                content_sha256_by_id={allowed: "b" * 64},
                runner=replace_engine,
            )

            self.assertEqual(result["processed"], 0)
            self.assertEqual(result["failed"], 1)
            self.assertEqual(result["records"][0]["reason_code"], "ocr_engine_changed")
            artifact = json.loads(
                (root / "analysis" / allowed / "visual-ocr.json").read_text(encoding="utf-8")
            )
            self.assertEqual(artifact["status"], "failed")
            self.assertEqual(artifact["reason_code"], "ocr_engine_changed")
            self.assertNotIn("text", artifact)

    def test_real_runner_passes_the_catalog_to_the_ocr_producer(self):
        source = RUNNER.read_text(encoding="utf-8-sig")
        ocr_call = source[source.index("$ocrArguments = @("):source.index("& $python @ocrArguments")]
        self.assertIn("'--catalog', $catalog", ocr_call)

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
                allowed_note_ids={allowed}, content_sha256_by_id={allowed: "c" * 64},
            )
            self.assertEqual(result["status"], "partial")
            self.assertEqual(result["records"], [{
                "note_id": allowed, "status": "failed", "reason_code": "ocr_output_too_large",
            }])
            artifact = json.loads(
                (root / "analysis" / allowed / "visual-ocr.json").read_text(encoding="utf-8")
            )
            self.assertEqual(artifact["status"], "failed")
            self.assertEqual(artifact["content_sha256"], "c" * 64)
            self.assertEqual(artifact["method"], "local_image_ocr")
            self.assertEqual(artifact["provider"], "configured-local-engine")
            self.assertEqual(
                artifact["tool_version"], module.ocr_tool_version(Path(sys.executable).resolve())
            )
            self.assertEqual(artifact["reason_code"], "ocr_output_too_large")
            self.assertNotIn("text", artifact)

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
        with tempfile.TemporaryDirectory() as directory:
            pid_file = Path(directory) / "descendant.pid"
            child = (
                "import subprocess,sys; "
                "p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(5)'],"
                "stdout=sys.stdout,stderr=sys.stderr); "
                f"open({str(pid_file)!r},'w').write(str(p.pid))"
            )
            started = time.monotonic()
            _, _, reason = module._run_engine(
                [executable, "-c", child], timeout=1, max_bytes=65536,
            )
            self.assertEqual(reason, "")
            self.assertLess(time.monotonic() - started, 2)
            descendant = int(pid_file.read_text(encoding="utf-8"))
        deadline = time.monotonic() + 2
        while process_is_running(descendant) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(process_is_running(descendant), "the descendant must not outlive the engine run")

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


NOTE_A = "a" * 24
REVISION = "c" * 64


class ScriptedEngine:
    """Stands in for the OCR engine process: answers each image by its file name and records the order."""

    def __init__(self, answers):
        self.answers = answers
        self.images = []

    def __call__(self, command, **_options):
        image = Path(command[-1]).name
        self.images.append(image)
        stdout, stderr, returncode = self.answers[image]

        class Process:
            def __init__(self):
                self.stdout = io.BytesIO(stdout)
                self.stderr = io.BytesIO(stderr)
                self.returncode = returncode

            def wait(self, timeout=None):
                return self.returncode

            def terminate(self):
                self.returncode = 1

            def kill(self):
                self.returncode = 1

        return Process()


def extract_with(module, root, answers, *, cached, note_ids=(NOTE_A,), revision=REVISION, **options):
    """Cache the named files for the notes, run the extraction, return (result, engine)."""
    media = root / "media"
    media.mkdir(exist_ok=True)
    for name in cached:
        (media / name).write_bytes(b"synthetic-image")
    engine_file = root / "ocr.exe"
    if not engine_file.exists():
        engine_file.write_bytes(b"synthetic-engine")
    engine = ScriptedEngine(answers)
    result = module.extract_cached_images(
        media, root / "analysis", engine=engine_file, allowed_note_ids=set(note_ids),
        content_sha256_by_id={note_id: revision for note_id in note_ids}, runner=engine, **options,
    )
    return result, engine


def read_artifact(root, note_id=NOTE_A):
    return json.loads((root / "analysis" / note_id / "visual-ocr.json").read_text(encoding="utf-8"))


class CachedImagePageTests(unittest.TestCase):
    def test_every_cached_page_of_a_note_is_read_in_numeric_page_order(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            names = [f"{NOTE_A}_10.jpeg", f"{NOTE_A}_2.jpeg", f"{NOTE_A}_1.jpeg"]
            answers = {
                f"{NOTE_A}_1.jpeg": ("第一页".encode("utf-8"), b"", 0),
                f"{NOTE_A}_2.jpeg": ("第二页".encode("utf-8"), b"", 0),
                f"{NOTE_A}_10.jpeg": ("第十页".encode("utf-8"), b"", 0),
            }

            result, engine = extract_with(module, root, answers, cached=names)

            self.assertEqual(engine.images, [f"{NOTE_A}_1.jpeg", f"{NOTE_A}_2.jpeg", f"{NOTE_A}_10.jpeg"])
            self.assertEqual((result["status"], result["processed"], result["failed"]), ("completed", 1, 0))
            self.assertEqual(read_artifact(root)["text"], "第一页 第二页 第十页")


@unittest.skipUnless(
    os.name == "nt" and shutil.which("powershell.exe"),
    "the offline analysis runner is a Windows PowerShell script",
)
class RunnerEncodingTests(unittest.TestCase):
    """The configured engine encoding travels from the private config, through the runner, to the extractor."""

    def run_runner(self, output_encoding):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            state_dir = workspace / ".xhs-favorites"
            (state_dir / "media").mkdir(parents=True)
            (state_dir / "media" / f"{NOTE_A}_1.jpeg").write_bytes(b"image")
            (workspace / "tools").mkdir()
            # An engine that, like the real one, writes Chinese in the Windows code page rather than UTF-8.
            # cmd reads a batch file in the console's OEM code page, not UTF-8 or the Python default, so the file
            # stays pure ASCII: it calls `python`, which resolves to this interpreter because its folder is put
            # first on PATH below. (Writing this interpreter's own path into the file broke on a Chinese folder name.)
            program = "import sys; sys.stdout.buffer.write('\\u4e2d\\u6587'.encode('gbk'))"
            (workspace / "tools" / "ocr-engine.cmd").write_text(
                f'@echo off\r\npython -c "{program}"\r\n', encoding="ascii", newline=""
            )
            (workspace / "config").mkdir()
            ocr = {"enabled": True, "engine": "tools/ocr-engine.cmd"}
            if output_encoding is not None:
                ocr["output_encoding"] = output_encoding
            config = workspace / "config" / "xhs-favorites.json"
            config.write_text(json.dumps({"curation_file": "curation.json", "image_ocr": ocr}), encoding="utf-8")
            (workspace / "curation.json").write_text("{}", encoding="utf-8")
            (state_dir / "catalog.json").write_text(json.dumps({"version": 1, "notes": {
                NOTE_A: {"note_id": NOTE_A, "type": "图文", "content_sha256": REVISION},
            }}), encoding="utf-8")
            (state_dir / "manual-sync.json").write_text(
                json.dumps({"state": "completed", "frozen_scope": {"note_ids": [NOTE_A]}}), encoding="utf-8"
            )
            environment = {**os.environ, "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", "")}
            completed = subprocess.run(
                [shutil.which("powershell.exe"), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
                 "-File", str(RUNNER), "-Workspace", str(workspace), "-Config", str(config)],
                capture_output=True, text=True, timeout=120, env=environment,
            )
            report_path = state_dir / "image-ocr-status.json"
            report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.is_file() else None
            artifact_path = state_dir / "video-analysis" / NOTE_A / "visual-ocr.json"
            artifact = json.loads(artifact_path.read_text(encoding="utf-8")) if artifact_path.is_file() else None
            return completed, report, artifact

    def test_a_declared_encoding_reaches_the_extractor(self):
        completed, report, artifact = self.run_runner("gbk")
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        self.assertEqual(report["processed"], 1)
        self.assertEqual(artifact["text"], "中文")

    def test_no_declared_encoding_means_utf8(self):
        completed, report, artifact = self.run_runner(None)
        self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
        self.assertEqual((report["processed"], report["failed"]), (0, 1))
        self.assertEqual(artifact["reason_code"], "ocr_failed")

    def test_an_unknown_encoding_name_stops_the_runner(self):
        completed, report, _ = self.run_runner("not-an-encoding")
        self.assertNotEqual(completed.returncode, 0)
        self.assertIsNone(report)


CACHED_IMAGES = Path(__file__).parents[1] / "scripts" / "cached_images.py"

# The one table of which cached file names are a note's images. The extractor and the sync service both
# read this rule from cached_images.py; test_organization_pipeline.py drives the sync service with the same names.
IMAGE_NAME_CASES = [
    (f"{NOTE_A}.jpg", (NOTE_A, 0)),
    (f"{NOTE_A}.JPEG", (NOTE_A, 0)),
    (f"{NOTE_A}_1.jpeg", (NOTE_A, 1)),
    (f"{NOTE_A}_10.png", (NOTE_A, 10)),
    (f"{NOTE_A}_02.webp", (NOTE_A, 2)),
    (f"{NOTE_A}.mp4", None),
    (f"{NOTE_A}_x.jpg", None),
    (f"{NOTE_A}_.jpg", None),
    (f"{NOTE_A}_1_2.jpg", None),
    (f"{NOTE_A}.jpg.tmp", None),
    (f"{NOTE_A}1.jpg", None),
    ("short.jpg", None),
]


class CachedImageNameTests(unittest.TestCase):
    def test_the_shared_rule_reads_every_name_in_the_table(self):
        spec = importlib.util.spec_from_file_location("cached_images_under_test", CACHED_IMAGES)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for name, expected in IMAGE_NAME_CASES:
            with self.subTest(name=name):
                self.assertEqual(module.image_page(name), expected)


class MissingImageReportTests(unittest.TestCase):
    NOTE_B = "b" * 24

    def test_a_requested_image_note_with_no_cached_image_is_reported_not_completed(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            result, engine = extract_with(module, root, {}, cached=[], image_note_ids={NOTE_A})

            self.assertEqual(engine.images, [])
            self.assertEqual((result["status"], result["processed"], result["failed"], result["missing"]),
                             ("partial", 0, 0, 1))
            self.assertEqual(result["records"], [
                {"note_id": NOTE_A, "status": "skipped", "reason_code": "no_cached_images"},
            ])

    def test_a_requested_video_note_is_not_an_image_failure(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            result, _ = extract_with(module, root, {}, cached=[f"{NOTE_A}.mp4"], image_note_ids=set())

            self.assertEqual((result["status"], result["processed"], result["failed"], result["missing"]),
                             ("completed", 0, 0, 0))
            self.assertEqual(result["records"], [])

    def test_the_command_line_reads_which_catalog_notes_are_image_notes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "media").mkdir()
            (root / "media" / f"{self.NOTE_B}.mp4").write_bytes(b"video")
            (root / "ocr.exe").write_bytes(b"synthetic-engine")
            catalog = {"notes": {
                NOTE_A: {"type": "图文", "content_sha256": REVISION},
                self.NOTE_B: {"type": "视频", "content_sha256": REVISION},
            }}
            (root / "catalog.json").write_text(json.dumps(catalog), encoding="utf-8")

            completed = subprocess.run(
                [sys.executable, "-I", str(SCRIPT), "--media-dir", str(root / "media"),
                 "--analysis-dir", str(root / "analysis"), "--engine", str(root / "ocr.exe"),
                 "--catalog", str(root / "catalog.json"), "--report", str(root / "report.json"),
                 "--note-id", NOTE_A, "--note-id", self.NOTE_B],
                capture_output=True, text=True, timeout=60,
            )

            self.assertEqual(completed.returncode, 0, completed.stderr)
            report = json.loads((root / "report.json").read_text(encoding="utf-8"))
            self.assertEqual(report["missing"], 1)
            self.assertEqual([record["note_id"] for record in report["records"]], [NOTE_A])


class ReuseTests(unittest.TestCase):
    PAGE = f"{NOTE_A}_1.jpeg"
    ANSWERS = {PAGE: ("读到的文字".encode("utf-8"), b"", 0)}

    def first_run(self, module, root):
        result, engine = extract_with(module, root, self.ANSWERS, cached=[self.PAGE])
        self.assertEqual(engine.images, [self.PAGE])
        return (root / "analysis" / NOTE_A / "visual-ocr.json").read_bytes()

    def test_a_current_extracted_artifact_is_reused_without_running_the_engine(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            before = self.first_run(module, root)

            result, engine = extract_with(module, root, self.ANSWERS, cached=[])

            self.assertEqual(engine.images, [])
            self.assertEqual((result["status"], result["processed"], result["failed"]), ("completed", 1, 0))
            self.assertEqual(result["records"][0]["status"], "extracted")
            self.assertEqual((root / "analysis" / NOTE_A / "visual-ocr.json").read_bytes(), before)

    def test_a_changed_note_revision_reads_the_images_again(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.first_run(module, root)

            _, engine = extract_with(module, root, self.ANSWERS, cached=[], revision="d" * 64)

            self.assertEqual(engine.images, [self.PAGE])
            self.assertEqual(read_artifact(root)["content_sha256"], "d" * 64)

    def test_a_changed_engine_reads_the_images_again(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.first_run(module, root)
            (root / "ocr.exe").write_bytes(b"a-different-engine")

            _, engine = extract_with(module, root, self.ANSWERS, cached=[])

            self.assertEqual(engine.images, [self.PAGE])

    def test_a_failed_artifact_is_not_reused(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            broken = {self.PAGE: (b"", b"Traceback", 1)}
            extract_with(module, root, broken, cached=[self.PAGE])
            self.assertEqual(read_artifact(root)["status"], "failed")

            result, engine = extract_with(module, root, self.ANSWERS, cached=[])

            self.assertEqual(engine.images, [self.PAGE])
            self.assertEqual(read_artifact(root)["status"], "extracted")


class BlankPageTests(unittest.TestCase):
    PAGE_1, PAGE_2 = f"{NOTE_A}_1.jpeg", f"{NOTE_A}_2.jpeg"
    BLANK = (b"", b"", 1)  # what the engine does for a picture with no text on it

    def test_the_engine_tells_a_page_with_no_text_apart_from_a_broken_one(self):
        module = load_module()
        executable = str(Path(sys.executable).resolve())
        self.assertEqual(module._run_engine([executable, "-c", "import sys; sys.exit(1)"])[2], "ocr_no_text")
        returncode, _, reason = module._run_engine(
            [executable, "-c", "import sys; sys.stderr.write('Traceback'); sys.exit(1)"]
        )
        self.assertEqual((returncode, reason), (1, ""))

    def test_a_page_with_no_text_is_skipped_and_the_note_still_succeeds(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            answers = {self.PAGE_1: self.BLANK, self.PAGE_2: ("有字的一页".encode("utf-8"), b"", 0)}

            result, engine = extract_with(module, root, answers, cached=[self.PAGE_1, self.PAGE_2])

            self.assertEqual((result["status"], result["processed"], result["failed"]), ("completed", 1, 0))
            self.assertEqual(engine.images, [self.PAGE_1, self.PAGE_2])
            self.assertEqual(read_artifact(root)["text"], "有字的一页")

    def test_a_blank_last_page_does_not_fail_the_note(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            answers = {self.PAGE_1: ("有字的一页".encode("utf-8"), b"", 0), self.PAGE_2: self.BLANK}

            result, _ = extract_with(module, root, answers, cached=[self.PAGE_1, self.PAGE_2])

            self.assertEqual((result["status"], result["processed"], result["failed"]), ("completed", 1, 0))
            self.assertEqual(read_artifact(root)["text"], "有字的一页")

    def test_a_page_that_errors_fails_the_whole_note(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            answers = {
                self.PAGE_1: ("第一页".encode("utf-8"), b"", 0),
                self.PAGE_2: (b"", b"Traceback: cannot open image", 1),
            }

            result, _ = extract_with(module, root, answers, cached=[self.PAGE_1, self.PAGE_2])

            self.assertEqual((result["processed"], result["failed"]), (0, 1))
            self.assertEqual(result["records"][0]["reason_code"], "ocr_failed")
            artifact = read_artifact(root)
            self.assertEqual(artifact["status"], "failed")
            self.assertNotIn("text", artifact)

    def test_a_note_whose_pages_are_all_blank_is_empty(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            answers = {self.PAGE_1: self.BLANK, self.PAGE_2: (b"", b"", 0)}

            result, _ = extract_with(module, root, answers, cached=[self.PAGE_1, self.PAGE_2])

            self.assertEqual((result["processed"], result["failed"]), (0, 1))
            self.assertEqual(result["records"][0]["reason_code"], "ocr_empty")


class EngineOutputEncodingTests(unittest.TestCase):
    CHINESE = "中文识别结果"

    def test_output_is_decoded_with_the_declared_encoding(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            answers = {f"{NOTE_A}_1.jpeg": (self.CHINESE.encode("gbk"), b"", 0)}

            result, _ = extract_with(module, root, answers, cached=[f"{NOTE_A}_1.jpeg"], engine_encoding="gbk")

            self.assertEqual((result["processed"], result["failed"]), (1, 0))
            self.assertEqual(read_artifact(root)["text"], self.CHINESE)

    def test_bytes_that_are_not_in_the_declared_encoding_fail_the_note_without_replacement_characters(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            answers = {f"{NOTE_A}_1.jpeg": (self.CHINESE.encode("gbk"), b"", 0)}

            result, _ = extract_with(module, root, answers, cached=[f"{NOTE_A}_1.jpeg"])

            self.assertEqual((result["processed"], result["failed"]), (0, 1))
            self.assertEqual(result["records"][0]["reason_code"], "ocr_failed")
            stored = (root / "analysis" / NOTE_A / "visual-ocr.json").read_text(encoding="utf-8")
            self.assertNotIn("�", stored)
            self.assertNotIn("text", json.loads(stored))

    def test_an_unknown_encoding_name_is_an_error_before_any_engine_runs(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            answers = {f"{NOTE_A}_1.jpeg": (b"unused", b"", 0)}
            with self.assertRaises(ValueError):
                extract_with(module, root, answers, cached=[f"{NOTE_A}_1.jpeg"], engine_encoding="not-an-encoding")

    def test_a_real_child_process_output_is_decoded_with_the_declared_encoding(self):
        module = load_module()
        executable = str(Path(sys.executable).resolve())
        program = f"import sys; sys.stdout.buffer.write({self.CHINESE!r}.encode('gbk'))"
        _, text, reason = module._run_engine([executable, "-c", program], encoding="gbk")
        self.assertEqual((text, reason), (self.CHINESE, ""))
        _, text, reason = module._run_engine([executable, "-c", program])
        self.assertEqual((text, reason), ("", "ocr_failed"))


if __name__ == "__main__":
    unittest.main()
