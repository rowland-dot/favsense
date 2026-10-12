"""A safety stop only blocks platform contact. Offline work carries on.

A stop raised in the current round still cancels the evidence step that follows a failed summary
(the round has ended and nothing more should run); a stop left by an earlier round does not.
Reading cached media, transcribing it and running OCR on it never touch the platform.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPTS = Path(__file__).parents[1] / "scripts"


def load(name: str, file_name: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / file_name)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


BRIDGE = load("xhs_bridge_offline_work", "bridge-server.py")
RUNNER = SCRIPTS / "run-video-analysis.ps1"
STOP_NAME = "media-download-safety-stop.json"
NOTE_ID = "a" * 24
ROUND_START = "2026-10-12T09:00:00+00:00"
LEFTOVER = {"stopped_at": "2026-08-29T12:00:00+00:00", "reason": "platform-safety-limit"}
THIS_ROUND = {
    "stopped_at": "2026-10-12T09:30:00+00:00", "reason": "platform-safety-limit", "phase": "media",
}


def bridge_with_cached_video(root: Path):
    bridge = BRIDGE.Bridge.__new__(BRIDGE.Bridge)
    bridge.workspace = root
    bridge.state_dir = root / ".xhs-favorites"
    bridge.media_dir = bridge.state_dir / "media"
    bridge.media_dir.mkdir(parents=True)
    (bridge.media_dir / f"{NOTE_ID}.mp4").write_bytes(b"cached")
    bridge.manual_sync_path = bridge.state_dir / "manual-sync.json"
    BRIDGE.atomic_json(bridge.manual_sync_path, {"state": "failed", "started_at": ROUND_START})
    bridge.config_path = root / "config.json"
    bridge.config_path.write_text("{}", encoding="utf-8")
    bridge.video_analysis_enabled = True
    bridge.image_ocr_enabled = False
    bridge.video_analysis_runner = root / "run-video-analysis.ps1"
    bridge.video_analysis_runner.write_text("", encoding="utf-8")
    bridge.powershell = root / "powershell.exe"
    bridge.powershell.write_bytes(b"tool")
    bridge.diandian_report_path = bridge.state_dir / "diandian-rerun-report.json"
    bridge._summary_report_lock = __import__("threading").RLock()
    bridge.trusted_content_sha256 = lambda candidate: "b" * 64
    return bridge


def offline_run_writing_a_transcript(bridge):
    transcript = bridge.state_dir / "video-analysis" / NOTE_ID / "transcription.json"
    text = "可信的本地转写正文"

    def run(command, **kwargs):
        transcript.parent.mkdir(parents=True, exist_ok=True)
        transcript.write_text(json.dumps({
            "schema_version": 1,
            "status": "transcribed",
            "method": "local_transcription",
            "provider": "faster-whisper",
            "tool_version": "fixture",
            "content_sha256": "b" * 64,
            "result_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "text": text,
        }), encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, "{}", "")

    return run


class EvidenceFallbackTests(unittest.TestCase):
    def test_a_leftover_stop_does_not_cancel_offline_transcription_of_cached_media(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = bridge_with_cached_video(Path(directory))
            BRIDGE.atomic_json(bridge.state_dir / STOP_NAME, LEFTOVER)
            self.assertFalse(bridge.fallback_safety_stopped())
            with mock.patch.object(
                BRIDGE, "run_bounded_subprocess", side_effect=offline_run_writing_a_transcript(bridge)
            ) as runner:
                result = bridge.dispatch_evidence_fallback(NOTE_ID, "transport-failed")
            runner.assert_called_once()
            self.assertEqual(result["evidence_status"], "ready")

    def test_a_stop_raised_in_the_current_round_cancels_the_evidence_step(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = bridge_with_cached_video(Path(directory))
            BRIDGE.atomic_json(bridge.state_dir / STOP_NAME, THIS_ROUND)
            self.assertTrue(bridge.fallback_safety_stopped())
            with mock.patch.object(BRIDGE, "run_bounded_subprocess") as runner:
                result = bridge.dispatch_evidence_fallback(NOTE_ID, "transport-failed")
            runner.assert_not_called()
            self.assertEqual(result["reason_code"], "safety_stopped")

    def test_an_unreadable_record_is_never_taken_for_this_round_so_it_does_not_cancel_offline_work(self):
        with tempfile.TemporaryDirectory() as directory:
            bridge = bridge_with_cached_video(Path(directory))
            (bridge.state_dir / STOP_NAME).write_text("{not json", encoding="utf-8")
            self.assertFalse(bridge.fallback_safety_stopped())


class PlatformContactTests(unittest.TestCase):
    def test_any_record_still_blocks_a_media_download(self):
        for name, record in (("leftover", LEFTOVER), ("this round", THIS_ROUND)):
            with self.subTest(record=name), tempfile.TemporaryDirectory() as directory:
                bridge = bridge_with_cached_video(Path(directory))
                bridge.video_analysis_enabled = True
                bridge.curation = Path(directory) / "curation.json"
                BRIDGE.atomic_json(bridge.state_dir / STOP_NAME, record)
                with mock.patch.object(BRIDGE, "run_bounded_subprocess") as downloader:
                    result = bridge.cache_missing_media({
                        NOTE_ID: f"https://www.xiaohongshu.com/explore/{NOTE_ID}",
                    })
                downloader.assert_not_called()
                self.assertTrue(result["safety_stopped"])


@unittest.skipUnless(
    os.name == "nt" and shutil.which("powershell.exe"),
    "the offline analysis runner is a Windows PowerShell script",
)
class OfflineRunnerTests(unittest.TestCase):
    def test_the_offline_runner_runs_image_ocr_even_when_the_last_round_ended_in_a_safety_stop(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            state_dir = workspace / ".xhs-favorites"
            (state_dir / "media").mkdir(parents=True)
            (workspace / "tools").mkdir()
            (workspace / "tools" / "ocr-engine.cmd").write_text("@echo off\r\n", encoding="utf-8")
            (workspace / "config").mkdir()
            config = workspace / "config" / "xhs-favorites.json"
            config.write_text(json.dumps({
                "curation_file": "curation.json",
                "image_ocr": {"enabled": True, "engine": "tools/ocr-engine.cmd"},
            }), encoding="utf-8")
            (workspace / "curation.json").write_text("{}", encoding="utf-8")
            (state_dir / "catalog.json").write_text(
                json.dumps({"version": 1, "notes": {NOTE_ID: {"note_id": NOTE_ID}}}), encoding="utf-8"
            )
            (state_dir / "manual-sync.json").write_text(
                json.dumps({"state": "safety-stopped", "frozen_scope": {"note_ids": [NOTE_ID]}}),
                encoding="utf-8",
            )
            environment = {
                **os.environ,
                "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
            }
            completed = subprocess.run(
                [
                    shutil.which("powershell.exe"), "-NoProfile", "-NonInteractive",
                    "-ExecutionPolicy", "Bypass", "-File", str(RUNNER),
                    "-Workspace", str(workspace), "-Config", str(config), "-NoteId", NOTE_ID,
                ],
                capture_output=True, text=True, timeout=90, env=environment,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
            self.assertTrue(
                (state_dir / "image-ocr-status.json").is_file(),
                "the OCR step was skipped because of the safety stop: " + completed.stdout,
            )


@unittest.skipUnless(
    os.name == "nt" and shutil.which("powershell.exe"),
    "the offline analysis runner is a Windows PowerShell script",
)
class OfflineRunnerScopeTests(unittest.TestCase):
    """The runner finds the round's sealed notes whichever way the round record is stored."""

    def run_runner_for(self, record_of):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)
            state_dir = workspace / ".xhs-favorites"
            (state_dir / "media").mkdir(parents=True)
            (state_dir / "media" / f"{NOTE_ID}.jpg").write_bytes(b"image")
            (workspace / "tools").mkdir()
            (workspace / "tools" / "ocr-engine.cmd").write_text("@echo off\r\necho recognised\r\n", encoding="utf-8")
            (workspace / "config").mkdir()
            config = workspace / "config" / "xhs-favorites.json"
            config.write_text(json.dumps({
                "curation_file": "curation.json",
                "image_ocr": {"enabled": True, "engine": "tools/ocr-engine.cmd"},
            }), encoding="utf-8")
            (workspace / "curation.json").write_text("{}", encoding="utf-8")
            (state_dir / "catalog.json").write_text(json.dumps({
                "version": 1, "notes": {NOTE_ID: {"note_id": NOTE_ID, "content_sha256": "b" * 64}},
            }), encoding="utf-8")
            (state_dir / "manual-sync.json").write_text(json.dumps(record_of()), encoding="utf-8")
            environment = {
                **os.environ,
                "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
            }
            completed = subprocess.run(
                [
                    shutil.which("powershell.exe"), "-NoProfile", "-NonInteractive",
                    "-ExecutionPolicy", "Bypass", "-File", str(RUNNER),
                    "-Workspace", str(workspace), "-Config", str(config),
                ],
                capture_output=True, text=True, timeout=90, env=environment,
            )
            self.assertEqual(completed.returncode, 0, completed.stderr + completed.stdout)
            report = json.loads((state_dir / "image-ocr-status.json").read_text(encoding="utf-8"))
            return [record["note_id"] for record in report["records"]]

    def test_an_old_single_level_round_gives_the_runner_its_sealed_notes(self):
        legacy = {"state": "safety-stopped", "frozen_scope": {"note_ids": [NOTE_ID]}}
        self.assertEqual(self.run_runner_for(lambda: legacy), [NOTE_ID])

    def test_a_staged_round_gives_the_runner_its_sealed_notes(self):
        state = load("xhs_state_offline_work", "organization_state.py")

        def staged():
            record = state.apply_event(None, "round_started", {
                "batch": "manual20261012090000", "started_at": ROUND_START,
                "run_board_ids": ["b1"], "mode": "incremental",
            })
            return state.apply_event(record, "board_imported", {
                "run_id": "manual20261012090000_b1", "board_id": "b1", "board_name": "A",
                "outcome": "safety-stopped", "scanned": 1, "new": None, "note_ids": [NOTE_ID],
                "config_sha256": "c" * 64,
            })

        record = staged()
        self.assertIn("frozen_scope", record["bookkeeping"])
        self.assertNotIn("frozen_scope", record)
        self.assertEqual(self.run_runner_for(staged), [NOTE_ID])


if __name__ == "__main__":
    unittest.main()
