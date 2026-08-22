import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "save_diandian_batch.py"
SUMMARY_SCRIPT = SCRIPT.with_name("save_diandian_summary.py")
SPEC = importlib.util.spec_from_file_location("save_diandian_batch_test", SCRIPT)
BATCH = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.path.insert(0, str(SCRIPT.parent))
try:
    SPEC.loader.exec_module(BATCH)
finally:
    sys.path.pop(0)


class SaveDiandianBatchTests(unittest.TestCase):
    def test_imports_keyed_records_only_under_private_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private_root = root / ".xhs-favorites" / "diandian-summaries"
            batch = root / "batch.json"
            note_id = "a" * 24
            batch.write_text(json.dumps({
                "succeeded": [{"note_id": note_id, "title": "Example", "summary": "A complete safe summary."}]
            }), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--input", str(batch), "--private-root", str(private_root)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            record = json.loads((private_root / f"{note_id}.json").read_text(encoding="utf-8"))
            self.assertEqual(record["note_id"], note_id)

    def test_rejects_duplicate_note_ids_before_reporting_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private_root = root / ".xhs-favorites" / "diandian-summaries"
            batch = root / "batch.json"
            note_id = "b" * 24
            item = {"note_id": note_id, "title": "Example", "summary": "A complete safe summary."}
            batch.write_text(json.dumps({"succeeded": [item, item]}), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--input", str(batch), "--private-root", str(private_root)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("duplicate note_id", result.stderr)

    def test_validates_every_item_before_writing_any_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private_root = root / ".xhs-favorites" / "diandian-summaries"
            batch = root / "batch.json"
            first_id = "c" * 24
            second_id = "d" * 24
            batch.write_text(json.dumps({
                "succeeded": [
                    {"note_id": first_id, "title": "Valid", "summary": "A complete safe summary."},
                    {"note_id": second_id, "title": "Invalid", "summary": None},
                ]
            }), encoding="utf-8")

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--input", str(batch), "--private-root", str(private_root)],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("strings", result.stderr)
            self.assertFalse((private_root / f"{first_id}.json").exists())
            self.assertFalse((private_root / f"{second_id}.json").exists())

    def test_late_sensitive_item_does_not_partially_commit_the_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private_root = root / ".xhs-favorites" / "diandian-summaries"
            batch = root / "batch.json"
            first_id = "e" * 24
            second_id = "f" * 24
            batch.write_text(json.dumps({
                "succeeded": [
                    {"note_id": first_id, "title": "Valid", "summary": "A complete safe summary."},
                    {
                        "note_id": second_id,
                        "title": "Invalid",
                        "summary": "Authorization: Bearer abcdefghijklmnop",
                    },
                ]
            }), encoding="utf-8")

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--input", str(batch), "--private-root", str(private_root)],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("sensitive", result.stderr)
            self.assertFalse((private_root / f"{first_id}.json").exists())
            self.assertFalse((private_root / f"{second_id}.json").exists())

    def test_commit_failure_rolls_back_records_already_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private_root = root / ".xhs-favorites" / "diandian-summaries"
            batch = root / "batch.json"
            first_id = "g" * 24
            second_id = "h" * 24
            blocked_destination = private_root / f"{second_id}.json"
            blocked_destination.mkdir(parents=True)
            batch.write_text(json.dumps({
                "succeeded": [
                    {"note_id": first_id, "title": "First", "summary": "A complete safe summary."},
                    {"note_id": second_id, "title": "Second", "summary": "Another complete safe summary."},
                ]
            }), encoding="utf-8")

            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--input", str(batch), "--private-root", str(private_root)],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("regular file", result.stderr)
            self.assertFalse((private_root / f"{first_id}.json").exists())
            self.assertTrue(blocked_destination.is_dir())

    def test_rollback_does_not_clobber_a_concurrent_single_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private_root = root / ".xhs-favorites" / "diandian-summaries"
            private_root.mkdir(parents=True)
            first_id = "i" * 24
            second_id = "j" * 24
            first_destination = BATCH.private_destination(private_root, first_id)
            second_destination = BATCH.private_destination(private_root, second_id)
            first_destination.write_text(
                BATCH.serialize_record(
                    BATCH.build_record("Original", "The original safe summary.", first_id)
                ),
                encoding="utf-8",
            )
            prepared = [
                (
                    first_destination,
                    BATCH.build_record("Batch first", "The first batch summary.", first_id),
                ),
                (
                    second_destination,
                    BATCH.build_record("Batch second", "The second batch summary.", second_id),
                ),
            ]
            reply_path = root / "reply.txt"
            reply_path.write_text("The concurrent successful summary.", encoding="utf-8")
            first_installed = threading.Event()
            allow_failure = threading.Event()
            original_replace = Path.replace
            batch_errors = []

            def replace_with_fault(source, target):
                source_path = Path(source)
                target_path = Path(target)
                if source_path.name.endswith(".stage") and target_path == second_destination:
                    raise OSError("injected second-record failure")
                result = original_replace(source_path, target_path)
                if source_path.name.endswith(".stage") and target_path == first_destination:
                    first_installed.set()
                    if not allow_failure.wait(timeout=5):
                        raise TimeoutError("concurrent writer was not started")
                return result

            def commit_batch():
                try:
                    BATCH.commit_records(prepared)
                except Exception as error:  # The injected failure is asserted below.
                    batch_errors.append(error)

            process = None
            batch_thread = threading.Thread(target=commit_batch)
            with mock.patch.object(Path, "replace", autospec=True, side_effect=replace_with_fault):
                batch_thread.start()
                self.assertTrue(first_installed.wait(timeout=5))
                process = subprocess.Popen(
                    [
                        sys.executable,
                        str(SUMMARY_SCRIPT),
                        "--input", str(reply_path),
                        "--private-root", str(private_root),
                        "--title", "Concurrent",
                        "--note-id", first_id,
                    ],
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                try:
                    process.wait(timeout=2)
                    writer_was_blocked = False
                except subprocess.TimeoutExpired:
                    writer_was_blocked = True
                finally:
                    allow_failure.set()
                    batch_thread.join(timeout=5)

            assert process is not None
            stdout, stderr = process.communicate(timeout=5)
            self.assertTrue(writer_was_blocked, (stdout, stderr))
            self.assertFalse(batch_thread.is_alive())
            self.assertEqual(len(batch_errors), 1)
            self.assertRegex(str(batch_errors[0]), "injected second-record failure")
            self.assertEqual(process.returncode, 0, stderr)
            concurrent = json.loads(first_destination.read_text(encoding="utf-8"))
            self.assertEqual(concurrent["title"], "Concurrent")
            self.assertFalse(second_destination.exists())


if __name__ == "__main__":
    unittest.main()
