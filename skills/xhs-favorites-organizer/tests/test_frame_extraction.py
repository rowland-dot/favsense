import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "skills" / "xhs-favorites-organizer" / "scripts" / "extract-pending-frames.py"


class FrameExtractionQueueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SCRIPT.is_file():
            raise AssertionError("extract-pending-frames.py must exist")
        spec = importlib.util.spec_from_file_location("frame_extractor", SCRIPT)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_queue_skips_curated_and_already_extracted_videos(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "media"
            analysis = root / "analysis"
            media.mkdir()
            pending = "a" * 24
            curated = "b" * 24
            extracted = "c" * 24
            for note_id in [pending, curated, extracted]:
                (media / f"{note_id}.mp4").write_bytes(b"video")
            extracted_dir = analysis / extracted
            extracted_dir.mkdir(parents=True)
            (extracted_dir / "extraction.json").write_text(
                json.dumps({"status": "frames-extracted"}), encoding="utf-8"
            )
            queue = self.module.build_frame_queue(
                media,
                {curated: {"summary": "done"}},
                analysis,
                max_items=10,
                require_visual_recommendation=False,
            )
            self.assertEqual([item["note_id"] for item in queue], [pending])

    def test_queue_limit_is_deterministic(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "media"
            media.mkdir()
            for character in "abcd":
                (media / f"{character * 24}.mp4").write_bytes(b"video")
            queue = self.module.build_frame_queue(
                media, {}, root / "analysis", max_items=2, require_visual_recommendation=False
            )
            self.assertEqual([item["note_id"] for item in queue], ["a" * 24, "b" * 24])

    def test_queue_can_be_limited_to_catalog_note_ids(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "media"
            media.mkdir()
            catalogued = "a" * 24
            unrelated = "b" * 24
            (media / f"{catalogued}.mp4").write_bytes(b"video")
            (media / f"{unrelated}.mp4").write_bytes(b"video")
            queue = self.module.build_frame_queue(
                media,
                {},
                root / "analysis",
                max_items=10,
                allowed_note_ids={catalogued},
                require_visual_recommendation=False,
            )
            self.assertEqual([item["note_id"] for item in queue], [catalogued])

    def test_catalog_scope_excludes_old_and_undated_notes(self):
        catalog = {"notes": {
            "a" * 24: {"published_at": "2026-01-01_00:00:00"},
            "b" * 24: {"published_at": "2025-12-31_23:59:59"},
            "c" * 24: {},
        }}
        self.assertEqual(
            self.module.catalog_note_ids(catalog, "2026-01-01"),
            {"a" * 24},
        )

    def test_review_queue_only_selects_extracted_videos_without_pages(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pending = "a" * 24
            complete = "b" * 24
            curated = "c" * 24
            for note_id in [pending, complete, curated]:
                note_dir = root / note_id
                note_dir.mkdir()
                (note_dir / "extraction.json").write_text(
                    json.dumps({"status": "frames-extracted", "sequence_frame_count": 4}),
                    encoding="utf-8",
                )
                (note_dir / "frames").mkdir()
            (root / complete / "review-pages-100").mkdir()
            (root / complete / "review-pages-100" / "page_001.jpg").write_bytes(b"page")
            queue = self.module.build_review_queue(
                root,
                {curated: {"summary": "done"}},
                max_items=10,
                allowed_note_ids={pending, complete, curated},
            )
            self.assertEqual([item["note_id"] for item in queue], [pending])

    def test_review_queue_accepts_progressive_visual_windows(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            note_id = "a" * 24
            note_dir = root / note_id
            note_dir.mkdir()
            (note_dir / "extraction.json").write_text(json.dumps({
                "status": "visual-window-ready",
                "sequence_frame_count": 2,
            }), encoding="utf-8")
            frames = note_dir / "frames"
            frames.mkdir()
            (frames / "seq_w001_0001.jpg").write_bytes(b"frame")

            queue = self.module.build_review_queue(root, {}, 10)

            self.assertEqual([item["note_id"] for item in queue], [note_id])

    def test_queue_only_selects_transcripts_requiring_visual_review(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "media"
            analysis = root / "analysis"
            media.mkdir()
            sparse = "a" * 24
            none = "b" * 24
            missing = "c" * 24
            for note_id in [sparse, none, missing]:
                (media / f"{note_id}.mp4").write_bytes(b"video")
            for note_id, level in [(sparse, "sparse"), (none, "none")]:
                note_dir = analysis / note_id
                note_dir.mkdir(parents=True)
                (note_dir / "transcription.json").write_text(
                    json.dumps({
                        "status": "transcribed",
                        "visual_review": {
                            "level": level,
                            "missing_facts": ["entity-name"] if level == "sparse" else [],
                        },
                    }),
                    encoding="utf-8",
                )

            queue = self.module.build_frame_queue(media, {}, analysis, max_items=10)

            self.assertEqual([item["note_id"] for item in queue], [sparse])

    def test_sparse_label_without_a_missing_fact_does_not_extract_frames(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "media"
            analysis = root / "analysis"
            media.mkdir()
            note_id = "a" * 24
            (media / f"{note_id}.mp4").write_bytes(b"video")
            note_dir = analysis / note_id
            note_dir.mkdir(parents=True)
            (note_dir / "transcription.json").write_text(json.dumps({
                "status": "transcribed",
                "visual_review": {"level": "sparse", "missing_facts": []},
            }), encoding="utf-8")

            self.assertEqual(self.module.build_frame_queue(media, {}, analysis, 10), [])

    def test_visual_review_resumes_at_next_unchecked_window(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "media"
            analysis = root / "analysis"
            media.mkdir()
            note_id = "a" * 24
            (media / f"{note_id}.mp4").write_bytes(b"video")
            note_dir = analysis / note_id
            note_dir.mkdir(parents=True)
            (note_dir / "transcription.json").write_text(json.dumps({
                "status": "transcribed",
                "visual_review": {"level": "sparse", "missing_facts": ["entity-name"]},
            }), encoding="utf-8")
            (note_dir / "extraction.json").write_text(json.dumps({
                "status": "visual-window-ready",
                "next_start_seconds": 30,
            }), encoding="utf-8")

            queue = self.module.build_frame_queue(media, {}, analysis, 10)

            self.assertEqual(queue[0]["start_seconds"], 30)

    def test_scene_frames_are_deducted_before_dense_budget(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            note_id = "a" * 24
            video = root / f"{note_id}.mp4"
            video.write_bytes(b"video")

            def fake_run(command, timeout=900):
                output = Path(command[-1])
                output.parent.mkdir(parents=True, exist_ok=True)
                limit = int(command[command.index("-frames:v") + 1])
                for index in range(1, limit + 1):
                    filename = output.name.replace("%04d", f"{index:04d}")
                    (output.parent / filename).write_bytes(b"frame")

            with mock.patch.object(self.module, "probe_duration", return_value=60), mock.patch.object(
                self.module, "run", side_effect=fake_run
            ):
                manifest = self.module.extract_video(
                    Path("ffmpeg"), Path("ffprobe"),
                    {"note_id": note_id, "video": video, "missing_facts": ["entity-name"]},
                    root / "analysis",
                    ["0:5"],
                    max_total_frames=10,
                )

            self.assertEqual(manifest["budget"]["used_frames"], 10)
            self.assertEqual(manifest["dense_frame_count"], 0)


if __name__ == "__main__":
    unittest.main()
