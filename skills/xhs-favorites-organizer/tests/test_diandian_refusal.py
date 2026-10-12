"""A DianDian reply that refuses to read the note is not a summary.

Sometimes DianDian does not open the note and answers that it cannot reach the link and asks for the
text or a screenshot. That reply used to be saved as the note's summary and shown on the public page.
These tests hold the Python copy of the rule that recognises such a reply to the shared case table, and
check the three places that must act on it: the collection step, the check of a saved record, and the
next round's plan. The JavaScript copy is held to the same table in diandian-refusal.test.mjs.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

import bridge_support


SKILL = Path(__file__).parents[1]
SAVER = SKILL.parent / "xhs-diandian-summarize-note" / "scripts" / "save_diandian_summary.py"


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


BRIDGE = load("xhs_bridge_diandian_refusal", SKILL / "scripts" / "bridge-server.py")
REFUSAL = load("favsense_diandian_refusal_under_test", SKILL / "scripts" / "diandian_refusal.py")
CASES = json.loads(
    (SKILL / "test-fixtures" / "diandian-refusal-cases.json").read_text(encoding="utf-8")
)["cases"]
REFUSED = [case for case in CASES if case["refused"]]
NORMAL = [case for case in CASES if not case["refused"]]
INVISIBLE = "​"
AI_URL = "https://www.xiaohongshu.com/ai_chat"
PROMPT_VERSION = "7" * 64


def refusal_text() -> str:
    """The most common real refusal, long enough to pass the length check the collection step already has."""
    return next(case["text"] for case in REFUSED if case["id"] == "refusal-cannot-open-link-asks-for-copy")


def normal_text() -> str:
    return next(case["text"] for case in NORMAL if case["id"] == "summary-starts-with-according-to-your-note")


def v2_record(note_id: str, summary: str) -> dict:
    return {
        "version": 2,
        "provider": "xiaohongshu-diandian",
        "prompt": "总结",
        "prompt_version": PROMPT_VERSION,
        "note_id": note_id,
        "title": "Title",
        "summary": summary,
        "content_sha256": "a" * 64,
        "request_sha256": "8" * 64,
        "summary_sha256": hashlib.sha256(summary.strip().encode("utf-8")).hexdigest(),
        "captured_at": "2026-10-13T00:00:00+00:00",
    }


def v1_record(note_id: str, summary: str) -> dict:
    return {
        "version": 1,
        "provider": "xiaohongshu-diandian",
        "prompt": "总结",
        "note_id": note_id,
        "title": "Title",
        "summary": summary,
    }


class RefusalTableTests(unittest.TestCase):
    def test_the_table_is_well_formed_and_carries_the_known_forms(self):
        identifiers = [case["id"] for case in CASES]
        self.assertEqual(len(identifiers), len(set(identifiers)))
        for case in CASES:
            with self.subTest(case=case["id"]):
                self.assertEqual(set(case), {"id", "text", "refused", "why"})
                self.assertIsInstance(case["refused"], bool)
                self.assertTrue(case["text"].strip() and case["why"].strip())
        # Real replies carry zero-width spaces around bold words; the table must keep them.
        self.assertTrue(any(INVISIBLE in case["text"] for case in CASES))
        # The 26-character reply is longer than the 20-character floor and asks for nothing to be sent back.
        self.assertTrue(any(
            20 < len(case["text"]) <= 30 and not any(word in case["text"] for word in ("复制", "截图"))
            for case in REFUSED
        ))
        # One refusal has neither an apology nor "cannot".
        self.assertTrue(any(
            "抱歉" not in case["text"] and "无法" not in case["text"] for case in REFUSED
        ))
        for opening in ("根据你引用的笔记", "以下是核心总结"):
            self.assertTrue(
                any(case["text"].replace(INVISIBLE, "").startswith(opening) for case in NORMAL), opening
            )

    def test_the_python_rule_follows_the_table(self):
        for case in CASES:
            with self.subTest(case=case["id"]):
                self.assertIs(REFUSAL.is_refusal(case["text"]), case["refused"], case["why"])

    def test_text_that_is_not_a_string_is_not_a_refusal(self):
        for value in (None, 0, [], {}):
            self.assertIs(REFUSAL.is_refusal(value), False)


class SavedRecordTests(unittest.TestCase):
    def test_a_saved_refusal_is_not_a_valid_record_in_either_format(self):
        note_id = "a" * 24
        for build in (v2_record, v1_record):
            with self.subTest(format=build.__name__):
                # The same record with a real summary is valid, so the refusal is what makes the difference.
                self.assertTrue(BRIDGE.valid_diandian_record(build(note_id, normal_text()), note_id))
                self.assertFalse(BRIDGE.valid_diandian_record(build(note_id, refusal_text()), note_id))


def configure_summary_service(bridge, root: Path, note_ids) -> None:
    bridge.diandian_release = {"version": "1.2.0"}
    bridge.diandian_browser_contract = {"enabled": True, "version": 1}
    bridge.catalog_path = root / ".xhs-favorites" / "catalog.json"
    BRIDGE.atomic_json(bridge.catalog_path, {
        "notes": {note_id: {"content_sha256": "a" * 64} for note_id in note_ids},
    })


def write_current_record(bridge, note_id: str, summary: str) -> None:
    """A version 2 record that is current in every respect except what its summary says."""
    title = "Title"
    BRIDGE.atomic_json(bridge.diandian_dir / f"{note_id}.json", {
        **v2_record(note_id, summary),
        "prompt_version": BRIDGE.diandian_prompt_version(
            bridge.diandian_release, bridge.diandian_browser_contract
        ),
        "request_sha256": BRIDGE.diandian_result_digest(title, summary),
    })


class NextRoundPlanTests(unittest.TestCase):
    def test_a_note_with_a_saved_refusal_is_planned_again_and_a_real_summary_is_not(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            refused_id, summarised_id = "a" * 24, "b" * 24
            bridge = bridge_support.make_bridge(BRIDGE, root)
            bridge.diandian_enabled = True
            bridge.boards = {"board": "Board"}
            configure_summary_service(bridge, root, [refused_id, summarised_id])
            bridge.diandian_dir.mkdir(parents=True)
            write_current_record(bridge, refused_id, refusal_text())
            write_current_record(bridge, summarised_id, normal_text())
            self.assertIsNotNone(bridge.saved_diandian_record(summarised_id))
            batch = "manual20260813010101"
            run_id = bridge.manual_run_id(batch, "board")
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": batch,
                "state": "running",
                "board_note_ids": {"board": [refused_id, summarised_id]},
            })

            plan = bridge.diandian_summary_plan({
                "run_id": run_id, "board_id": "board", "note_ids": [refused_id, summarised_id],
            })

            self.assertEqual(plan["note_ids"], [refused_id])
            self.assertIsNone(bridge.saved_diandian_record(refused_id))


class CollectionStepTests(unittest.TestCase):
    def test_a_refused_reply_fails_the_note_aborts_the_rest_and_saves_nothing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            refused_id, waiting_id = "c" * 24, "d" * 24
            board_id, run_id = "board", "manual_board"
            bridge = bridge_support.make_bridge(BRIDGE, root)
            bridge.boards = {board_id: "Board"}
            bridge.board_order = [board_id]
            bridge.diandian_enabled = True
            bridge.diandian_cdp_enabled = True
            bridge.diandian_cdp_spec = {
                "ai_chat_url": AI_URL,
                "selectors": {
                    "input_controls": ["textarea"],
                    "selected_note_card": ".card",
                    "assistant_message": ".message",
                    "finished_message_class": "finished",
                },
                "prompt": "总结",
                "minimum_summary_chars": 20,
                "timings_ms": {"response_wait": 300_000, "reply_text_stable": 2_000, "success_dwell": 1_500},
            }
            bridge.diandian_save_record = BRIDGE.load_diandian_save_record(SAVER)
            configure_summary_service(bridge, root, [refused_id, waiting_id])
            bridge.summary_plans = {run_id: {refused_id, waiting_id}}
            bridge.diandian_sleep = mock.Mock()
            BRIDGE.atomic_json(bridge.manual_sync_path, {
                "batch": "manual", "state": "running", "run_board_ids": [board_id],
                "summary_pending": 2, "summary_failed": 0,
            })
            BRIDGE.atomic_json(bridge.state_dir / "runs" / f"{run_id}.json", {
                "run_id": run_id, "state": "completed", "next_board_id": None,
            })

            class FakeSession:
                def __init__(self):
                    self.finished = ""
                    self.value = ""

                def call(self, method, **params):
                    if method == "Input.insertText":
                        self.value += params["text"]
                    return {}

                def evaluate(self, expression):
                    return json.dumps({
                        "href": AI_URL, "body": "DianDian chat is ready", "ready": "complete",
                        "input_ready": True, "msgs": 1 if self.finished else 0,
                        "fin": 1 if self.finished else 0, "cards": 0, "val": self.value,
                        "last": self.finished,
                    })

            session = FakeSession()
            target = SimpleNamespace(session=session, close=mock.Mock(), release=mock.Mock())
            bridge.attach_run_page = mock.Mock(return_value=target)

            def ask(guarded, note_url, *, spec, tries, sleep):
                guarded.call("Input.insertText", text=note_url)
                guarded.call("Input.insertText", text=" 总结")
                guarded.call("Input.dispatchKeyEvent", type="keyDown", key="Enter")
                guarded.call("Input.dispatchKeyEvent", type="keyUp", key="Enter")
                session.finished = refusal_text()
                return session.finished

            bridge.diandian_cdp_ask = mock.Mock(side_effect=ask)

            result = bridge.run_diandian_cdp({
                "run_id": run_id,
                "board_id": board_id,
                "note_id": refused_id,
                "title": "Title",
                "url": f"https://www.xiaohongshu.com/discovery/item/{refused_id}?xsec_token=private-token",
            })

            self.assertEqual(result, {"saved": False, "halted": True, "reason": "diandian-refused"})
            self.assertFalse((bridge.diandian_dir / f"{refused_id}.json").exists())
            self.assertEqual(
                [path.name for path in bridge.diandian_dir.glob("*")] if bridge.diandian_dir.exists() else [],
                [],
            )
            # The failed page is kept as it is: released to the round, never closed.
            target.close.assert_not_called()
            target.release.assert_called_once()
            report = json.loads(bridge.diandian_report_path.read_text(encoding="utf-8"))
            statuses = {entry["note_id"]: entry["summary_status"] for entry in report["unresolved"]}
            self.assertEqual(statuses, {refused_id: "failed", waiting_id: "batch_aborted"})
            record = bridge.read_manual_sync()
            self.assertEqual(record["summary_halt_reason"], "diandian-refused")
            self.assertIn("没有读取这篇笔记", record["error"])
            self.assertIn("核心整理结果已保留", record["error"])
            self.assertIn("下一轮", record["error"])
            self.assertNotIn("private-token", json.dumps(record, ensure_ascii=False))
            self.assertEqual(bridge.manual_sync_status()["phases"]["summary"]["status"], "failed")


if __name__ == "__main__":
    unittest.main()
