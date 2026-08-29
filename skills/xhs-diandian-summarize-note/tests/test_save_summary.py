import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import quote


SKILL_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = SKILL_ROOT / "scripts" / "save_diandian_summary.py"
FIXTURE_PATH = Path(__file__).parent / "fixtures" / "diandian-with-footer.txt"


def load_module():
    spec = importlib.util.spec_from_file_location("save_diandian_summary", SCRIPT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SaveDiandianSummaryTests(unittest.TestCase):
    def test_cli_destination_is_derived_from_private_root_and_note_id(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            private_root = Path(temp_dir) / ".xhs-favorites" / "diandian-summaries"
            self.assertEqual(
                module.private_destination(private_root, "a" * 24),
                private_root.resolve() / f"{'a' * 24}.json",
            )
            with self.assertRaisesRegex(ValueError, "private root"):
                module.private_destination(Path(temp_dir) / "site", "a" * 24)

    def test_removes_only_recognized_trailing_footer(self):
        module = load_module()
        source = FIXTURE_PATH.read_text(encoding="utf-8")

        cleaned, removed = module.clean_summary(source)

        self.assertEqual(
            cleaned,
            "核心总结\n\n这是一段应当完整保留的总结正文。\n\n"
            "下一步\n\n如果需要继续执行，就先验证输入是否完整。",
        )
        self.assertEqual(removed, ["以上内容由AI生成，仅供参考。"])

    def test_preserves_relevant_final_paragraph(self):
        module = load_module()
        source = "核心总结\n\n如果输入不完整，就先补齐证据。"

        cleaned, removed = module.clean_summary(source)

        self.assertEqual(cleaned, source)
        self.assertEqual(removed, [])

    def test_writes_clean_private_record_without_source_url(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            destination = Path(temp_dir) / ".xhs-favorites" / "diandian-summaries" / f"{'a' * 24}.json"
            module.save_record(
                destination=destination,
                title="示例笔记",
                summary_text="正文\n\n本回答由AI生成，仅供参考。",
                note_id="a" * 24,
            )

            record = json.loads(destination.read_text(encoding="utf-8"))

        self.assertEqual(record["title"], "示例笔记")
        self.assertEqual(record["summary"], "正文")
        self.assertEqual(record["provider"], "xiaohongshu-diandian")
        self.assertEqual(record["note_id"], "a" * 24)
        self.assertNotIn("source_url", record)
        self.assertNotIn("removed_tail", record)

    def test_live_writer_waits_for_the_shared_organization_mutation_lock(self):
        module = load_module()
        module.PRIVATE_STORE_LOCK_TIMEOUT_SECONDS = 0.05
        with tempfile.TemporaryDirectory() as temp_dir:
            private_root = Path(temp_dir) / ".xhs-favorites" / "diandian-summaries"
            lock = private_root.parent / "organization-migration" / ".apply-lock"
            lock.mkdir(parents=True)
            (lock / "owner.json").write_text(json.dumps({
                "schema_version": 1,
                "pid": os.getpid(),
                "nonce": "synthetic-active-migration",
            }), encoding="utf-8")
            destination = private_root / f"{'f' * 24}.json"
            with self.assertRaisesRegex(TimeoutError, "organization mutation lock"):
                module.save_record(
                    destination=destination,
                    title="示例笔记",
                    summary_text="正文",
                    note_id="f" * 24,
                )
            self.assertFalse(destination.exists())

    @unittest.skipUnless(os.name == "nt", "Windows junction regression")
    def test_organization_lock_rejects_junction_without_deleting_outside_state(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            private_root = root / ".xhs-favorites" / "diandian-summaries"
            private_root.mkdir(parents=True)
            outside = root / "outside"
            stale_lock = outside / ".apply-lock"
            stale_lock.mkdir(parents=True)
            sentinel = stale_lock / "outside-sentinel.txt"
            sentinel.write_text("must survive", encoding="utf-8")
            (stale_lock / "owner.json").write_text(json.dumps({
                "schema_version": 1,
                "pid": 999999999,
                "nonce": "synthetic-stale-migration",
            }), encoding="utf-8")
            junction = private_root.parent / "organization-migration"
            result = subprocess.run(
                ["cmd.exe", "/d", "/c", "mklink", "/J", str(junction), str(outside)],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode != 0:
                self.skipTest(f"junction fixture unavailable: {result.stderr.strip()}")

            destination = private_root / f"{'e' * 24}.json"
            with self.assertRaisesRegex(ValueError, "lock root is unsafe"):
                module.save_record(
                    destination=destination,
                    title="示例笔记",
                    summary_text="正文",
                    note_id="e" * 24,
                )

            self.assertEqual(sentinel.read_text(encoding="utf-8"), "must survive")
            self.assertFalse(destination.exists())

    @unittest.skipUnless(os.name == "nt", "Windows console-control regression")
    def test_windows_process_probe_does_not_send_a_console_control_event(self):
        module = load_module()
        with mock.patch.object(
            module.os,
            "kill",
            side_effect=AssertionError("os.kill(pid, 0) emits CTRL_C_EVENT on Windows"),
        ) as kill:
            self.assertTrue(module._process_is_active(os.getpid()))
        kill.assert_not_called()

    @unittest.skipUnless(os.name == "nt", "Windows process-query regression")
    def test_windows_process_probe_treats_query_failure_as_active(self):
        module = load_module()
        with mock.patch("ctypes.WinDLL") as win_dll:
            kernel32 = win_dll.return_value
            kernel32.OpenProcess.return_value = 123
            kernel32.GetExitCodeProcess.return_value = 0

            self.assertTrue(module._process_is_active(os.getpid()))

        kernel32.CloseHandle.assert_called_once_with(123)

    def test_rejects_unsafe_note_id(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            with self.assertRaisesRegex(ValueError, "note_id"):
                module.save_record(
                    destination=Path(temp_dir) / ".xhs-favorites" / "diandian-summaries" / "unsafe.json",
                    title="示例笔记",
                    summary_text="正文",
                    note_id="../outside",
                )

    def test_rejects_existing_case_insensitive_filename_alias(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            private_root = Path(temp_dir) / ".xhs-favorites" / "diandian-summaries"
            private_root.mkdir(parents=True)
            existing = private_root / "CASEID.json"
            existing.write_text("keep", encoding="utf-8")
            destination = private_root / "caseid.json"

            with self.assertRaisesRegex(ValueError, "filename alias"):
                module.save_record(
                    destination=destination,
                    title="示例笔记",
                    summary_text="正文",
                    note_id="caseid",
                )

            self.assertEqual(existing.read_text(encoding="utf-8"), "keep")

    def test_rejects_windows_reserved_note_filename(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            private_root = Path(temp_dir) / ".xhs-favorites" / "diandian-summaries"
            with self.assertRaisesRegex(ValueError, "unsafe filename"):
                module.private_destination(private_root, "CON")

    def test_save_record_rejects_a_destination_outside_the_private_keyed_store(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            destination = Path(temp_dir) / "site" / "data" / "summary.json"
            with self.assertRaisesRegex(ValueError, "private root"):
                module.save_record(
                    destination=destination,
                    title="示例笔记",
                    summary_text="正文",
                    note_id="a" * 24,
                )
            self.assertFalse(destination.exists())

    def test_rejects_signed_xhs_tokens_before_writing(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            destination = Path(temp_dir) / ".xhs-favorites" / "diandian-summaries" / f"{'a' * 24}.json"
            with self.assertRaisesRegex(ValueError, "sensitive"):
                module.save_record(
                    destination=destination,
                    title="示例笔记",
                    summary_text=(
                        "正文 https://www.xiaohongshu.com/explore/example"
                        "?xsec_token=secret"
                    ),
                    note_id="a" * 24,
                )
            self.assertFalse(destination.exists())

    def test_rejects_sensitive_source_data_in_title_before_writing(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            destination = Path(temp_dir) / ".xhs-favorites" / "diandian-summaries" / f"{'b' * 24}.json"
            with self.assertRaisesRegex(ValueError, "sensitive"):
                module.save_record(
                    destination=destination,
                    title="笔记 xsec_token=secret",
                    summary_text="这是一段可以正常保存的点点总结正文。",
                    note_id="b" * 24,
                )
            self.assertFalse(destination.exists())

    def test_rejects_encoded_or_invisible_sensitive_source_data(self):
        module = load_module()
        deeply_encoded_source = "https://www.xiaohongshu.com/board/private"
        for _ in range(6):
            deeply_encoded_source = quote(deeply_encoded_source, safe="")
        unsafe_replies = [
            "正文 %78%73%65%63%5f%74%6f%6b%65%6e%3dsecret",
            "正文 xsec_\u200btoken=secret",
            "正文 https&#58;&#47;&#47;www.xiaohongshu.com&#47;discovery&#47;item&#47;example",
            "正文 %78%73%65%63%5f%E2%80%8B%74%6f%6b%65%6e%3dsecret",
            "正文 https%26%23%35%38%3B%26%23%34%37%3B%26%23%34%37%3Bwww%26period%3Bxiaohongshu%26period%3Bcom%26sol%3Bboard%26sol%3Bprivate",
            f"正文 {deeply_encoded_source}",
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            for index, reply in enumerate(unsafe_replies):
                note_id = f"c{index}" * 12
                destination = Path(temp_dir) / ".xhs-favorites" / "diandian-summaries" / f"{note_id}.json"
                with self.subTest(reply=reply), self.assertRaisesRegex(ValueError, "sensitive"):
                    module.save_record(
                        destination=destination,
                        title="示例笔记",
                        summary_text=reply,
                        note_id=note_id,
                    )
                self.assertFalse(destination.exists())

    def test_rejects_the_same_credential_shapes_as_the_consumers(self):
        module = load_module()
        unsafe_replies = [
            "Authorization: Bearer abcdefghijklmnop",
            "access_token: abcdefghijklmnop",
            "password=not-for-storage",
            "Bearer abcdefghijklmnop",
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            for index, reply in enumerate(unsafe_replies):
                note_id = f"d{index}" * 12
                destination = Path(temp_dir) / ".xhs-favorites" / "diandian-summaries" / f"{note_id}.json"
                with self.subTest(reply=reply), self.assertRaisesRegex(ValueError, "sensitive"):
                    module.save_record(
                        destination=destination,
                        title="示例笔记",
                        summary_text=reply,
                        note_id=note_id,
                    )
                self.assertFalse(destination.exists())

    def test_rejects_an_empty_title_instead_of_fabricating_one(self):
        module = load_module()
        with tempfile.TemporaryDirectory() as temp_dir:
            note_id = "e" * 24
            destination = Path(temp_dir) / ".xhs-favorites" / "diandian-summaries" / f"{note_id}.json"
            with self.assertRaisesRegex(ValueError, "title"):
                module.save_record(
                    destination=destination,
                    title="   ",
                    summary_text="这是一段完整且安全的点点总结正文。",
                    note_id=note_id,
                )
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
