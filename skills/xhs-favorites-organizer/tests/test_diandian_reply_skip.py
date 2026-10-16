"""A DianDian reply that cannot be a summary costs only its own post; the sync carries on (issue 130).

The sync service is the real one, driven through a whole round by the fake scan browser of
test_single_page_run.py. DianDian's reply for a chosen post is swapped for a refusal or a damaged reply
taken from the existing reply tables. Safety signals are the one thing that still ends the round.
"""

from __future__ import annotations

import json
from pathlib import Path
import unittest

from test_single_page_run import NOTES, Round, note_kinds

SKILL = Path(__file__).parents[1]
CASES = json.loads((SKILL / "test-fixtures" / "diandian-reply-skip-cases.json").read_text(encoding="utf-8"))["replies"]
ALL_NOTES = [note_id for notes in NOTES.values() for note_id in notes]


def reply_text(kind: str) -> str:
    entry = CASES[kind]
    table = json.loads((SKILL / "test-fixtures" / entry["table"]).read_text(encoding="utf-8"))["cases"]
    return next(
        case["text"] for case in table
        if case["id"] == entry.get("id") or case["id"].startswith(entry.get("id_prefix", "\0"))
    )


class AnUnusableReplyCostsOnlyThatPostTest(unittest.TestCase):
    def stored_code_notes(self, run: Round) -> set[str]:
        store = json.loads((run.bridge.state_dir / "source-codes.json").read_text(encoding="utf-8"))
        return set(store["notes"])

    def test_a_refused_post_is_skipped_and_every_folder_is_still_scanned(self):
        first, second, third = NOTES["first"]
        run = Round(self, behaviour={("reply", second): reply_text("refused")})
        run.start()
        state = run.finish()

        self.assertEqual(state["state"], "completed")
        self.assertNotIn("summary_halt_reason", state)
        self.assertEqual(
            run.browser.kinds(),
            ["open:profile", "navigate:board:first"]
            + note_kinds(NOTES["first"])
            + ["navigate:board:second"]
            + note_kinds(NOTES["second"])
            + ["close:ai"],
            "the refused post is visited once, never again within the round",
        )
        self.assertEqual(self.stored_code_notes(run), set(ALL_NOTES))
        for note_id in ALL_NOTES:
            self.assertEqual(run.saved(note_id), note_id != second, note_id)
        self.assertFalse((run.bridge.diandian_dir / f"{second}.json").exists(), "nothing goes into the private record")
        self.assertEqual(run.unresolved(), {second: "failed"})
        self.assertEqual(run.browser.pages, {})
        self.assertEqual(run.bridge.run_curation_pipeline.call_count, 1)
        run.assert_nothing_secret_is_kept()

    def test_an_incomplete_reply_is_skipped_the_same_way(self):
        first, second, third = NOTES["first"]
        run = Round(self, behaviour={("reply", third): reply_text("incomplete")})
        run.start()
        state = run.finish()

        self.assertEqual(state["state"], "completed")
        self.assertIn("navigate:board:second", run.browser.kinds())
        self.assertEqual(self.stored_code_notes(run), set(ALL_NOTES))
        for note_id in ALL_NOTES:
            self.assertEqual(run.saved(note_id), note_id != third, note_id)
        self.assertFalse((run.bridge.diandian_dir / f"{third}.json").exists())
        self.assertEqual(run.unresolved(), {third: "failed"})

    def test_a_safety_stop_after_a_skipped_post_still_stops_the_round_at_once(self):
        first, second, third = NOTES["first"]
        run = Round(self, behaviour={
            ("reply", first): reply_text("refused"),
            ("ask", second): "safety",
        })
        run.start()
        state = run.finish()

        self.assertEqual(state["state"], "safety-stopped")
        self.assertEqual(state["diandian_refused"], 1)
        self.assertNotIn("navigate:board:second", run.browser.kinds())
        self.assertEqual(run.unresolved(), {first: "failed", second: "failed", third: "batch_aborted"})

    def test_a_page_that_reports_an_incomplete_reply_costs_only_that_post(self):
        first, second, third = NOTES["first"]
        run = Round(self, cdp=False, behaviour={("reply", second): reply_text("incomplete")})
        run.start()
        state = run.finish()

        self.assertEqual(state["state"], "completed")
        self.assertEqual(state["diandian_incomplete"], 1)
        self.assertEqual(self.stored_code_notes(run), set(ALL_NOTES))
        for note_id in ALL_NOTES:
            self.assertEqual(run.saved(note_id), note_id != second, note_id)
        self.assertEqual(run.unresolved(), {second: "failed"})
        self.assertIn("navigate:board:second", run.browser.kinds())

    def test_the_run_record_says_how_many_posts_were_refused_or_answered_incompletely(self):
        first, second, third = NOTES["first"]
        run = Round(self, behaviour={
            ("reply", first): reply_text("refused"),
            ("reply", third): reply_text("incomplete"),
            ("reply", NOTES["second"][1]): reply_text("refused"),
        })
        run.start()
        state = run.finish()

        self.assertEqual(state["state"], "completed")
        self.assertEqual(state["diandian_refused"], 2)
        self.assertEqual(state["diandian_incomplete"], 1)
        self.assertEqual(state["summary_failed"], 3)
        counts = run.bridge.manual_sync_status()["counts"]
        self.assertEqual(
            (counts["summary_failed"], counts["summary_refused"], counts["summary_incomplete"]), (3, 2, 1),
            "the workbench is told how many were refused and how many came back incomplete",
        )

    def test_a_clean_round_records_none(self):
        run = Round(self)
        run.start()
        state = run.finish()

        self.assertEqual((state["diandian_refused"], state["diandian_incomplete"]), (0, 0))

    def test_the_skipped_post_is_planned_again_by_the_next_sync_and_not_before(self):
        first, second, third = NOTES["first"]
        run = Round(self, behaviour={("reply", second): reply_text("refused")})
        run.start()
        run.finish()
        self.assertEqual(run.browser.kinds().count("navigate:note:b"), 1)

        run.behaviour.clear()
        run.start()
        state = run.finish()

        self.assertEqual(state["state"], "completed")
        self.assertTrue(run.saved(second))
        self.assertEqual(run.unresolved(), {})


if __name__ == "__main__":
    unittest.main()
