import importlib.util
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "skills" / "xhs-favorites-organizer" / "scripts" / "transcribe-pending-videos.py"


class TranscriptionPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not SCRIPT.is_file():
            raise AssertionError("transcribe-pending-videos.py must exist")
        spec = importlib.util.spec_from_file_location("transcription_pipeline", SCRIPT)
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def test_queue_skips_curated_and_transcribed_videos(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "media"
            analysis = root / "analysis"
            media.mkdir()
            pending = "a" * 24
            curated = "b" * 24
            transcribed = "c" * 24
            for note_id in [pending, curated, transcribed]:
                (media / f"{note_id}.mp4").write_bytes(b"video")
            transcript_dir = analysis / transcribed
            transcript_dir.mkdir(parents=True)
            (transcript_dir / "transcription.json").write_text(
                json.dumps({"status": "transcribed"}), encoding="utf-8"
            )

            queue = self.module.build_transcription_queue(
                media,
                {curated: {"summary": "done"}},
                analysis,
                max_items=10,
            )

            self.assertEqual([item["note_id"] for item in queue], [pending])

    def test_queue_prefers_smaller_videos_for_fast_first_results(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "media"
            media.mkdir()
            large = "a" * 24
            small = "b" * 24
            (media / f"{large}.mp4").write_bytes(b"123456")
            (media / f"{small}.mp4").write_bytes(b"1")

            queue = self.module.build_transcription_queue(
                media, {}, root / "analysis", max_items=2
            )

            self.assertEqual([item["note_id"] for item in queue], [small, large])

    def test_duration_budget_clips_long_items_and_caps_batch(self):
        items = [
            {"note_id": "a" * 24, "video": Path("a.mp4")},
            {"note_id": "b" * 24, "video": Path("b.mp4")},
            {"note_id": "c" * 24, "video": Path("c.mp4")},
        ]
        durations = {"a.mp4": 120.0, "b.mp4": 900.0, "c.mp4": 200.0}

        selected, skipped = self.module.apply_duration_budget(
            items,
            lambda path: durations[path.name],
            max_items=10,
            max_item_seconds=600,
            max_batch_seconds=300,
        )

        self.assertEqual([item["note_id"] for item in selected], ["a" * 24])
        self.assertEqual(skipped, {"clipped": 1, "batch_budget": 2, "source_exhausted": 0})

    def test_truncated_unresolved_transcript_resumes_at_next_window(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "media"
            analysis = root / "analysis"
            note_id = "a" * 24
            media.mkdir()
            (media / f"{note_id}.mp4").write_bytes(b"video")
            note_dir = analysis / note_id
            note_dir.mkdir(parents=True)
            (note_dir / "transcription.json").write_text(json.dumps({
                "status": "partial",
                "audio_window": {"end": 600, "next_start": 600, "truncated": True},
                "visual_review": {"missing_facts": ["entity-name"]},
            }), encoding="utf-8")

            queue = self.module.build_transcription_queue(media, {}, analysis, 10)

            self.assertEqual(queue[0]["resume_start_seconds"], 600)

    def test_truncated_transcript_stops_when_missing_fact_is_resolved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "media"
            analysis = root / "analysis"
            note_id = "a" * 24
            media.mkdir()
            (media / f"{note_id}.mp4").write_bytes(b"video")
            note_dir = analysis / note_id
            note_dir.mkdir(parents=True)
            (note_dir / "transcription.json").write_text(json.dumps({
                "status": "transcribed",
                "audio_window": {"end": 300, "truncated": True},
                "visual_review": {"missing_facts": []},
            }), encoding="utf-8")

            self.assertEqual(self.module.build_transcription_queue(media, {}, analysis, 10), [])

    def test_audio_extraction_failure_removes_temporary_wav(self):
        with tempfile.TemporaryDirectory() as temporary:
            analysis = Path(temporary) / "analysis"
            item = {
                "note_id": "a" * 24,
                "video": Path(temporary) / "video.mp4",
                "source_duration_seconds": 30,
                "audio_limit_seconds": 30,
            }

            def failing_run(command):
                Path(command[-1]).write_bytes(b"partial")
                raise RuntimeError("ffmpeg failed")

            with mock.patch.object(self.module, "run", side_effect=failing_run):
                with self.assertRaises(RuntimeError):
                    self.module.transcribe_video(
                        object(),
                        Path("ffmpeg"),
                        item,
                        {"content_sha256": "b" * 64},
                        analysis,
                        "zh",
                        False,
                        tool_version=self.module.transcription_tool_version(
                            "1.2.3", "small", "cpu", "int8"
                        ),
                    )

            self.assertFalse((analysis / item["note_id"] / "audio-16khz.wav").exists())
            artifact = json.loads(
                (analysis / item["note_id"] / "transcription.json").read_text(encoding="utf-8")
            )
            self.assertEqual(artifact["status"], "failed")
            self.assertEqual(artifact["content_sha256"], "b" * 64)
            self.assertEqual(artifact["method"], "local_transcription")
            self.assertEqual(artifact["provider"], "faster-whisper")
            self.assertEqual(
                artifact["tool_version"],
                self.module.transcription_tool_version(
                    "1.2.3", "small", "cpu", "int8"
                ),
            )
            self.assertEqual(artifact["reason_code"], "transcription_failed")
            self.assertNotIn("text", artifact)

    def test_successful_transcript_binds_the_catalog_revision_and_tool_contract(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            analysis = root / "analysis"
            note_id = "a" * 24
            content_sha256 = "b" * 64
            item = {
                "note_id": note_id,
                "video": root / "video.mp4",
                "source_duration_seconds": 4,
                "audio_start_seconds": 0,
                "audio_limit_seconds": 4,
            }

            class Segment:
                start = 0
                end = 1
                text = " revision bound transcript "
                avg_logprob = -0.1
                no_speech_prob = 0.0

            class Info:
                language = "zh"
                language_probability = 1.0
                duration = 4

            class Model:
                def transcribe(self, *_args, **_kwargs):
                    return iter([Segment()]), Info()

            def fake_run(command):
                Path(command[-1]).write_bytes(b"synthetic wav")

            with mock.patch.object(self.module, "run", side_effect=fake_run):
                tool_version = self.module.transcription_tool_version(
                    "1.2.3", "small", "cpu", "int8"
                )
                result = self.module.transcribe_video(
                    Model(),
                    Path("ffmpeg"),
                    item,
                    {"content_sha256": content_sha256},
                    analysis,
                    "zh",
                    False,
                    tool_version=tool_version,
                )

            artifact = json.loads(
                (analysis / note_id / "transcription.json").read_text(encoding="utf-8")
            )
            self.assertEqual(result["status"], "transcribed")
            self.assertEqual(artifact["schema_version"], 1)
            self.assertEqual(artifact["content_sha256"], content_sha256)
            self.assertEqual(artifact["method"], "local_transcription")
            self.assertEqual(artifact["provider"], "faster-whisper")
            self.assertEqual(artifact["tool_version"], tool_version)
            self.assertEqual(
                artifact["result_sha256"],
                hashlib.sha256(artifact["text"].encode("utf-8")).hexdigest(),
            )
            self.assertNotEqual(
                tool_version,
                self.module.transcription_tool_version(
                    "1.2.3", "medium", "cpu", "int8"
                ),
            )

    def test_stale_or_different_tool_transcripts_are_requeued_and_not_reassessed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "media"
            analysis = root / "analysis"
            media.mkdir()
            current_id = "a" * 24
            stale_id = "b" * 24
            tool_id = "c" * 24
            current_revision = "d" * 64
            stale_revision = "e" * 64
            tool_version = self.module.transcription_tool_version(
                "1.2.3", "small", "cpu", "int8"
            )
            other_tool_version = self.module.transcription_tool_version(
                "1.2.3", "medium", "cpu", "int8"
            )
            text = "This current transcript contains enough concrete words for reassessment."

            def artifact(content_sha256, version):
                return {
                    "schema_version": 1,
                    "status": "partial",
                    "method": "local_transcription",
                    "provider": "faster-whisper",
                    "tool_version": version,
                    "content_sha256": content_sha256,
                    "result_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                    "text": text,
                    "audio_window": {
                        "end": 10,
                        "next_start": 10,
                        "truncated": True,
                        "complete": False,
                    },
                    "visual_review": {"missing_facts": ["content-summary"]},
                }

            records = {
                current_id: artifact(current_revision, tool_version),
                stale_id: artifact("f" * 64, tool_version),
                tool_id: artifact(current_revision, other_tool_version),
            }
            original_bytes = {}
            for note_id, record in records.items():
                (media / f"{note_id}.mp4").write_bytes(b"video")
                transcript_path = analysis / note_id / "transcription.json"
                transcript_path.parent.mkdir(parents=True)
                transcript_path.write_text(json.dumps(record), encoding="utf-8")
                original_bytes[note_id] = transcript_path.read_bytes()

            revisions = {
                current_id: current_revision,
                stale_id: stale_revision,
                tool_id: current_revision,
            }
            queue = self.module.build_transcription_queue(
                media,
                {},
                analysis,
                10,
                allowed_note_ids=set(revisions),
                content_sha256_by_id=revisions,
                tool_version=tool_version,
            )
            queued = {item["note_id"]: item["resume_start_seconds"] for item in queue}
            self.assertEqual(queued[stale_id], 0)
            self.assertEqual(queued[tool_id], 0)
            self.assertEqual(queued[current_id], 10)

            notes = {
                note_id: {
                    "content_sha256": revision,
                    "title": "safe title",
                    "description": "",
                }
                for note_id, revision in revisions.items()
            }
            with mock.patch.object(
                self.module, "_atomic_json", wraps=self.module._atomic_json
            ) as atomic_json:
                result = self.module.reassess_transcripts(
                    analysis, notes, tool_version=tool_version
                )

            self.assertEqual(result["reassessed"], 1)
            atomic_json.assert_called_once()
            for note_id in (stale_id, tool_id):
                self.assertEqual(
                    (analysis / note_id / "transcription.json").read_bytes(),
                    original_bytes[note_id],
                )

    def test_malformed_transcript_shapes_fail_closed_to_a_fresh_queue_item(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "media"
            analysis = root / "analysis"
            media.mkdir()
            non_object_id = "a" * 24
            nested_shape_id = "b" * 24
            nested_value_id = "d" * 24
            malformed_segments_id = "e" * 24
            huge_number_id = "f" * 24
            malformed_segment_fields_id = "1" * 24
            revision = "c" * 64
            tool_version = self.module.transcription_tool_version(
                "1.2.3", "small", "cpu", "int8"
            )
            malformed = {
                non_object_id: [],
                nested_shape_id: {
                    "schema_version": 1,
                    "status": "partial",
                    "method": "local_transcription",
                    "provider": "faster-whisper",
                    "tool_version": tool_version,
                    "content_sha256": revision,
                    "result_sha256": hashlib.sha256(b"valid text").hexdigest(),
                    "text": "valid text",
                    "audio_window": [],
                    "visual_review": [],
                },
                nested_value_id: {
                    "schema_version": 1,
                    "status": "partial",
                    "method": "local_transcription",
                    "provider": "faster-whisper",
                    "tool_version": tool_version,
                    "content_sha256": revision,
                    "result_sha256": hashlib.sha256(b"valid text").hexdigest(),
                    "text": "valid text",
                    "audio_window": {
                        "next_start": ["not-a-number"],
                        "truncated": True,
                    },
                    "visual_review": {"missing_facts": ["content-summary"]},
                    "segments": [],
                },
                malformed_segments_id: {
                    "schema_version": 1,
                    "status": "partial",
                    "method": "local_transcription",
                    "provider": "faster-whisper",
                    "tool_version": tool_version,
                    "content_sha256": revision,
                    "result_sha256": hashlib.sha256(b"valid text").hexdigest(),
                    "text": "valid text",
                    "audio_window": {
                        "next_start": 10,
                        "truncated": True,
                    },
                    "visual_review": {"missing_facts": ["content-summary"]},
                    "segments": ["not-an-object"],
                },
                huge_number_id: {
                    "schema_version": 1,
                    "status": "partial",
                    "method": "local_transcription",
                    "provider": "faster-whisper",
                    "tool_version": tool_version,
                    "content_sha256": revision,
                    "result_sha256": hashlib.sha256(b"valid text").hexdigest(),
                    "text": "valid text",
                    "audio_window": {
                        "next_start": int("9" * 4000),
                        "truncated": True,
                    },
                    "visual_review": {"missing_facts": ["content-summary"]},
                    "segments": [],
                },
                malformed_segment_fields_id: {
                    "schema_version": 1,
                    "status": "partial",
                    "method": "local_transcription",
                    "provider": "faster-whisper",
                    "tool_version": tool_version,
                    "content_sha256": revision,
                    "result_sha256": hashlib.sha256(b"valid text").hexdigest(),
                    "text": "valid text",
                    "audio_window": {
                        "next_start": 10,
                        "truncated": True,
                    },
                    "visual_review": {"missing_facts": ["content-summary"]},
                    "segments": [{
                        "start": [],
                        "end": False,
                        "text": "valid text",
                        "avg_logprob": {},
                        "no_speech_prob": ["bad"],
                    }],
                },
            }
            for note_id, artifact in malformed.items():
                (media / f"{note_id}.mp4").write_bytes(b"video")
                transcript_path = analysis / note_id / "transcription.json"
                transcript_path.parent.mkdir(parents=True)
                transcript_path.write_text(json.dumps(artifact), encoding="utf-8")

            queue = self.module.build_transcription_queue(
                media,
                {},
                analysis,
                10,
                allowed_note_ids=set(malformed),
                content_sha256_by_id={
                    note_id: revision for note_id in malformed
                },
                tool_version=tool_version,
            )

            self.assertEqual(
                {item["note_id"]: item["resume_start_seconds"] for item in queue},
                {
                    non_object_id: 0,
                    nested_shape_id: 0,
                    nested_value_id: 0,
                    malformed_segments_id: 0,
                    huge_number_id: 0,
                    malformed_segment_fields_id: 0,
                },
            )

    def test_failed_continuation_preserves_verified_partial_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            analysis = root / "analysis"
            note_id = "a" * 24
            revision = "b" * 64
            tool_version = self.module.transcription_tool_version(
                "1.2.3", "small", "cpu", "int8"
            )
            text = "verified partial transcript"
            transcript_path = analysis / note_id / "transcription.json"
            transcript_path.parent.mkdir(parents=True)
            transcript_path.write_text(json.dumps({
                "schema_version": 1,
                "status": "partial",
                "method": "local_transcription",
                "provider": "faster-whisper",
                "tool_version": tool_version,
                "content_sha256": revision,
                "result_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                "text": text,
                "segments": [],
                "audio_window": {
                    "end": 10,
                    "next_start": 10,
                    "truncated": True,
                    "complete": False,
                },
                "visual_review": {"missing_facts": ["content-summary"]},
            }), encoding="utf-8")
            original = transcript_path.read_bytes()
            item = {
                "note_id": note_id,
                "video": root / "video.mp4",
                "source_duration_seconds": 20,
                "audio_start_seconds": 10,
                "audio_limit_seconds": 10,
            }

            with mock.patch.object(
                self.module, "run", side_effect=RuntimeError("synthetic failure")
            ):
                with self.assertRaises(RuntimeError):
                    self.module.transcribe_video(
                        object(),
                        Path("ffmpeg"),
                        item,
                        {"content_sha256": revision},
                        analysis,
                        "zh",
                        False,
                        tool_version=tool_version,
                    )

            self.assertEqual(transcript_path.read_bytes(), original)

    def test_open_source_tool_name_does_not_replace_repository_identity(self):
        note = {"title": "一个很实用的开源视频工具", "description": ""}
        transcript = "这个项目叫 AutoClip，可以下载视频并自动识别高光片段。"

        assessment = self.module.assess_visual_need(note, transcript)

        self.assertEqual(assessment["level"], "sparse")
        self.assertIn("repository-identity-unverified", assessment["reasons"])
        self.assertEqual(assessment["missing_facts"], ["repository-identity"])

    def test_tagged_tool_name_does_not_hide_an_unverified_github_repository(self):
        note = {
            "title": "GitHub video translation tool",
            "description": "#video #VividDub #translation",
            "tags": "video VividDub translation",
        }
        transcript = "This tool translates and dubs videos, and the name is shown on screen."

        assessment = self.module.assess_visual_need(note, transcript)

        self.assertEqual(self.module.tagged_entity_candidates(note), ["VividDub"])
        self.assertEqual(assessment["level"], "sparse")
        self.assertIn("repository-identity-unverified", assessment["reasons"])
        self.assertEqual(assessment["missing_facts"], ["repository-identity"])

    def test_explicit_github_repository_stops_repository_visual_review(self):
        note = {
            "title": "GitHub video translation tool",
            "description": "#video #VividDub #translation",
            "tags": "video VividDub translation",
        }
        transcript = "The official repository is VividDub/VividDub and it translates and dubs videos."

        assessment = self.module.assess_visual_need(note, transcript)

        self.assertEqual(assessment["level"], "none")
        self.assertEqual(assessment["missing_facts"], [])

    def test_spaced_github_repository_stops_repository_visual_review(self):
        note = {
            "title": "GitHub video translation tool",
            "description": "#video #VividDub #translation",
            "tags": "video VividDub translation",
        }
        transcript = "The official repository is VividDub / VividDub and it translates videos."

        assessment = self.module.assess_visual_need(note, transcript)

        self.assertEqual(assessment["level"], "none")
        self.assertEqual(assessment["missing_facts"], [])

    def test_unrelated_slash_pair_does_not_count_as_github_repository(self):
        note = {
            "title": "GitHub video translation tool",
            "description": "#video #VividDub #translation",
            "tags": "video VividDub translation",
        }
        transcript = "It accepts YouTube/TikTok links and translates videos with VividDub."

        assessment = self.module.assess_visual_need(note, transcript)

        self.assertEqual(assessment["level"], "sparse")
        self.assertIn("repository-identity-unverified", assessment["reasons"])
        self.assertEqual(assessment["missing_facts"], ["repository-identity"])

    def test_repository_feature_slash_pair_does_not_count_as_repository_identity(self):
        note = {
            "title": "GitHub video translation tool",
            "description": "#video #VividDub #translation",
            "tags": "video VividDub translation",
        }
        transcript = "The repository supports YouTube/TikTok links and the product is VividDub."

        assessment = self.module.assess_visual_need(note, transcript)

        self.assertEqual(assessment["level"], "sparse")
        self.assertIn("repository-identity-unverified", assessment["reasons"])
        self.assertEqual(assessment["missing_facts"], ["repository-identity"])

    def test_generic_tags_do_not_hide_a_missing_tool_name(self):
        note = {
            "title": "这个工具很好用",
            "description": "#video #translation #ai",
            "tags": "video translation ai",
        }
        transcript = "这个技能可以翻译视频，具体名字只在画面里展示，大家看屏幕。"

        assessment = self.module.assess_visual_need(note, transcript)

        self.assertEqual(self.module.tagged_entity_candidates(note), [])
        self.assertEqual(assessment["level"], "sparse")
        self.assertTrue(assessment["missing_facts"])

    def test_lowercase_topic_tag_in_title_is_not_a_brand(self):
        note = {
            "title": "AI design tool",
            "description": "#design",
            "tags": "design",
        }
        transcript = "这个工具用于界面设计，准确名称只在屏幕中出现。"

        assessment = self.module.assess_visual_need(note, transcript)

        self.assertEqual(self.module.tagged_entity_candidates(note), [])
        self.assertEqual(assessment["level"], "sparse")

    def test_title_case_topic_tag_is_not_a_brand(self):
        note = {
            "title": "AI Design tool",
            "description": "#Design #Productivity",
            "tags": "Design Productivity",
        }
        transcript = "这个工具用于界面设计，准确名称只在屏幕中出现。"

        assessment = self.module.assess_visual_need(note, transcript)

        self.assertEqual(self.module.tagged_entity_candidates(note), [])
        self.assertEqual(assessment["level"], "sparse")

    def test_visual_review_is_requested_when_skill_name_is_hidden(self):
        note = {"title": "这个 Skill 太好用了", "description": "名字就在画面里"}
        transcript = "这个技能可以把长视频自动整理成多个短视频，大家看屏幕。"

        assessment = self.module.assess_visual_need(note, transcript)

        self.assertEqual(assessment["level"], "sparse")
        self.assertIn("entity-name-missing", assessment["reasons"])
        self.assertEqual(assessment["missing_facts"], ["entity-name"])
        self.assertTrue(assessment["stop_when_resolved"])

    def test_generic_english_words_do_not_count_as_a_hidden_project_name(self):
        note = {"title": "OpenClaw 工具推荐", "description": ""}
        transcript = "记住这个名字，它在 GitHub 有很多 Star，也支持 MCP 和 Codex。"

        assessment = self.module.assess_visual_need(note, transcript)

        self.assertEqual(assessment["level"], "sparse")
        self.assertIn("entity-name-missing", assessment["reasons"])

    def test_numbered_github_project_names_still_need_repository_identities(self):
        note = {"title": "六个 GitHub 项目", "description": ""}
        transcript = "第一个 OpenHuman 是本地 AI 助手，第二个 CodeBrowser 是浏览器。"

        assessment = self.module.assess_visual_need(note, transcript)

        self.assertEqual(assessment["level"], "sparse")
        self.assertIn("repository-identity-unverified", assessment["reasons"])
        self.assertEqual(assessment["missing_facts"], ["repository-identity"])

    def test_explaining_what_aesthetic_means_is_not_a_project_name(self):
        note = {"title": "这个 Skill 专治 AI 味网页", "description": ""}
        transcript = "它先教 AI 什么叫审美，再检查字体、留白和配色。"

        assessment = self.module.assess_visual_need(note, transcript)

        self.assertEqual(assessment["level"], "sparse")

    def test_short_or_empty_transcript_requests_sparse_visual_review(self):
        assessment = self.module.assess_visual_need(
            {"title": "AI 工具展示", "description": ""}, "背景音乐"
        )

        self.assertEqual(assessment["level"], "sparse")
        self.assertIn("insufficient-speech", assessment["reasons"])
        self.assertIn("content-summary", assessment["missing_facts"])

    def test_catalog_scope_excludes_old_and_undated_notes(self):
        catalog = {"notes": {
            "a" * 24: {"published_at": "2026-01-01_00:00:00"},
            "b" * 24: {"published_at": "2025-12-31_23:59:59"},
            "c" * 24: {},
        }}

        self.assertEqual(
            self.module.catalog_notes(catalog, "2026-01-01"),
            {"a" * 24: {"published_at": "2026-01-01_00:00:00"}},
        )


if __name__ == "__main__":
    unittest.main()
