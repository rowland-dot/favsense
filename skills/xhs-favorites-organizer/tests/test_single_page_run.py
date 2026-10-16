"""A sync round uses one Xiaohongshu page from its first step to its last.

The scan browser is replaced by `ScanBrowser`, a fake that records every page opened, navigated and
closed, whoever asks. The sync service is the real one. What the user script does on each page it
lands on is stood in for by small functions that make the same calls to the sync service the real
script makes (the script itself is covered by single-page-userscript.test.mjs).
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

import bridge_support


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "bridge-server.py"
SPEC = importlib.util.spec_from_file_location("xhs_bridge_single_page", MODULE_PATH)
BRIDGE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(BRIDGE)

SAVER = Path(__file__).parents[2] / "xhs-diandian-summarize-note" / "scripts" / "save_diandian_summary.py"
AI_URL = "https://www.xiaohongshu.com/ai_chat"
TERMINAL = {"completed", "failed", "safety-stopped"}
NOTES = {
    "first": ["a" * 24, "b" * 24, "c" * 24],
    "second": ["d" * 24, "e" * 24],
}
PRIVATE_MARKERS = (b"private-board-", b"private-copied-")


def board_url(board_id: str, batch: str, mode: str = "incremental") -> str:
    return (
        f"https://www.xiaohongshu.com/board/{board_id}?source=web_user_page"
        f"&xhs_kb_sync=1&xhs_kb_batch={batch}&xhs_kb_mode={mode}"
    )


def board_note_url(note_id: str) -> str:
    return f"https://www.xiaohongshu.com/discovery/item/{note_id}?xsec_token=private-board-{note_id}&xsec_source=pc_share"


def copied_note_url(note_id: str) -> str:
    return f"https://www.xiaohongshu.com/discovery/item/{note_id}?xsec_token=private-copied-{note_id}&xsec_source=pc_share"


def classify(url: str) -> str:
    parsed = urlparse(url)
    if parsed.path.startswith("/user/profile/"):
        return "profile"
    if parsed.path.startswith("/board/"):
        return f"board:{parsed.path.rsplit('/', 1)[1]}"
    if parsed.path.startswith("/discovery/item/"):
        return f"note:{parsed.path.rsplit('/', 1)[1][0]}"
    if parsed.path == "/ai_chat":
        return "ai"
    return parsed.path


class ScanBrowser:
    """The shared scan browser: its pages, and a record of everything done to them."""

    def __init__(self) -> None:
        self.pages: dict[str, str] = {}
        self.sync_service_pages: set[str] = set()
        self.log: list[tuple[str, str, str]] = []
        self.max_sync_service_pages = 0
        self.ai_state: dict[str, dict] = {}
        self.lock = threading.RLock()
        self.threads: list[threading.Thread] = []
        self.errors: list[BaseException] = []
        self.script = None
        self.counter = 0

    # --- what the sync service can ask of the browser -------------------------------------------
    def list_pages(self) -> list[dict]:
        with self.lock:
            return [{"id": page_id, "url": url, "type": "page"} for page_id, url in self.pages.items()]

    def open_page(self, url: str, *, activate: bool = True) -> dict:
        with self.lock:
            self.counter += 1
            page_id = f"page-{self.counter}"
            self.pages[page_id] = url
            self.sync_service_pages.add(page_id)
            self.max_sync_service_pages = max(self.max_sync_service_pages, len(self.sync_service_pages))
            self.log.append(("open", page_id, url))
        self.loaded(page_id, url)
        return {"id": page_id}

    def close_page(self, page_id: str) -> None:
        with self.lock:
            if page_id not in self.pages:
                raise RuntimeError("SOP DevTools endpoint is unavailable")
            url = self.pages.pop(page_id)
            self.sync_service_pages.discard(page_id)
            self.log.append(("close", page_id, url))

    def navigate(self, page_id: str, url: str) -> None:
        with self.lock:
            if page_id not in self.pages:
                raise BRIDGE.CDPTransportError("CDP connection failed")
            self.pages[page_id] = url
            self.log.append(("navigate", page_id, url))
            state = self.ai_state.setdefault(page_id, {"value": "", "finished": ""})
            state.update(value="", finished="")
        self.loaded(page_id, url)

    def attach(self, page_id) -> "FakeTarget":
        with self.lock:
            if page_id not in self.pages:
                raise BRIDGE.CDPTransportError("run page is gone")
        return FakeTarget(self, page_id)

    # --- the user script reacting to a page that has loaded -------------------------------------
    def loaded(self, page_id: str, url: str) -> None:
        if self.script is None:
            return

        def react() -> None:
            time.sleep(0.02)
            try:
                self.script(page_id, url)
            except BaseException as error:  # noqa: BLE001 - surfaced by the test
                self.errors.append(error)

        thread = threading.Thread(target=react, daemon=True)
        self.threads.append(thread)
        thread.start()

    def navigate_by_script(self, page_id: str, url: str) -> None:
        """The user script moving its own page (location.assign): a navigation, not an open."""
        self.navigate(page_id, url)

    # --- reading the record ---------------------------------------------------------------------
    def kinds(self) -> list[str]:
        return [f"{kind}:{classify(url)}" for kind, _page, url in self.log]


class FakeSession:
    def __init__(self, browser: ScanBrowser, page_id: str) -> None:
        self.browser = browser
        self.page_id = page_id
        self.state = browser.ai_state.setdefault(page_id, {"value": "", "finished": ""})
        self.calls: list[tuple[str, dict]] = []

    finished = property(lambda self: self.state["finished"], lambda self, value: self.state.update(finished=value))
    value = property(lambda self: self.state["value"], lambda self, value: self.state.update(value=value))

    def call(self, method, **params):
        self.calls.append((method, params))
        if method == "Page.navigate":
            self.browser.navigate(self.page_id, params["url"])
        elif method == "Input.insertText":
            self.state["value"] += params["text"]
        return {}

    def evaluate(self, expression):
        url = self.browser.pages[self.page_id]
        on_ai = url.startswith(AI_URL)
        return json.dumps({
            "href": url,
            "body": "DianDian chat is ready" if on_ai else "note page",
            "ready": "complete",
            "input_ready": on_ai,
            "msgs": 1 if self.state["finished"] else 0,
            "fin": 1 if self.state["finished"] else 0,
            "cards": 0,
            "val": self.state["value"],
            "last": self.state["finished"],
        })


class FakeTarget:
    def __init__(self, browser: ScanBrowser, page_id: str) -> None:
        self.session = FakeSession(browser, page_id)
        self.released = False

    def release(self) -> None:
        self.released = True

    def close(self) -> None:
        raise AssertionError("a summary step must release the run page, never close it")


SPEC_CONTRACT = {
    "ai_chat_url": AI_URL,
    "selectors": {
        "input_controls": ["textarea"],
        "selected_note_card": ".card",
        "assistant_message": ".message",
        "finished_message_class": "finished",
    },
    "prompt": "总结",
    "minimum_summary_chars": 20,
    "timings_ms": {
        "response_wait": 300_000,
        "reply_text_stable": 2_000,
        "success_dwell": 1_500,
        "share_result_wait": 3_000,
        "single_note_wait": 20_000,
        "between_notes": 1_000,
    },
}


class Round:
    """A real sync service wired to the fake browser, two boards of notes, and a way to run a round."""

    def __init__(self, test: unittest.TestCase, *, cdp: bool = True, behaviour: dict | None = None) -> None:
        directory = tempfile.TemporaryDirectory()
        test.addCleanup(directory.cleanup)
        self.test = test
        self.root = Path(directory.name)
        self.behaviour = behaviour or {}
        self.browser = ScanBrowser()
        bridge = bridge_support.make_bridge(BRIDGE, self.root, config={
            "boards": [
                {"id": board, "name": board.upper(), "enabled": True, "advertised_count": len(notes)}
                for board, notes in NOTES.items()
            ],
        })
        self.bridge = bridge
        self.cdp = cdp
        bridge.diandian_enabled = True
        bridge.diandian_cdp_enabled = cdp
        bridge.diandian_cdp_spec = SPEC_CONTRACT
        bridge.diandian_release = {"version": "1.2.0"}
        bridge.diandian_browser_contract = {"enabled": True, "version": 1}
        bridge.diandian_save_record = BRIDGE.load_diandian_save_record(SAVER)
        bridge.diandian_sleep = lambda seconds: None
        bridge.run_curation_pipeline = mock.Mock(return_value={"counts": {"accepted": 1, "pending": 0}})
        bridge.build_organization_snapshot = mock.Mock(
            return_value={"build_version": "a" * 64, "site_manifest_sha256": "b" * 64}
        )
        bridge.process_import = self.process_import
        bridge.open_sop_browser_page = self.browser.open_page
        bridge.list_sop_browser_pages = self.browser.list_pages
        bridge.close_sop_browser_page = self.browser.close_page
        bridge.attach_run_page = lambda run_id: self.browser.attach(bridge.read_manual_sync().get("run_page_id"))
        bridge.diandian_cdp_ask = mock.Mock(side_effect=self.ask) if cdp else None
        catalog = {"version": 1, "notes": {}}
        for board, notes in NOTES.items():
            for note_id in notes:
                catalog["notes"][note_id] = {
                    "note_id": note_id, "content_sha256": "a" * 64, "source_board_ids": [board],
                }
        BRIDGE.atomic_json(bridge.catalog_path, catalog)
        self.browser.script = self.page_script

    # --- what the real import does, minus the helper scripts ------------------------------------
    def process_import(self, run_id: str, board_id: str, unique: dict) -> None:
        bridge = self.bridge
        BRIDGE.atomic_json(bridge.state_dir / "runs" / f"{run_id}.json", {
            "run_id": run_id,
            "state": "completed",
            "scanned": len(unique),
            "new": len(unique),
            "next_board_id": bridge.next_board_id(board_id, run_id),
            "note_ids": sorted(unique),
            "completed_at": BRIDGE.datetime.now().astimezone().isoformat(),
        })

    # --- the external Skill's browser step ------------------------------------------------------
    def ask(self, session, note_url, *, spec, tries, sleep):
        note_id = BRIDGE.note_id_from_url(note_url)
        outcome = self.behaviour.get(("ask", note_id))
        if outcome == "transport":
            raise BRIDGE.CDPTransportError("private URL must never escape")
        if outcome == "safety":
            raise BRIDGE.DiandianPageStop("safety-stop", safety=True)
        session.call("Input.insertText", text=note_url)
        session.call("Input.insertText", text=" 总结")
        session.call("Input.dispatchKeyEvent", type="keyDown", key="Enter")
        session.call("Input.dispatchKeyEvent", type="keyUp", key="Enter")
        reply = self.behaviour.get(("reply", note_id))
        session._session.finished = (
            reply if reply is not None
            else f"Stable DianDian summary of {note_id[0]} with enough safe content."
        )
        return session._session.finished

    # --- the user script on each kind of page ---------------------------------------------------
    def page_script(self, page_id: str, url: str) -> None:
        bridge = self.bridge
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        kind = classify(url)
        if kind == "profile" and "xhs_kb_sync" in query:
            self.wait_until_recorded(page_id)
            batch = query["xhs_kb_batch"][0]
            first = bridge.run_board_order(batch)[0]
            self.browser.navigate_by_script(page_id, board_url(first, batch, query["xhs_kb_mode"][0]))
        elif kind.startswith("board:") and "xhs_kb_sync" in query:
            self.board_page(page_id, parsed.path.rsplit("/", 1)[1], query)
        elif kind.startswith("note:") and "xhs_kb_share_worker" in query:
            self.note_page(parsed.path.rsplit("/", 1)[1], query["xhs_kb_share_worker"][0])
        elif kind == "ai" and "xhs_kb_worker" in query:
            self.ai_page(query["xhs_kb_worker"][0])

    def wait_until_recorded(self, page_id: str) -> None:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if self.bridge.read_manual_sync().get("run_page_id") == page_id:
                return
            time.sleep(0.01)
        raise AssertionError("the run page was never recorded")

    def board_page(self, page_id: str, board_id: str, query: dict) -> None:
        bridge = self.bridge
        batch = query["xhs_kb_batch"][0]
        run_id = bridge.manual_run_id(batch, board_id)
        notes = self.behaviour.get(("notes", board_id), NOTES[board_id])
        if self.single_note is not None:
            notes = [self.single_note]
        _status, result = bridge.import_sync({
            "run_id": run_id, "board_id": board_id, "urls": [board_note_url(note_id) for note_id in notes],
        })
        plan = bridge.diandian_summary_plan({
            "run_id": run_id, "board_id": board_id, "note_ids": notes,
            "titles": {note_id: f"Title {note_id[0]}" for note_id in notes},
        })
        if plan.get("driven"):
            return
        if result.get("next_board_id"):
            self.browser.navigate_by_script(page_id, board_url(result["next_board_id"], batch, query["xhs_kb_mode"][0]))

    single_note = None

    def note_page(self, note_id: str, worker_id: str) -> None:
        bridge = self.bridge
        task = bridge.page_task(worker_id)
        self.test.assertEqual((task["stage"], task["note_id"]), ("share", note_id))
        self.test.assertNotIn("url", task, "the share task never carries a signed link")
        outcome = self.behaviour.get(("share", note_id))
        if outcome == "safety":
            result = {"ok": False, "error": "xhs-safety-stop"}
        elif outcome == "silent":
            return
        elif isinstance(outcome, str) and outcome.startswith("error:"):
            result = {"ok": False, "error": outcome.removeprefix("error:")}
        else:
            result = {"ok": True, "url": copied_note_url(note_id)}
        bridge.record_page_result({"worker_id": worker_id, "stage": "share", **result})

    def ai_page(self, worker_id: str) -> None:
        bridge = self.bridge
        task = bridge.page_task(worker_id)
        self.test.assertEqual(task["stage"], "ai")
        self.test.assertEqual(urlparse(task["url"]).path, f"/discovery/item/{task['note_id']}")
        if self.behaviour.get(("ai", task["note_id"])) == "fail":
            bridge.record_page_result({"worker_id": worker_id, "stage": "ai", "ok": False, "error": "ai-response-timeout"})
            return
        reply = self.behaviour.get(("reply", task["note_id"]))
        try:
            bridge.save_diandian_result({
                "run_id": task["run_id"], "board_id": task["board_id"], "note_id": task["note_id"],
                "title": task["title"],
                "summary": reply if reply is not None
                else f"Stable DianDian summary of {task['note_id'][0]} with enough safe content.",
            })
        except ValueError as refusal:
            # The real script reports the save request's refusal message as its failure code.
            bridge.record_page_result({"worker_id": worker_id, "stage": "ai", "ok": False, "error": str(refusal)})
            return
        bridge.record_page_result({"worker_id": worker_id, "stage": "ai", "ok": True})

    # --- running it -----------------------------------------------------------------------------
    def start(self, payload: dict | None = None) -> dict:
        return self.bridge.trigger_manual_sync(payload or {})

    def finish(self, timeout: float = 60, *, terminal: bool = True) -> dict:
        """Wait until the round is over and nothing it started is still running.

        A summary that fails on the DianDian page without the external browser step is recorded and
        its plan dropped, as it always was, but the round record is not marked over; `terminal=False`
        waits for the work to stop and leaves the record alone.
        """
        bridge = self.bridge
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            state = bridge.read_manual_sync().get("state")
            workers = [
                thread for thread in (
                    *self.browser.threads,
                    *bridge.summary_drivers.values(),
                    *bridge.summary_finalization_threads.values(),
                ) if thread.is_alive()
            ]
            if not workers and (state in TERMINAL or (not terminal and bridge.summary_drivers)):
                break
            time.sleep(0.02)
        else:
            self.test.fail(
                f"the round did not finish: {bridge.read_manual_sync().get('state')}; {self.browser.kinds()}; "
                f"script errors: {self.browser.errors!r}; drivers alive: "
                f"{[run for run, thread in bridge.summary_drivers.items() if thread.is_alive()]}"
            )
        self.test.assertEqual(self.browser.errors, [])
        return bridge.read_manual_sync()

    def saved(self, note_id: str) -> bool:
        return self.bridge.saved_diandian_record(note_id) is not None

    def unresolved(self) -> dict:
        report = json.loads(self.bridge.diandian_report_path.read_text(encoding="utf-8"))
        return {entry["note_id"]: entry.get("summary_status") for entry in report["unresolved"]}

    def assert_nothing_secret_is_kept(self) -> None:
        self.test.assertEqual(self.bridge.run_note_links, {})
        self.test.assertEqual(self.bridge.page_tasks, {})
        # The access codes of the imported links are kept in one private file (issue 106) and nowhere else.
        for marker in PRIVATE_MARKERS:
            holders = {
                path.name for path in self.root.rglob("*")
                if path.is_file() and marker in path.read_bytes()
            }
            self.test.assertLessEqual(holders, {"source-codes.json"}, marker)


def note_kinds(notes: list[str]) -> list[str]:
    return [item for note_id in notes for item in (f"navigate:note:{note_id[0]}", "navigate:ai")]


class OneRoundOnePageTest(unittest.TestCase):
    def test_a_full_round_uses_one_page_and_closes_it(self):
        for cdp in (True, False):
            with self.subTest(cdp=cdp):
                run = Round(self, cdp=cdp)
                run.start()
                state = run.finish()

                self.assertEqual(state["state"], "completed")
                self.assertEqual(run.browser.max_sync_service_pages, 1, run.browser.kinds())
                self.assertEqual(run.browser.pages, {}, "a finished round leaves no page behind")
                expected = (
                    ["open:profile", "navigate:board:first"]
                    + note_kinds(NOTES["first"])
                    + ["navigate:board:second"]
                    + note_kinds(NOTES["second"])
                    + ["close:ai"]
                )
                self.assertEqual(run.browser.kinds(), expected)
                for note_id in [item for notes in NOTES.values() for item in notes]:
                    self.assertTrue(run.saved(note_id), note_id)
                    self.assertEqual(run.bridge.saved_diandian_record(note_id)["title"], f"Title {note_id[0]}")
                self.assertEqual(run.bridge.run_curation_pipeline.call_count, 1)
                self.assertNotIn("run_page_id", run.bridge.read_manual_sync())
                run.assert_nothing_secret_is_kept()

    def test_the_run_page_id_is_kept_privately_and_never_shown_in_the_status(self):
        run = Round(self, behaviour={("ask", NOTES["first"][1]): "transport"})
        run.start()
        state = run.finish()

        self.assertEqual(state["run_page_id"], "page-1")
        self.assertNotIn("page-1", json.dumps(run.bridge.manual_sync_status()))

    def test_a_single_note_validation_uses_one_page_and_leaves_none(self):
        run = Round(self)
        target = NOTES["second"][1]
        run.single_note = target
        run.start({"note_id": target})
        state = run.finish()

        self.assertEqual(state["state"], "completed")
        self.assertEqual(run.browser.max_sync_service_pages, 1)
        self.assertEqual(run.browser.pages, {})
        self.assertEqual(
            run.browser.kinds(),
            ["open:profile", "navigate:board:second", "navigate:note:e", "navigate:ai", "close:ai"],
        )
        self.assertTrue(run.saved(target))
        run.assert_nothing_secret_is_kept()


class AFailureLeavesTheFailingPageTest(unittest.TestCase):
    def assert_stopped_on_the_failing_page(self, run: Round, state: dict, last_kind: str) -> None:
        self.assertEqual(len(run.browser.pages), 1)
        (page_id, url), = run.browser.pages.items()
        self.assertEqual(classify(url).split(":")[0], last_kind)
        self.assertEqual(state["run_page_id"], page_id, "the next round must be able to find and close it")
        self.assertEqual(run.browser.max_sync_service_pages, 1)
        self.assertEqual([kind for kind, *_ in run.browser.log].count("close"), 0)
        run.assert_nothing_secret_is_kept()

    def test_a_failed_summary_keeps_only_that_page_and_aborts_the_rest(self):
        for cdp in (True, False):
            with self.subTest(cdp=cdp):
                first, second, third = NOTES["first"]
                behaviour = {("ask", second): "transport"} if cdp else {("ai", second): "fail"}
                run = Round(self, cdp=cdp, behaviour=behaviour)
                run.start()
                state = run.finish(terminal=cdp)

                self.assertEqual(state["state"], "failed" if cdp else "running")
                self.assert_stopped_on_the_failing_page(run, state, "ai")
                self.assertEqual(
                    run.browser.kinds(),
                    ["open:profile", "navigate:board:first"] + note_kinds([first, second]),
                    "nothing is opened or navigated after the failure",
                )
                self.assertTrue(run.saved(first))
                self.assertFalse(run.saved(second))
                self.assertEqual(run.unresolved(), {second: "failed", third: "batch_aborted"})

    def test_a_safety_stop_on_a_note_page_keeps_only_that_page_and_navigates_no_further(self):
        first, second, third = NOTES["first"]
        run = Round(self, behaviour={("share", second): "safety"})
        run.start()
        state = run.finish()

        self.assertEqual(state["state"], "safety-stopped")
        self.assert_stopped_on_the_failing_page(run, state, "note")
        self.assertEqual(
            run.browser.kinds(),
            ["open:profile", "navigate:board:first", "navigate:note:a", "navigate:ai", "navigate:note:b"],
        )
        self.assertEqual(run.unresolved(), {second: "failed", third: "batch_aborted"})

    def test_a_safety_stop_on_the_summary_page_keeps_only_that_page(self):
        for cdp in (True, False):
            with self.subTest(cdp=cdp):
                first, second, _third = NOTES["first"]
                if cdp:
                    run = Round(self, behaviour={("ask", first): "safety"})
                else:
                    run = Round(self, cdp=False)
                    original = run.ai_page

                    def stopping_ai_page(worker_id, run=run):
                        run.bridge.record_page_result(
                            {"worker_id": worker_id, "stage": "ai", "ok": False, "error": "xhs-safety-stop"}
                        )

                    run.ai_page = stopping_ai_page
                run.start()
                state = run.finish()

                self.assertEqual(state["state"], "safety-stopped")
                self.assert_stopped_on_the_failing_page(run, state, "ai")
                self.assertEqual(run.browser.kinds()[-2:], ["navigate:note:a", "navigate:ai"])
                self.assertEqual(run.browser.max_sync_service_pages, 1)

    def test_a_note_page_that_never_answers_stops_the_round_with_its_own_reason(self):
        first = NOTES["first"][0]
        run = Round(self, behaviour={("share", first): "silent"})
        run.bridge.diandian_cdp_spec = {
            **SPEC_CONTRACT, "timings_ms": {**SPEC_CONTRACT["timings_ms"], "share_result_wait": 150},
        }
        run.start()
        state = run.finish()

        self.assertEqual(state["state"], "failed")
        self.assertEqual(state["summary_halt_reason"], "share-worker-not-ready")
        self.assert_stopped_on_the_failing_page(run, state, "note")


SHARE_CASES = json.loads(
    (Path(__file__).parents[1] / "test-fixtures" / "share-link-failure-cases.json").read_text(encoding="utf-8")
)
ALL_NOTES = [note_id for notes in NOTES.values() for note_id in notes]


class AShareLinkFailureCostsOnlyThatNoteTest(unittest.TestCase):
    """One note whose share link cannot be copied is recorded and passed over; the round goes on."""

    def stored_code_notes(self, run: Round) -> set[str]:
        store = json.loads((run.bridge.state_dir / "source-codes.json").read_text(encoding="utf-8"))
        return set(store["notes"])

    def test_a_clean_round_records_no_missing_share_links(self):
        run = Round(self)
        run.start()
        state = run.finish()

        self.assertEqual(state["share_link_missing"], 0)
        self.assertEqual(state["share_link_missing_reasons"], {})

    def test_a_share_timeout_on_one_note_still_scans_every_board_and_stores_every_code(self):
        for cdp in (True, False):
            with self.subTest(cdp=cdp):
                first, second, third = NOTES["first"]
                run = Round(self, cdp=cdp, behaviour={("share", second): "error:share-control-timeout"})
                run.start()
                state = run.finish()

                self.assertEqual(state["state"], "completed")
                self.assertNotIn("summary_halt_reason", state)
                self.assertEqual(
                    run.browser.kinds(),
                    ["open:profile", "navigate:board:first"]
                    + note_kinds([first])
                    + ["navigate:note:b"]
                    + note_kinds([third])
                    + ["navigate:board:second"]
                    + note_kinds(NOTES["second"])
                    + ["close:ai"],
                    "the failed note is visited once, never again within the round",
                )
                self.assertEqual(self.stored_code_notes(run), set(ALL_NOTES))
                for note_id in ALL_NOTES:
                    self.assertEqual(run.saved(note_id), note_id != second, note_id)
                self.assertEqual(run.unresolved(), {second: "failed"})
                self.assertEqual(run.browser.pages, {})
                self.assertEqual(run.browser.max_sync_service_pages, 1)
                self.assertEqual(run.bridge.run_curation_pipeline.call_count, 1)
                run.assert_nothing_secret_is_kept()

    def test_the_run_record_says_how_many_notes_had_no_share_link_and_why(self):
        first, second, third = NOTES["first"]
        run = Round(self, behaviour={
            ("share", first): "error:share-control-timeout",
            ("share", third): "error:share-menu-timeout",
            ("share", NOTES["second"][0]): "error:share-control-timeout",
        })
        run.start()
        state = run.finish()

        self.assertEqual(state["state"], "completed")
        self.assertEqual(state["share_link_missing"], 3)
        self.assertEqual(
            state["share_link_missing_reasons"],
            {"share-control-timeout": 2, "share-menu-timeout": 1},
        )
        self.assertEqual(state["summary_failed"], 3)
        self.assertEqual(run.unresolved(), {first: "failed", third: "failed", NOTES["second"][0]: "failed"})
        self.assertNotIn("share_link_missing", json.dumps(run.bridge.manual_sync_status()), "the public status is unchanged")

    def test_every_note_of_a_board_failing_to_share_still_reaches_the_next_board(self):
        behaviour = {("share", note_id): "error:share-control-timeout" for note_id in NOTES["first"]}
        run = Round(self, behaviour=behaviour)
        run.start()
        state = run.finish()

        self.assertEqual(state["state"], "completed")
        self.assertEqual(state["share_link_missing"], 3)
        self.assertEqual(
            run.browser.kinds(),
            ["open:profile", "navigate:board:first"]
            + [f"navigate:note:{note_id[0]}" for note_id in NOTES["first"]]
            + ["navigate:board:second"]
            + note_kinds(NOTES["second"])
            + ["close:ai"],
        )
        self.assertEqual(self.stored_code_notes(run), set(ALL_NOTES))

    def test_each_page_reported_failure_is_skipped_or_stops_the_round_as_the_table_says(self):
        second = NOTES["first"][1]
        for code in SHARE_CASES["skip"]:
            with self.subTest(skip=code):
                run = Round(self, behaviour={("share", second): f"error:{code}"})
                run.start()
                state = run.finish()
                self.assertEqual(state["state"], "completed")
                self.assertEqual(state["share_link_missing_reasons"], {code: 1})
                self.assertIn("navigate:board:second", run.browser.kinds())
        for code in SHARE_CASES["halt"]:
            with self.subTest(halt=code):
                run = Round(self, behaviour={("share", second): f"error:{code}"})
                run.start()
                state = run.finish()
                self.assertEqual(state["state"], "failed")
                self.assertEqual(state["summary_halt_reason"], code)
                self.assertEqual(state["share_link_missing"], 0)
                self.assertNotIn("navigate:board:second", run.browser.kinds())

    def test_a_note_with_no_held_share_link_is_skipped_like_any_other(self):
        second = NOTES["first"][1]
        run = Round(self)
        keep = run.bridge.keep_run_note_links
        run.bridge.keep_run_note_links = lambda run_id, links: keep(
            run_id, {note_id: link for note_id, link in links.items() if note_id != second}
        )
        run.start()
        state = run.finish()

        self.assertEqual(state["state"], "completed")
        self.assertEqual(state["share_link_missing_reasons"], {"share-link-unavailable": 1})
        self.assertFalse(run.saved(second))
        self.assertIn("navigate:board:second", run.browser.kinds())

    def test_a_safety_stop_after_a_skipped_note_still_stops_the_round_at_once(self):
        first, second, third = NOTES["first"]
        run = Round(self, behaviour={
            ("share", first): "error:share-control-timeout",
            ("share", second): "safety",
        })
        run.start()
        state = run.finish()

        self.assertEqual(state["state"], "safety-stopped")
        self.assertEqual(state["share_link_missing"], 1)
        self.assertEqual(
            run.browser.kinds(),
            ["open:profile", "navigate:board:first", "navigate:note:a", "navigate:note:b"],
        )
        self.assertEqual(run.unresolved(), {first: "failed", second: "failed", third: "batch_aborted"})

    def test_the_skipped_note_is_planned_again_by_the_next_sync_and_not_before(self):
        first, second, third = NOTES["first"]
        run = Round(self, behaviour={("share", second): "error:share-control-timeout"})
        run.start()
        run.finish()
        self.assertEqual(run.browser.kinds().count("navigate:note:b"), 1)

        run.behaviour.clear()
        before = len(run.browser.log)
        run.start()
        state = run.finish()
        later = [f"{kind}:{classify(url)}" for kind, _page, url in run.browser.log[before:]]

        self.assertEqual(state["state"], "completed")
        self.assertIn("navigate:note:b", later)
        self.assertNotIn("navigate:note:a", later)
        self.assertNotIn("navigate:note:c", later)
        self.assertTrue(run.saved(second))
        self.assertEqual(run.unresolved(), {})


class LeftoverPagesTest(unittest.TestCase):
    def test_a_new_round_closes_only_its_own_leftovers_before_opening_its_page(self):
        run = Round(self)
        browser = run.browser
        browser.pages.update({
            "old-board": "https://www.xiaohongshu.com/board/first?source=web_user_page&xhs_kb_sync=1&xhs_kb_batch=manualold",
            "old-worker": "https://www.xiaohongshu.com/discovery/item/" + "z" * 24 + "?xhs_kb_share_worker=11111111-1111-4111-8111-111111111111",
            "failed-ai": AI_URL,
            "home": "https://www.xiaohongshu.com/explore",
        })
        BRIDGE.atomic_json(run.bridge.manual_sync_path, {
            "batch": "manualold", "state": "failed", "run_page_id": "failed-ai",
        })

        run.start()
        state = run.finish()

        self.assertEqual(state["state"], "completed")
        kinds = [(kind, page) for kind, page, _url in browser.log]
        opened = kinds.index(("open", "page-1"))
        for leftover in ("old-board", "old-worker", "failed-ai"):
            self.assertIn(("close", leftover), kinds[:opened], leftover)
        self.assertIn("home", browser.pages, "a page FavSense did not open is never closed")
        self.assertEqual(browser.pages["home"], "https://www.xiaohongshu.com/explore", "and never navigated")
        self.assertEqual([page for kind, page, _url in browser.log if page == "home"], [])
        self.assertEqual(browser.max_sync_service_pages, 1)
        self.assertEqual(set(browser.pages), {"home"})

    def test_a_browser_that_cannot_list_pages_does_not_stop_a_round_from_starting(self):
        run = Round(self)
        run.bridge.list_sop_browser_pages = mock.Mock(side_effect=RuntimeError("SOP DevTools endpoint is unavailable"))

        run.start()
        state = run.finish()

        self.assertEqual(state["state"], "completed")
        log = (run.bridge.state_dir / BRIDGE.BRIDGE_LOG_NAME).read_text(encoding="utf-8")
        self.assertIn("run-page-cleanup", log)


class PageTaskTest(unittest.TestCase):
    def registered(self):
        run = Round(self)
        run.start()
        run.finish()
        return run

    def test_an_unknown_or_malformed_worker_has_no_task(self):
        run = Round(self)
        for worker in ("", "not-a-uuid", "11111111-1111-4111-8111-111111111111"):
            with self.subTest(worker=worker), self.assertRaises(ValueError):
                run.bridge.page_task(worker)
        with self.assertRaises(ValueError):
            run.bridge.record_page_result({"worker_id": "11111111-1111-4111-8111-111111111111", "stage": "share", "ok": True})

    def test_a_result_must_match_the_registered_stage_and_note(self):
        run = Round(self)
        bridge = run.bridge
        worker = "22222222-2222-4222-8222-222222222222"
        task = bridge.register_page_task(
            worker, "share", run_id="manual_first", board_id="first", note_id=NOTES["first"][0], title="t", batch="manual",
        )
        for bad in (
            {"worker_id": worker, "stage": "ai", "ok": True},
            {"worker_id": worker, "stage": "share", "ok": True},
            {"worker_id": worker, "stage": "share", "ok": True, "url": copied_note_url(NOTES["first"][1])},
            {"worker_id": worker, "stage": "share", "ok": True, "url": "https://example.invalid/x?xsec_token=1"},
            {"worker_id": worker, "stage": "share", "ok": "yes"},
            {"worker_id": worker, "stage": "share", "ok": True, "url": copied_note_url(NOTES["first"][0]), "extra": 1},
        ):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                bridge.record_page_result(bad)
        self.assertFalse(task.event.is_set())
        bridge.record_page_result(
            {"worker_id": worker, "stage": "share", "ok": True, "url": copied_note_url(NOTES["first"][0])}
        )
        self.assertTrue(task.event.is_set())
        with self.assertRaises(ValueError):
            bridge.record_page_result({"worker_id": worker, "stage": "share", "ok": False, "error": "share-link-failed"})

    def test_the_routes_are_authenticated_and_the_old_per_note_route_is_gone(self):
        run = Round(self)
        bridge = run.bridge
        worker = "33333333-3333-4333-8333-333333333333"
        bridge.register_page_task(
            worker, "share", run_id="manual_first", board_id="first", note_id=NOTES["first"][0], title="t", batch="manual",
        )
        server = BRIDGE.ThreadingHTTPServer((BRIDGE.HOST, 0), BRIDGE.make_handler(bridge))
        bridge.port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def call(method, path, body=None, token=bridge.token):
            request = Request(
                f"http://{BRIDGE.HOST}:{bridge.port}{path}",
                data=None if body is None else json.dumps(body).encode("utf-8"),
                headers=bridge_support.userscript_headers(token),
                method=method,
            )
            try:
                with urlopen(request, timeout=3) as response:
                    return response.status, json.loads(response.read().decode("utf-8"))
            except HTTPError as error:
                return error.code, json.loads(error.read().decode("utf-8"))

        status, body = call("GET", f"/sync/page-task?worker_id={worker}")
        self.assertEqual(status, 200)
        self.assertEqual(body["task"]["stage"], "share")
        self.assertEqual(body["task"]["note_id"], NOTES["first"][0])
        self.assertEqual(call("GET", f"/sync/page-task?worker_id={worker}", token="b" * 64)[0], 401)
        self.assertEqual(call("GET", "/sync/page-task?worker_id=bad")[0], 400)
        status, _ = call("POST", "/sync/page-result", {
            "worker_id": worker, "stage": "share", "ok": True, "url": copied_note_url(NOTES["first"][0]),
        })
        self.assertEqual(status, 200)
        self.assertEqual(call("POST", "/sync/diandian-cdp", {"run_id": "x"})[0], 404)


if __name__ == "__main__":
    unittest.main()
