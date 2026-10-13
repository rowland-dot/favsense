"""A DianDian reply that lost text where list items were joined is not a summary.

Some saved replies have a '- ' list marker straight after a full stop, comma, colon or exclamation mark in the
middle of a line, with the rest of that item and the items between missing. Such a reply used to be saved as the
note's summary and later used as review evidence. These tests hold the Python rule that recognises it to the
shared case table of real damaged passages, and check the places that must act on it: the browser-driven
collection step, the page's save request, and the check of an already saved record, which must not change.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import tempfile
import unittest

import bridge_support
from test_diandian_refusal import (
    BRIDGE,
    REFUSAL,
    SAVER,
    SKILL,
    collection_step,
    configure_summary_service,
    normal_text,
    v1_record,
    v2_record,
    write_current_record,
)

CASES = json.loads(
    (SKILL / "test-fixtures" / "diandian-incomplete-cases.json").read_text(encoding="utf-8")
)["cases"]
INCOMPLETE = [case for case in CASES if case["incomplete"]]
NORMAL = [case for case in CASES if not case["incomplete"]]
INVISIBLE = "\u200b"


class IncompleteTableTests(unittest.TestCase):
    def test_the_table_is_well_formed_and_carries_the_known_forms(self):
        identifiers = [case["id"] for case in CASES]
        self.assertEqual(len(identifiers), len(set(identifiers)))
        for case in CASES:
            with self.subTest(case=case["id"]):
                self.assertEqual(set(case), {"id", "text", "incomplete", "why"})
                self.assertIsInstance(case["incomplete"], bool)
                self.assertTrue(case["text"].strip() and case["why"].strip())
                # Passages only: no whole reply, and nothing that identifies a note.
                self.assertLess(len(case["text"]), 600)
                self.assertIsNone(re.search(r"(?<![0-9A-Za-z])[0-9a-f]{24}(?![0-9A-Za-z])", case["text"]))
        real = [case for case in INCOMPLETE if "onstructed" not in case["why"]]
        self.assertGreaterEqual(len(real), 5)
        # The reply the issue reported, with the join exactly as the page left it.
        self.assertTrue(any("的卖点。- " + INVISIBLE * 2 + "厨房置物架案例" in case["text"] for case in real))
        # Real replies carry zero-width spaces around bold words; the table must keep them.
        self.assertTrue(any(INVISIBLE in case["text"] for case in CASES))
        # All four marks the rule names are covered by a damaged case.
        for mark in "。，：！":
            self.assertTrue(any(mark + "- " in case["text"] for case in INCOMPLETE), mark)
        # The normal replies that sit closest to the signature.
        self.assertTrue(any(case["text"].startswith("以下是核心总结：") for case in NORMAL))
        self.assertTrue(any("\n- " in case["text"] for case in NORMAL))
        for word in ("GPT-4", "2-3 ", "K2.0/K2.6"):
            self.assertTrue(any(word in case["text"] for case in NORMAL), word)

    def test_the_python_rule_follows_the_table(self):
        for case in CASES:
            with self.subTest(case=case["id"]):
                self.assertIs(REFUSAL.is_incomplete(case["text"]), case["incomplete"], case["why"])

    def test_damage_late_in_a_long_reply_is_found_and_a_long_normal_reply_is_not(self):
        # The refusal rule only reads the opening of a reply; this one must read all of it.
        normal = next(case["text"] for case in NORMAL if case["id"].startswith("normal-reply-opens-with-lead-in"))
        damaged = next(case["text"] for case in INCOMPLETE if case["id"].startswith("reported-"))
        long_normal = "\n".join([normal] * 6)
        self.assertGreater(len(long_normal), 1000)
        self.assertIs(REFUSAL.is_incomplete(long_normal), False)
        self.assertIs(REFUSAL.is_incomplete(long_normal + "\n" + damaged), True)

    def test_text_that_is_not_a_string_is_not_incomplete(self):
        for value in (None, 0, [], {}):
            self.assertIs(REFUSAL.is_incomplete(value), False)


def incomplete_text() -> str:
    """The reported damaged passage, long enough to pass the length check the collection step already has."""
    return next(case["text"] for case in INCOMPLETE if case["id"].startswith("reported-"))


class CollectionStepTests(unittest.TestCase):
    def test_an_incomplete_reply_fails_the_note_aborts_the_rest_and_saves_nothing(self):
        # The rule must not be caught by the refusal rule that runs first, or this proves nothing.
        self.assertIs(REFUSAL.is_refusal(incomplete_text()), False)
        with collection_step(incomplete_text()) as step:
            bridge, target = step.bridge, step.target
            failed_id, waiting_id = step.failed_id, step.waiting_id
            self.assertEqual(step.result, {"saved": False, "halted": True, "reason": "diandian-incomplete"})
            self.assertFalse((bridge.diandian_dir / f"{failed_id}.json").exists())
            self.assertEqual(
                [path.name for path in bridge.diandian_dir.glob("*")] if bridge.diandian_dir.exists() else [],
                [],
            )
            self.assertIsNone(bridge.saved_diandian_record(failed_id))
            # The failed page is kept as it is: released to the round, never closed.
            target.close.assert_not_called()
            target.release.assert_called_once()
            # Failed for this note, aborted for the one waiting behind it: both are tried again next round.
            report = json.loads(bridge.diandian_report_path.read_text(encoding="utf-8"))
            statuses = {entry["note_id"]: entry["summary_status"] for entry in report["unresolved"]}
            self.assertEqual(statuses, {failed_id: "failed", waiting_id: "batch_aborted"})
            record = bridge.read_manual_sync()
            self.assertEqual(record["summary_halt_reason"], "diandian-incomplete")
            # Its own message: it says the reply came back incomplete, not that DianDian refused to read.
            self.assertIn("不完整", record["error"])
            self.assertNotIn("没有读取这篇笔记", record["error"])
            self.assertIn("核心整理结果已保留", record["error"])
            self.assertIn("下一轮", record["error"])
            self.assertNotIn("private-token", json.dumps(record, ensure_ascii=False))
            self.assertEqual(bridge.manual_sync_status()["phases"]["summary"]["status"], "failed")


class SaveRequestTests(unittest.TestCase):
    def test_the_page_save_request_is_refused_for_an_incomplete_reply_and_a_normal_one_is_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            incomplete_id, normal_id = "e" * 24, "f" * 24
            board_id, run_id = "board", "manual_board"
            bridge = bridge_support.make_bridge(BRIDGE, root)
            bridge.boards = {board_id: "Board"}
            bridge.diandian_enabled = True
            bridge.diandian_save_record = BRIDGE.load_diandian_save_record(SAVER)
            configure_summary_service(bridge, root, [incomplete_id, normal_id])
            bridge.summary_plans = {run_id: {incomplete_id, normal_id}}
            BRIDGE.atomic_json(bridge.manual_sync_path, {"batch": "manual", "state": "running", "summarized": 0})

            def request(note_id: str, summary: str) -> dict:
                return bridge.save_diandian_result({
                    "run_id": run_id, "board_id": board_id, "note_id": note_id, "title": "Title", "summary": summary,
                })

            # The page reads the refusal's message as its failure code, so the message is the stop reason.
            with self.assertRaises(ValueError) as refused:
                request(incomplete_id, incomplete_text())
            self.assertEqual(str(refused.exception), "diandian-incomplete")
            self.assertFalse((bridge.diandian_dir / f"{incomplete_id}.json").exists())
            self.assertEqual(bridge.summary_plans[run_id], {incomplete_id, normal_id})
            self.assertEqual(bridge.manual_sync_status()["counts"]["summary_captured"], 0)

            # The same request with a normal reply is saved, so the damage is what made the difference.
            self.assertTrue(request(normal_id, normal_text())["saved"])
            self.assertIsNotNone(bridge.saved_diandian_record(normal_id))
            self.assertEqual(bridge.summary_plans[run_id], {incomplete_id})


class SavedRecordTests(unittest.TestCase):
    """Out of scope on purpose: replies already saved keep reading as valid evidence.

    Twenty-two accepted, public notes were reviewed against a damaged reply. A reader that started to judge a
    saved record by this rule would take them off the site until they were reviewed again, which is a decision
    for the owner, not for this fix.
    """

    def test_a_saved_record_that_carries_the_damage_is_still_a_valid_record_in_either_format(self):
        note_id = "a" * 24
        for build in (v2_record, v1_record):
            with self.subTest(format=build.__name__):
                self.assertTrue(BRIDGE.valid_diandian_record(build(note_id, incomplete_text()), note_id))

    def test_a_current_saved_record_that_carries_the_damage_is_still_read_back(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            note_id = "a" * 24
            bridge = bridge_support.make_bridge(BRIDGE, root)
            bridge.diandian_enabled = True
            configure_summary_service(bridge, root, [note_id])
            bridge.diandian_dir.mkdir(parents=True)
            write_current_record(bridge, note_id, incomplete_text())
            self.assertIsNotNone(bridge.saved_diandian_record(note_id))


if __name__ == "__main__":
    unittest.main()
