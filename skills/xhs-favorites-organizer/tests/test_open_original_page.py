"""The workbench's "open original post" keeps at most one Xiaohongshu page open.

The scan browser is `ScanBrowser` from the single-page round tests: a fake that records every page
opened, navigated and closed, whoever asks. The sync service is the real one. A page counts as the
"open original" page when the sync service opened it (`sync_service_pages`); pages the test seeds
into the browser stand for pages somebody else owns.
"""

from __future__ import annotations

import json
from datetime import datetime
import unittest
from urllib.parse import parse_qs, urlparse

import bridge_support
from test_single_page_run import BRIDGE, NOTES, Round

FIRST, SECOND, THIRD = NOTES["first"]
OTHER_PEOPLES_PAGES = {
    "home": "https://www.xiaohongshu.com/explore",
    "ros-note": "https://www.xiaohongshu.com/discovery/item/" + "y" * 24,
    "elsewhere": "https://example.com/some/page",
}


def looked_up_note(url: str) -> str:
    return parse_qs(urlparse(url).query)["xhs_kb_open_note"][0]


def wire(bridge, browser) -> None:
    bridge.open_sop_browser_page = browser.open_page
    bridge.list_sop_browser_pages = browser.list_pages
    bridge.close_sop_browser_page = browser.close_page


class OpenOriginalPageTest(unittest.TestCase):
    def service(self) -> Round:
        run = Round(self)
        run.browser.script = None  # nothing reacts to a page loading; only the sync service acts
        return run

    def test_three_openings_in_a_row_leave_exactly_one_page_showing_the_third_note(self):
        run = self.service()
        for note_id in (FIRST, SECOND, THIRD):
            run.bridge.open_original_note(note_id)

        browser = run.browser
        self.assertEqual(browser.max_sync_service_pages, 1, browser.kinds())
        self.assertEqual(len(browser.sync_service_pages), 1, browser.kinds())
        (page_id,) = browser.sync_service_pages
        self.assertEqual(looked_up_note(browser.pages[page_id]), THIRD)
        self.assertEqual([kind for kind, _page, _url in browser.log].count("open"), 3)

    def test_a_page_the_owner_closed_himself_is_not_an_error_and_nothing_else_is_closed(self):
        run = self.service()
        run.bridge.open_original_note(FIRST)
        run.browser.pages.clear()
        run.browser.sync_service_pages.clear()

        run.bridge.open_original_note(SECOND)

        self.assertEqual(len(run.browser.pages), 1)
        self.assertEqual([kind for kind, _page, _url in run.browser.log if kind == "close"], [])

    def test_a_recorded_page_the_browser_no_longer_has_is_treated_as_closed(self):
        run = self.service()
        run.bridge.open_original_note(FIRST)
        (old_page,) = run.browser.sync_service_pages
        run.bridge.close_sop_browser_page = lambda _page_id: self.fail("a page that is gone must not be closed")
        run.browser.pages.pop(old_page)  # the browser restarted: the recorded id no longer exists

        run.bridge.open_original_note(SECOND)

        self.assertEqual(len(run.browser.pages), 1)
        self.assertEqual(looked_up_note(next(iter(run.browser.pages.values()))), SECOND)

    def test_pages_somebody_else_owns_are_never_closed_or_moved(self):
        run = self.service()
        run.browser.pages.update(OTHER_PEOPLES_PAGES)

        run.bridge.open_original_note(FIRST)
        run.bridge.open_original_note(SECOND)

        for page_id, url in OTHER_PEOPLES_PAGES.items():
            self.assertEqual(run.browser.pages.get(page_id), url, page_id)
        touched = {page for _kind, page, _url in run.browser.log}
        self.assertEqual(touched & set(OTHER_PEOPLES_PAGES), set())
        self.assertEqual(run.browser.max_sync_service_pages, 1)

    def test_a_restarted_sync_service_still_closes_the_page_the_previous_one_opened(self):
        run = self.service()
        run.bridge.open_original_note(FIRST)

        restarted = bridge_support.make_bridge(BRIDGE, run.root)
        wire(restarted, run.browser)
        restarted.open_original_note(SECOND)

        self.assertEqual(run.browser.max_sync_service_pages, 1, run.browser.kinds())
        self.assertEqual(len(run.browser.pages), 1)
        self.assertEqual(looked_up_note(next(iter(run.browser.pages.values()))), SECOND)

    def test_the_private_record_holds_only_the_page_id(self):
        run = self.service()
        state_dir = run.bridge.state_dir
        before = {path: path.read_bytes() for path in state_dir.rglob("*") if path.is_file()}

        run.bridge.open_original_note(FIRST)

        written = [
            path for path in state_dir.rglob("*")
            if path.is_file() and before.get(path) != path.read_bytes()
        ]
        self.assertEqual(len(written), 1, written)
        record = json.loads(written[0].read_text(encoding="utf-8"))
        (page_id,) = run.browser.sync_service_pages
        self.assertEqual(record, {"page_id": page_id})
        text = written[0].read_text(encoding="utf-8")
        for forbidden in ("xsec_token", "http", "first", FIRST):
            self.assertNotIn(forbidden, text)
        self.assertNotIn(page_id, json.dumps(run.bridge.manual_sync_status()))

    def test_a_round_closes_the_open_original_page_before_it_opens_its_own(self):
        run = Round(self)
        run.bridge.open_original_note(FIRST)
        (original_page,) = run.browser.sync_service_pages

        run.start()
        state = run.finish()

        self.assertEqual(state["state"], "completed")
        pages_in_order = [(kind, page) for kind, page, _url in run.browser.log]
        round_page = next(page for kind, page in pages_in_order if kind == "open" and page != original_page)
        self.assertLess(
            pages_in_order.index(("close", original_page)),
            pages_in_order.index(("open", round_page)),
        )
        self.assertEqual(run.browser.max_sync_service_pages, 1, run.browser.kinds())
        self.assertEqual(run.browser.pages, {})

    def test_while_a_round_is_running_the_request_is_refused_without_opening_anything(self):
        run = self.service()
        run.bridge.report_run_event(
            "round_started",
            batch="manual20261013120000000000",
            started_at=datetime.now().astimezone().isoformat(),
            run_board_ids=["first"],
            mode="incremental",
        )

        with self.assertRaises(BRIDGE.BridgeBusyError):
            run.bridge.open_original_note(FIRST)

        self.assertEqual(run.browser.log, [])

    def test_a_leftover_safety_stop_does_not_stop_the_lookup_from_opening(self):
        run = self.service()
        BRIDGE.PLATFORM_ACCESS.write_stop(BRIDGE.PLATFORM_ACCESS.stop_path(run.bridge.state_dir), "page")
        self.assertIsNotNone(run.bridge.legacy_safety_stop())

        result = run.bridge.open_original_note(FIRST)

        self.assertEqual(result, {"status": "opened"})
        self.assertEqual(len(run.browser.pages), 1)


if __name__ == "__main__":
    unittest.main()
