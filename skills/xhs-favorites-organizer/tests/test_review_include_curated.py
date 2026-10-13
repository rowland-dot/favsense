"""Re-reviewing an accepted (curated) note must be able to produce fresh offline evidence (#73).

The transcriber and the frame extractor skip every note already in the curation file, so naming a
reviewed note with --note-id used to do nothing and say nothing. An explicit opt-in switch
(--include-curated / -IncludeCurated) lifts only that skip, only for named notes. Everything else
about --note-id stays as it was, and a named note that is not queued is listed with its reason.
"""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
from argparse import Namespace
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import bridge_support
from bridge_support import ScriptRunnerDouble, completed


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
TRANSCRIBER = SCRIPTS / "transcribe-pending-videos.py"
FRAMES = SCRIPTS / "extract-pending-frames.py"
RUNNER = SCRIPTS / "run-video-analysis.ps1"
NOTE_ID = "a" * 24
OTHER_ID = "b" * 24
REVISION = "c" * 64
TOOL_VERSION = "fixture-tool"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def write_current_transcript(analysis: Path, note_id: str, *, revision=REVISION, tool=TOOL_VERSION):
    text = "a transcript with enough words to count as evidence"
    path = analysis / note_id / "transcription.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "schema_version": 1,
        "status": "transcribed",
        "method": "local_transcription",
        "provider": "faster-whisper",
        "tool_version": tool,
        "content_sha256": revision,
        "result_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "text": text,
        "audio_window": {"end": 30, "next_start": 30, "truncated": False, "complete": True},
        "visual_review": {"level": "none", "missing_facts": []},
    }), encoding="utf-8")


class TranscriptionQueueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load("transcriber_review_switch", TRANSCRIBER)

    def queue(self, root, curation, *, include_curated=None, notes=None, skipped=None, **extra):
        media = root / "media"
        media.mkdir(exist_ok=True)
        for note_id in notes or [NOTE_ID]:
            (media / f"{note_id}.mp4").write_bytes(b"video")
        arguments = dict(
            allowed_note_ids=set(notes or [NOTE_ID]),
            content_sha256_by_id={note_id: REVISION for note_id in notes or [NOTE_ID]},
            tool_version=TOOL_VERSION,
        )
        arguments.update(extra)
        if include_curated is not None:
            arguments["include_curated"] = include_curated
        if skipped is not None:
            arguments["skipped_notes"] = skipped
        return self.module.build_transcription_queue(
            media, curation, root / "analysis", 10, **arguments
        )

    def test_a_named_curated_note_at_the_current_version_is_queued_with_the_switch(self):
        # The issue's own example: the note is in curation, at the current content version.
        curation = {NOTE_ID: {"content_sha256": REVISION}}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertEqual(self.queue(root, curation), [])  # today's behaviour, kept as the control
            queue = self.queue(root, curation, include_curated=True)
            self.assertEqual([item["note_id"] for item in queue], [NOTE_ID])

    def test_the_switch_changes_nothing_for_a_note_that_is_not_curated(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plain = self.queue(root, {}, include_curated=False)
            switched = self.queue(root, {}, include_curated=True)
            self.assertEqual(
                [item["note_id"] for item in plain], [item["note_id"] for item in switched]
            )

    def test_a_current_transcript_is_not_redone_and_the_reason_is_reported(self):
        curation = {NOTE_ID: {"content_sha256": REVISION}}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_current_transcript(root / "analysis", NOTE_ID)
            skipped = {}
            queue = self.queue(root, curation, include_curated=True, skipped=skipped)
            self.assertEqual(queue, [])
            self.assertEqual(skipped, {NOTE_ID: "current_transcription"})

    def test_a_transcript_of_an_older_content_version_or_tool_is_redone(self):
        curation = {NOTE_ID: {"content_sha256": REVISION}}
        for label, kwargs in (
            ("older content", {"revision": "d" * 64}),
            ("older tool", {"tool": "another-tool"}),
        ):
            with self.subTest(label), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                write_current_transcript(root / "analysis", NOTE_ID, **kwargs)
                queue = self.queue(root, curation, include_curated=True)
                self.assertEqual([item["note_id"] for item in queue], [NOTE_ID])

    def test_a_curated_note_without_the_switch_is_reported_instead_of_skipped_silently(self):
        curation = {NOTE_ID: {"content_sha256": REVISION}}
        with tempfile.TemporaryDirectory() as temporary:
            skipped = {}
            queue = self.queue(Path(temporary), curation, skipped=skipped)
            self.assertEqual(queue, [])
            self.assertEqual(skipped, {NOTE_ID: "curated"})

    def test_a_named_note_without_a_local_video_is_reported(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "media").mkdir()
            skipped = {}
            queue = self.module.build_transcription_queue(
                root / "media", {}, root / "analysis", 10,
                allowed_note_ids={NOTE_ID}, skipped_notes=skipped,
            )
            self.assertEqual(queue, [])
            self.assertEqual(skipped, {NOTE_ID: "no_local_video"})

    def test_notes_cut_by_the_item_limit_are_reported(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "media"
            media.mkdir()
            (media / f"{NOTE_ID}.mp4").write_bytes(b"1")
            (media / f"{OTHER_ID}.mp4").write_bytes(b"123456")
            skipped = {}
            queue = self.module.build_transcription_queue(
                media, {}, root / "analysis", 1,
                allowed_note_ids={NOTE_ID, OTHER_ID}, skipped_notes=skipped,
            )
            self.assertEqual([item["note_id"] for item in queue], [NOTE_ID])
            self.assertEqual(skipped, {OTHER_ID: "over_max_items"})


class TranscriberCommandLineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load("transcriber_review_switch_main", TRANSCRIBER)

    def options(self, root: Path, **overrides):
        ffmpeg = root / "ffmpeg.exe"
        ffprobe = root / "ffprobe.exe"
        ffmpeg.write_bytes(b"tool")
        ffprobe.write_bytes(b"tool")
        (root / "media").mkdir(exist_ok=True)
        (root / "curation.json").write_text(json.dumps({
            NOTE_ID: {"content_sha256": REVISION},
        }), encoding="utf-8")
        (root / "catalog.json").write_text(json.dumps({"notes": {
            NOTE_ID: {"content_sha256": REVISION},
        }}), encoding="utf-8")
        (root / "config.json").write_text("{}", encoding="utf-8")
        values = dict(
            media_dir=str(root / "media"), curation=str(root / "curation.json"),
            catalog=str(root / "catalog.json"), config=str(root / "config.json"),
            analysis_dir=str(root / "analysis"), ffmpeg=str(ffmpeg), ffprobe=str(ffprobe),
            model="small", model_dir=str(root / "models"), language="zh", device="cpu",
            compute_type="int8", max_items=20, max_item_seconds=600, max_batch_seconds=900,
            status_file=str(root / "status.json"), keep_audio=False, reassess_only=False,
            note_id=[], include_curated=False,
        )
        values.update(overrides)
        return Namespace(**values)

    def run_main(self, options):
        output = io.StringIO()
        with (
            mock.patch.object(self.module, "parse_args", return_value=options),
            mock.patch.object(self.module.importlib_metadata, "version", return_value="1.0"),
            contextlib.redirect_stdout(output),
        ):
            self.module.main()
        return json.loads(output.getvalue().strip().splitlines()[-1])

    def test_the_switch_without_a_named_note_is_refused_before_anything_is_written(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            options = self.options(root, include_curated=True)
            with self.assertRaisesRegex(ValueError, "--include-curated requires --note-id"):
                with (
                    mock.patch.object(self.module, "parse_args", return_value=options),
                ):
                    self.module.main()
            self.assertFalse((root / "analysis").exists())
            self.assertFalse((root / "status.json").exists())

    def test_the_command_line_exits_with_an_error_for_the_switch_alone(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = subprocess.run(
                [
                    sys.executable, "-I", str(TRANSCRIBER),
                    "--media-dir", str(root / "media"), "--curation", str(root / "c.json"),
                    "--catalog", str(root / "k.json"), "--config", str(root / "g.json"),
                    "--analysis-dir", str(root / "analysis"), "--ffmpeg", str(root / "f.exe"),
                    "--ffprobe", str(root / "p.exe"), "--model-dir", str(root / "models"),
                    "--include-curated",
                ],
                capture_output=True, text=True, timeout=60,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("--include-curated requires --note-id", result.stdout + result.stderr)
            self.assertFalse((root / "analysis").exists())

    def test_a_named_curated_note_without_the_switch_exits_cleanly_and_says_why(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "media").mkdir()
            (root / "media" / f"{NOTE_ID}.mp4").write_bytes(b"video")
            result = self.run_main(self.options(root, note_id=[NOTE_ID]))
            self.assertEqual(result["queued"], 0)
            self.assertEqual(result["skipped_notes"], [{"note_id": NOTE_ID, "reason": "curated"}])
            status = json.loads((root / "status.json").read_text(encoding="utf-8"))
            self.assertEqual(status["skipped_notes"], result["skipped_notes"])

    def test_a_batch_call_keeps_the_output_shape_it_always_had(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "media").mkdir()
            (root / "media" / f"{NOTE_ID}.mp4").write_bytes(b"video")
            result = self.run_main(self.options(root))
            self.assertNotIn("skipped_notes", result)


class FrameQueueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load("frames_review_switch", FRAMES)

    def media(self, root: Path, *note_ids):
        (root / "media").mkdir(exist_ok=True)
        for note_id in note_ids:
            (root / "media" / f"{note_id}.mp4").write_bytes(b"video")
        return root / "media"

    def test_a_named_curated_note_is_queued_with_the_switch_and_force(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = self.media(root, NOTE_ID)
            curation = {NOTE_ID: {"content_sha256": REVISION}}
            common = dict(allowed_note_ids={NOTE_ID}, require_visual_recommendation=False)
            self.assertEqual(
                self.module.build_frame_queue(media, curation, root / "analysis", 5, **common), []
            )
            queue = self.module.build_frame_queue(
                media, curation, root / "analysis", 5, include_curated=True, **common
            )
            self.assertEqual([item["note_id"] for item in queue], [NOTE_ID])

    def test_the_switch_does_not_lift_the_visual_recommendation_rule(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = self.media(root, NOTE_ID)
            skipped = {}
            queue = self.module.build_frame_queue(
                media, {NOTE_ID: {}}, root / "analysis", 5,
                allowed_note_ids={NOTE_ID}, include_curated=True, skipped_notes=skipped,
            )
            self.assertEqual(queue, [])
            self.assertEqual(skipped, {NOTE_ID: "no_visual_recommendation"})

    def test_a_completed_extraction_is_not_redone_and_the_reason_is_reported(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = self.media(root, NOTE_ID)
            manifest = root / "analysis" / NOTE_ID / "extraction.json"
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({"status": "frames-extracted"}), encoding="utf-8")
            skipped = {}
            queue = self.module.build_frame_queue(
                media, {NOTE_ID: {}}, root / "analysis", 5, allowed_note_ids={NOTE_ID},
                require_visual_recommendation=False, include_curated=True, skipped_notes=skipped,
            )
            self.assertEqual(queue, [])
            self.assertEqual(skipped, {NOTE_ID: "frame_extraction_complete"})

    def test_a_curated_note_without_the_switch_is_reported_instead_of_skipped_silently(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = self.media(root, NOTE_ID)
            skipped = {}
            queue = self.module.build_frame_queue(
                media, {NOTE_ID: {}}, root / "analysis", 5, allowed_note_ids={NOTE_ID},
                require_visual_recommendation=False, skipped_notes=skipped,
            )
            self.assertEqual(queue, [])
            self.assertEqual(skipped, {NOTE_ID: "curated"})

    def test_the_review_page_queue_follows_the_same_rule(self):
        with tempfile.TemporaryDirectory() as temporary:
            analysis = Path(temporary)
            note_dir = analysis / NOTE_ID
            (note_dir / "frames").mkdir(parents=True)
            (note_dir / "extraction.json").write_text(json.dumps({
                "status": "frames-extracted", "sequence_frame_count": 2,
            }), encoding="utf-8")
            curation = {NOTE_ID: {}}
            skipped = {}
            self.assertEqual(self.module.build_review_queue(
                analysis, curation, 5, allowed_note_ids={NOTE_ID}, skipped_notes=skipped,
            ), [])
            self.assertEqual(skipped, {NOTE_ID: "curated"})
            queue = self.module.build_review_queue(
                analysis, curation, 5, allowed_note_ids={NOTE_ID}, include_curated=True,
            )
            self.assertEqual([item["note_id"] for item in queue], [NOTE_ID])

    def test_the_command_line_refuses_the_switch_without_a_named_note(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            result = subprocess.run(
                [
                    sys.executable, "-I", str(FRAMES),
                    "--media-dir", str(root / "media"), "--curation", str(root / "c.json"),
                    "--analysis-dir", str(root / "analysis"), "--ffmpeg", str(root / "f.exe"),
                    "--ffprobe", str(root / "p.exe"), "--include-curated",
                ],
                capture_output=True, text=True, timeout=60,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("--include-curated requires --note-id", result.stdout + result.stderr)


@unittest.skipUnless(
    os.name == "nt" and shutil.which("powershell.exe"),
    "the offline analysis runner is a Windows PowerShell script",
)
class PowerShellEntryTests(unittest.TestCase):
    """Runs the real entry script against stand-in producers that only record their arguments."""

    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.directory.cleanup)
        root = Path(cls.directory.name)
        cls.workspace = root / "workspace"
        cls.scripts = root / "scripts"
        cls.scripts.mkdir()
        shutil.copy(RUNNER, cls.scripts / RUNNER.name)
        for name in ("transcribe-pending-videos.py", "extract-pending-frames.py"):
            (cls.scripts / name).write_text(
                "import json, pathlib, sys\n"
                "target = pathlib.Path(__file__).with_suffix('.argv.json')\n"
                "target.write_text(json.dumps(sys.argv[1:]), encoding='utf-8')\n",
                encoding="utf-8",
            )
        state = cls.workspace / ".xhs-favorites"
        (state / "media").mkdir(parents=True)
        (cls.workspace / "config").mkdir()
        cls.config = cls.workspace / "config" / "xhs-favorites.json"
        cls.config.write_text(json.dumps({
            "curation_file": "curation.json", "video_analysis": {"enabled": True},
        }), encoding="utf-8")
        (cls.workspace / "curation.json").write_text("{}", encoding="utf-8")
        (state / "catalog.json").write_text(json.dumps({
            "version": 1, "notes": {NOTE_ID: {"note_id": NOTE_ID}},
        }), encoding="utf-8")
        tools = cls.workspace / ".xhs-tools"
        (tools / "transcription" / "models").mkdir(parents=True)
        subprocess.run(
            [sys.executable, "-m", "venv", "--without-pip", str(tools / "transcription" / ".venv")],
            check=True, capture_output=True, timeout=120,
        )
        (tools / "ffmpeg" / "build" / "bin").mkdir(parents=True)
        (tools / "ffmpeg" / "build" / "bin" / "ffmpeg.exe").write_bytes(b"tool")
        (tools / "ffmpeg" / "build" / "bin" / "ffprobe.exe").write_bytes(b"tool")

    def setUp(self):
        for path in self.scripts.glob("*.argv.json"):
            path.unlink()

    def run_entry(self, *extra):
        return subprocess.run(
            [
                shutil.which("powershell.exe"), "-NoProfile", "-NonInteractive",
                "-ExecutionPolicy", "Bypass", "-File", str(self.scripts / RUNNER.name),
                "-Workspace", str(self.workspace), "-Config", str(self.config), *extra,
            ],
            capture_output=True, text=True, timeout=120,
        )

    def recorded(self, name):
        path = self.scripts / name
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None

    def test_the_switch_reaches_both_producers_only_when_it_is_turned_on(self):
        on = self.run_entry("-NoteId", NOTE_ID, "-IncludeCurated", "-PrepareVisualEvidence")
        self.assertEqual(on.returncode, 0, on.stderr + on.stdout)
        for name in ("transcribe-pending-videos.argv.json", "extract-pending-frames.argv.json"):
            arguments = self.recorded(name)
            self.assertIn("--include-curated", arguments, name)
            self.assertIn(NOTE_ID, arguments, name)
        self.setUp()
        off = self.run_entry("-NoteId", NOTE_ID, "-PrepareVisualEvidence")
        self.assertEqual(off.returncode, 0, off.stderr + off.stdout)
        for name in ("transcribe-pending-videos.argv.json", "extract-pending-frames.argv.json"):
            self.assertNotIn("--include-curated", self.recorded(name), name)

    def test_the_switch_without_a_named_note_fails_before_any_producer_runs(self):
        result = self.run_entry("-IncludeCurated")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("IncludeCurated requires NoteId", result.stderr + result.stdout)
        self.assertIsNone(self.recorded("transcribe-pending-videos.argv.json"))


class DocumentationTests(unittest.TestCase):
    def test_both_workflow_documents_tell_a_reviewer_to_name_the_note_and_use_the_switch(self):
        root = SCRIPTS.parent
        for relative in ("SKILL.md", "references/automatic-workflow.md"):
            text = (root / relative).read_text(encoding="utf-8")
            self.assertIn("-NoteId", text, relative)
            self.assertIn("-IncludeCurated", text, relative)
            self.assertIn("不要改策展文件", text, relative)


class EvidenceFallbackTests(unittest.TestCase):
    """The automatic fallback after a failed DianDian transfer must never opt in to curated notes."""

    def test_the_fallback_command_does_not_carry_the_review_switch(self):
        bridge_module = load("bridge_review_switch", SCRIPTS / "bridge-server.py")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner = ScriptRunnerDouble(lambda command, **kwargs: completed("{}"))
            bridge = bridge_support.make_bridge(
                bridge_module, root, script_runner=runner,
                config={"video_analysis": {"enabled": True}},
            )
            bridge.media_dir.mkdir(parents=True, exist_ok=True)
            (bridge.media_dir / f"{NOTE_ID}.mp4").write_bytes(b"cached")
            bridge_module.atomic_json(
                bridge.manual_sync_path,
                {"state": "failed", "started_at": "2026-10-12T09:00:00+00:00"},
            )
            bridge.powershell = root / "powershell.exe"
            bridge.powershell.write_bytes(b"tool")
            bridge.trusted_content_sha256 = lambda candidate: "b" * 64
            bridge.dispatch_evidence_fallback(NOTE_ID, "transport-failed")
            self.assertEqual(len(runner.calls), 1)
            command = runner.calls[0].command
            self.assertIn("-NoteId", command)
            self.assertNotIn("-IncludeCurated", command)


if __name__ == "__main__":
    unittest.main()
