# FavSense faithful cards: QA report (dev-pipeline Step 6)

- Branch `feat/faithful-cards`, QA started at `72d2ceb`, finished at the commit list under "Fixes" below.
- Governing spec: `docs/specs/2026-10-14-favsense-faithful-cards-spec.md` (Slice A only). Mockup: `docs/designs/2026-10-14-card-design-rewrite.html`, six states.
- Review inputs: `docs/reports/reviews/2026-10-14-favsense-faithful-cards-review.md` and the design audit `design-audit-127.0.0.1-8779.md` (outside the repository, in the owner's gstack project folder).
- Driver: Playwright's bundled headless Chromium, run from small scripts, new in-memory browser context per pass, nothing persisted. Aside is not installed on this machine (macOS only) and gstack's own browser was not used because it keeps a profile folder. The owner's Chrome was never launched. No Xiaohongshu contact of any kind; the offline rebuild was the only data work.
- Servers: the brief said a public-mode server (port 8790) and a local-workbench server (port 8780) were already running. Neither was listening when QA began (connection refused from two shells, and no listener in the socket table), so QA started its own static servers over `site/` on those two ports, under a monitored task, and stopped them at the end. The browser-test fixture ports 8766, 8767 and 8768 were never bound by QA.
- Working tree at start was not clean: `docs/designs/2026-10-14-card-summary-sources.html` was modified by an earlier step, plus the untracked `.dev-pipeline/` run folder and one `.validate-tmp` file under `docs/reports/parity/`. They were left alone; every commit below stages only its own files.
- Interactive prompts from the gstack preamble (upgrade flow) were not answered; this is a non-interactive dispatch.

## Summary

Health score: 94 to 94 (provisional: Console, Visual, Functional, UX, Content and Accessibility were scored, which is 80 of 100 weight points; Links and Performance were not tested). Content moved from 92 to 100 when BUG-001 was fixed; Console stays at 70 because of the two preview-server console messages described under "Not bugs". Rounded to whole points both ends read 94.

- Bugs found: 2. Both fixed, both verified fresh. None deferred.
- Mockup states: 6 of 6 walked (desktop and phone width, on both servers), 0 new findings in the regression walk.
- Full test command and the browser tests are green on the final tree (numbers below).

## State coverage — pre-walk

Each state was opened through its `data-mockup-live-url` (`/index.html#note=<id>`) on the public-mode server (8790) and the local-workbench server (8780), at 1280 and 390 pixels wide, with an annotated screenshot per pass in `.gstack/qa-reports/screenshots/stageA-*.png` (git-ignored). Facts recorded per pass: source label, explanation sentence, fold button, chips, extracted section, banner words, U+FFFD count, link counts, sideways scroll, console messages (`stageA-facts.json` beside the screenshots).

Note on order: BUG-001 was named in the dispatch and its root cause was traced and fixed from the data before the browser walk (see BUG-001), so this baseline was taken after its fix and rebuild. The pre-fix state of the unreachable card is the screenshot the dispatch supplied (`.gstack/parity/unreachable-live.png`) and the pre-fix data copy compared in the BUG-001 entry.

- state: diandian — visited, screenshot captured (source label "点点 AI 深度总结", fold button "展开全文 · 805 字", no banner words)
- state: damaged — visited, screenshot captured (source label "原帖公开文字", post text in full, no fold button, damaged-capture sentence present)
- state: held — visited, screenshot captured (source label "点点 AI 深度总结", fold button "展开全文 · 555 字"; no topic or tool chips, see "Not bugs")
- state: transcript — visited, screenshot captured (source label "视频转写与画面文字", transcript as main text, 3 topic chips)
- state: posttranscript — visited, screenshot captured (source label "原帖公开文字", then a "视频转写与画面文字" section)
- state: unreachable — visited, screenshot captured (source label "已完成（原帖不可访问）", no extracted section, zero replacement characters)

Visual scan (taxonomy item 1) on every pass: no overlapping elements, nothing cut off, no sideways scroll in the card (0 pixels) or the page. Differences between the two servers: the footer's first control is the post link "在小红书搜索原帖" on the public-mode server and absent on the local-workbench server, which is the designed behaviour (`isLocalWorkbenchLocation`, `site/app.js:1087`).

## Triggers exercised

All six states carry `data-mockup-trigger='[]'`, an empty list: the state is reached by opening its live URL, so the single entry per state is index 0, "open the card". Each is also covered by a browser test in `site/e2e/faithful-cards.spec.mjs` on frozen fixture cards (the test file was checked first, Stage A.2.0; the line numbers below are where each state's test begins), and was walked live as described above.

- Trigger: docs/designs/2026-10-14-card-design-rewrite.html § diandian § 0
  Exercised: yes (via site/e2e/faithful-cards.spec.mjs:71; also walked live)
  Bug filed: none
- Trigger: docs/designs/2026-10-14-card-design-rewrite.html § damaged § 0
  Exercised: yes (via site/e2e/faithful-cards.spec.mjs:103; also walked live)
  Bug filed: none
- Trigger: docs/designs/2026-10-14-card-design-rewrite.html § held § 0
  Exercised: yes (via site/e2e/faithful-cards.spec.mjs:112; also walked live)
  Bug filed: none
- Trigger: docs/designs/2026-10-14-card-design-rewrite.html § transcript § 0
  Exercised: yes (via site/e2e/faithful-cards.spec.mjs:120; also walked live)
  Bug filed: none
- Trigger: docs/designs/2026-10-14-card-design-rewrite.html § posttranscript § 0
  Exercised: yes (via site/e2e/faithful-cards.spec.mjs:130; also walked live)
  Bug filed: none
- Trigger: docs/designs/2026-10-14-card-design-rewrite.html § unreachable § 0
  Exercised: yes (via site/e2e/faithful-cards.spec.mjs:148; also walked live)
  Bug filed: BUG-001

## Destructive flows

_No destructive components in this branch's diff._ The destructive-component list was empty and the callsite list was empty, so Stage A.3 and A.4 did not apply.

## Spec behaviours checked on the live data (Stage B)

| Behaviour | Evidence from the rebuilt data and the live pages |
|---|---|
| CARD-01, no status banner anywhere | Home page on 8790, both widths: 377 cards, none of the banner words found in the page text; no status field names (`summaryState`, `batch_aborted`, `stale`, `failed`) anywhere in the card data |
| CARD-02, own title | The six mockup cards show their post titles (for example "一个人，3天，Codex，10W") |
| CARD-03 to CARD-07 | The six states above |
| CARD-09, honest counts | Home line reads "377 条收藏 · 194 条有完整点点总结 · 102 条有视频转写" at both widths; the method view shows 194 and 102; "条完成深度解读" and "已完成视频内容核验" do not appear |
| No secret in public data | The card data holds no `xsec_token`; every post link is the search-page link (the post-link change is Slice B) |
| Search | A phrase from one card finds exactly that card; a script tag typed into the search box finds nothing and runs nothing |
| Mobile | 390 pixels wide: no sideways scroll on the home page or in any of the six cards |

## Bugs

### BUG-001 — Mojibake shown on the "post no longer available" card, in "视频转写与画面文字"
**Behavior**: Opening note `6a1fd8a2000000003601ff7a` ("国产“爱死机”《丧尸清道夫》创作思路分享") showed a section headed "视频转写与画面文字" whose text was garbage: "K K " followed by a run of unreadable characters containing 14 U+FFFD replacement characters, then "K K". After the fix the card has no extracted section and shows only its source line and title, as the mockup draws it. In the 377 cards this was the only one: no title, main text or other extracted text carries U+FFFD (checked by scan before and after), and a scan of every note's saved transcript, picture-text, saved-reply and catalog files found no other damaged file in use.
**Root cause**: The image-text engine writes Chinese in the Windows code page (GBK). Before the 2026-10-13 decoder fix the extractor decoded that output as UTF-8 with replacement, so older picture-text records still on disk hold U+FFFD runs. This note's record (`visual-ocr.json`, video on-screen text, saved 2026-08-29) was never regenerated, because the fix re-reads image notes only. Two other damaged records had been renamed aside by hand (`visual-ocr.garbled-20260829.json`); this one was missed. The card builder accepts a record when its stored result hash matches its text, but that hash was computed over the already damaged text, so the check passes. Nothing in the reading function refused text that cannot have been decoded truthfully. The fix is at that function, `evidenceText` in `evidence-files.mjs`, which both the card builder and the curation review preparation read through: a record whose text contains U+FFFD is treated as absent. Nothing is repaired, guessed or re-decoded. A legitimate middle dot or multiplication sign is not affected (tested).
**Layers missing**: component (the evidence reader had no test for damaged text)
**Complexity**: LOW
**Fix**: 1c4e733 (reader and tests) and e102d52 (site data rebuilt through the production snapshot path, batch `faithfulcardsreview20261014134953`, no publish; against the previous data exactly this one card changed, plus `meta.transcriptCount` 103 to 102 and the build stamp)
**Regression test**: skills/xhs-favorites-organizer/tests/extracted-text.test.mjs:89, :99, :105, :111 — four tests: a damaged record is absent from both readings, a damaged picture-text record is dropped while a sound transcript beside it stays, the review's reading refuses it too, and a middle dot and multiplication sign pass. Red before the fix (two assertions failed with the garbled text returned), green after.
**Layer tests added**: skills/xhs-favorites-organizer/tests/extracted-text.test.mjs

Independent verification (verification-before-completion, run fresh after the fix): the new test file passes 12 of 12; `npm.cmd test` passes (all seven node suites, 0 failures) and the browser tests pass 104 of 104; the rebuilt data was compared with the saved pre-fix copy (377 cards, one changed field); the live card was re-opened on both servers at both widths (zero replacement characters, no extracted section) and compared with the supplied screenshot of the broken state.

### BUG-002 — `npm run test:python` prints a non-fatal UnicodeDecodeError traceback
**Behavior**: During the Python tests a traceback from a subprocess reader thread ("UnicodeDecodeError: 'utf-8' codec can't decode byte 0xba in position 1247") appeared in the output, and the run still reported OK. After the fix the traceback no longer appears (zero occurrences in the full final run).
**Root cause**: Found by running the suite verbosely; the output comes from `RunnerEncodingTests.test_an_unknown_encoding_name_stops_the_runner` in `test_image_text_extraction.py`. Its helper starts the PowerShell video-analysis runner and captured the output with `text=True`; the runner sets `PYTHONUTF8=1`. In the failing case the stream holds two encodings: the child Python's traceback in UTF-8 and PowerShell's own error record (the line starting "At …run-video-analysis.ps1:212 char:36") in the console code page, GBK on this machine (confirmed by capturing the raw bytes: 1638 bytes of stderr, every line valid UTF-8 except that one). No single encoding reads it. The reader thread died, the test passed because it only checks the exit code and that no report was written, and `completed.stderr` was silently `None`, so any real failure message built from it (`completed.stderr + completed.stdout`) would have raised a TypeError and hidden the real failure. The product scripts were not at fault: the decoder the runner uses for the engine's output is strict by design. The fix is in the test helper: the output is captured as bytes and decoded line by line, UTF-8 when the line is valid UTF-8, otherwise the console code page.
**Layers missing**: component (the helper's own decoding had no test)
**Complexity**: LOW
**Fix**: 73fdda4
**Regression test**: skills/xhs-favorites-organizer/tests/test_image_text_extraction.py:499 — test_each_line_is_read_in_the_encoding_it_was_written_in, and :505 test_no_output_is_an_empty_string. Red before the fix (the helper function did not exist), green after.
**Layer tests added**: skills/xhs-favorites-organizer/tests/test_image_text_extraction.py

Independent verification: the module's 34 tests pass under `-W error`; the full `npm.cmd run test:python` was re-run on the final tree: 532 and 56 tests OK, zero tracebacks, zero "UnicodeDecodeError".

## State coverage — regression walk

_No regressions found._ After every fix was committed, and after the full test chain and the browser tests had run, the six states were walked again with the same script, at both widths and on both servers (24 passes). Between the two walks no site code changed; the later walk confirms the state after the full test run (which resets its own fixture server and touches no served file). The recorded facts of all 24 passes are identical to the Stage A baseline (0 differences). BUG-002 touched only a test file, so no card could be affected by it; the data rebuild was compared card by card with the pre-rebuild copy before the walk.

## Final test results (final tree, after the last commit)

| Command | Result |
|---|---|
| `npm.cmd run check:syntax` | exit 0, 112 modules |
| `npm.cmd run lint:a11y` | exit 0 |
| `npm.cmd test` | exit 0; node suites 149, 16 (1 skipped), 116, 222 (2 skipped), 12, 25, 25 passed, 0 failed |
| `npm.cmd run test:organization` | exit 0, 38 passed |
| `npm.cmd run test:python` | exit 0; 532 tests OK (1 skipped) and 56 tests OK (1 skipped); no traceback |
| `npx playwright test` | exit 0, 104 passed on desktop and phone (1.7 minutes) |

Rebuilt data (offline, production snapshot path): 377 cards, 3 unreachable, 0 with empty main text, 81 cards marked damaged-reply equal to 81 entries in the frozen list, by source 208 DianDian, 122 post text, 45 transcript, 2 image text; reply count 194, transcript count 102. The four real-data expectations of the plan's Step 5a held (titles and sources of the diandian, damaged, held and transcript cards; the held card's tool list is empty, as the plan predicted).

## Not bugs (observed, not filed)

- Console on every page of both preview servers: two messages per load (a blocked cross-origin request and a failed load) from the page's probe of the local sync service at port 47631. The probe starts because these static servers also serve `site/.local/bridge.json`, a local runtime file that the published tree excludes by rule. The probe code is older than this branch (not in the branch diff). The design audit recorded the same two messages as an environment artefact. Scored in Console (70) but not counted as a branch defect.
- The public-mode server QA ran serves `site/.local/bridge.json` (36 bytes, not read) to anyone on the local network because it serves `site/` directly. Publishing excludes that folder; only this preview setup exposes it. Worth knowing when a preview is started with `--bind 0.0.0.0`.
- Carried from the review and the design audit, unchanged, each needing an owner decision or belonging to Slice B: plain `#tag` runs still in three titles and twelve post texts (review M1; what counts as a topic tag is a decision, and changing it changes card text); transcripts never fold (design FINDING-003); the "未核实" marker has no card to show on, because no card in the data has an unverified tool, so the held card has no chips (design FINDING-004); transcript-state sentences follow plan decision D6 until the Slice B record exists (FINDING-005); the counts line wraps mid-phrase on a phone (FINDING-006); "查看总结" on cards without a summary (FINDING-007); 377 shown twice in the first view (FINDING-008).
- The transcript text itself is shown exactly as the speech engine produced it, including its recognition mistakes (for example "Trendy音榜"). That is the specified "never rewritten by AI" behaviour, not a card defect.

## Learnings

The same defect class (a record whose own hash is computed over damaged text) can recur wherever a result hash is checked only against the text it was made from: the check proves the record is intact, not that the text is readable. The reader now refuses unreadable text, and the review preparation shares that function.

<!-- pipeline:json
{
  "schema_version": 1,
  "skill": "qa",
  "step": 6,
  "phase": null,
  "severity": {"critical": 0, "high": 0, "medium": 0, "low": 0},
  "completeness": 9,
  "confidence": 9,
  "state_coverage": {"visited": 6, "total": 6, "skipped": []},
  "triggers_exercised": [
    {"trigger": "docs/designs/2026-10-14-card-design-rewrite.html§diandian§0", "exercised": "yes", "via": "site/e2e/faithful-cards.spec.mjs:71"},
    {"trigger": "docs/designs/2026-10-14-card-design-rewrite.html§damaged§0", "exercised": "yes", "via": "site/e2e/faithful-cards.spec.mjs:103"},
    {"trigger": "docs/designs/2026-10-14-card-design-rewrite.html§held§0", "exercised": "yes", "via": "site/e2e/faithful-cards.spec.mjs:112"},
    {"trigger": "docs/designs/2026-10-14-card-design-rewrite.html§transcript§0", "exercised": "yes", "via": "site/e2e/faithful-cards.spec.mjs:120"},
    {"trigger": "docs/designs/2026-10-14-card-design-rewrite.html§posttranscript§0", "exercised": "yes", "via": "site/e2e/faithful-cards.spec.mjs:130"},
    {"trigger": "docs/designs/2026-10-14-card-design-rewrite.html§unreachable§0", "exercised": "yes", "via": "site/e2e/faithful-cards.spec.mjs:148"}
  ],
  "findings": []
}
-->
