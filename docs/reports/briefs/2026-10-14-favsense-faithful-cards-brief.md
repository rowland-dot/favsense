# FavSense faithful cards: run brief (dev-pipeline Step 8)

- Branch `feat/faithful-cards`, last commit `6f2a099` (the commit that recorded the Step 7 result in the run log).
- Written 2026-10-14 from: the spec, the plan, the run log, the code review, the design review, the six comparison reports, the QA report, the test-outcome report and `TODOS.md` (paths are listed at the bottom).
- RED/GREEN evidence: docs/reports/test-outcomes/2026-10-14-favsense-faithful-cards-test-outcome.md
- I did not re-run any test for this brief. Every count below comes from the report named next to it, and I say so where it matters.

## Headline

Every one of the 377 saved notes now becomes a card built from its own text with no review gate; all test suites and the 74-row walk are green, but the six card-against-drawing comparisons still report one position difference each, so the recommended next action is Decision 1 below: merge and publish now.

What was built, in plain terms:

- Every card shows the post's own title and full text. The "证据未补齐，暂不发布" hold banner and every other status banner are gone, and the 240-character cut-off is gone.
- A complete DianDian reply is the card's text, folded, with a "展开全文" button. A reply that lost text when we saved it falls back to the post's own text and says whose fault the cut is.
- Videos with no reply show their transcript and on-screen text; image posts show their picture text. A tool name nobody confirmed carries the mark "未核实".
- The home page counts are now real: "377 条收藏 · 194 条有完整点点总结 · 102 条有视频转写" (counts from the QA report, after its last data rebuild).
- The agent review became an optional add-on (topics, tools, category suggestion, content kind). It can no longer change a title or text, or hide a card.

## Verification checklist run table

The checklist has 74 rows: 72 behaviours plus 2 final gates.

| Walk | Result | Source |
|---|---|---|
| Step 4 walk, driving the checklist in a browser the way a user would | Green, 0 failures | run log, Step 4 |
| Step 7 final walk, after the new tests and fixes touched page code | 74 of 74 rows passed | run log, Step 7 |
| Repair loop (findings fixed versus left over) | Nothing to repair: 0 failures, so 0 resolved and 0 left over | run log, Step 4 |

Two notes from those walks, neither a failure:

- One checklist row names the wrong address for the public-site check (the address `127.0.0.1` is treated by the page as the local workbench, so the public link only shows on another address). The checklist is unchanged because edits to it are refused from inside the run; the test that covers the row uses the right address.
- Real data has 81 flagged cut replies and 14 cards that show only a cut reply; the checklist and the plan say 79 and 13. The review step widened the first damage sign to match the spec's own wording, which added two flagged replies, and a later garbled-text fix removed one card's transcript.

How each group of checklist rows is covered (test files are under `skills/xhs-favorites-organizer/tests/` unless a path says otherwise):

| Rows | What they check | Covered by |
|---|---|---|
| 12, main journey | browsing, opening a card, source line, fold button, counts, post button | `site/e2e/faithful-cards.spec.mjs` (18 tests, desktop and phone), `faithful-cards-builder.test.mjs`, `card-content.test.mjs` |
| 8, privacy and boundaries | no token in public data, no network in the card path, add-on cannot change text | `faithful-cards-builder.test.mjs`, `faithful-cards-boundaries.test.mjs`, `faithful-cards-public-safety.test.mjs`, the project's `verify` command |
| 10, interactions | fold with bookmark, edit, restore, search, copy link | `site/e2e/faithful-cards.spec.mjs`, `site/e2e/faithful-cards-states-audit.spec.mjs` |
| 28, edge cases | cut replies, titles, paragraphs, damaged list, snapshot, documents | `card-content.test.mjs`, `damaged-replies.test.mjs`, `extracted-text.test.mjs`, `organize-paragraphs.test.mjs`, `test_post_text_paragraphs.py`, `faithful-cards-docs.test.mjs` |
| 7, phone width | no sideways scroll, controls reachable | `site/e2e/faithful-cards.spec.mjs` on the phone project |
| 7, accessibility | fold button state, labelled sections, focus order, contrast | `site/e2e/faithful-cards-states-audit.spec.mjs`, the project's `lint:a11y` command |
| 2, final gates | the whole test chain; comparing live cards with the drawings | the Step 7 gate run; the six looks listed next |

No functional row is left without an automated test, so there is no coverage gap to send back to an earlier step.

### Manual verification checklist

These six looks are the human repeat of the last checklist row (compare the real cards with the drawings in `docs/designs/2026-10-14-card-design-rewrite.html`). Each is a judgement of how the card looks, so each carries a category tag. Nothing here is a function that lacks a test.

- [ ] `[manual-only: visual-polish]` Open "一个人，3天，Codex，10W": the red source box says 点点 AI 深度总结, the reply is folded, and "展开全文 · 805 字" opens the whole reply.
- [ ] `[manual-only: visual-polish]` Open "小红书爆款高赞Skill汇总‼️": the source box says 原帖公开文字 and explains that the saved reply lost text; the post's whole text follows with no fold button.
- [ ] `[manual-only: visual-polish]` Open "Seedance老废片？花2W得出的提示词模板分享": it looks like the first card, with no banner. No tool chip is expected, because the real saved data lists no tool for this note.
- [ ] `[manual-only: visual-polish]` Open "AI搜索引擎项目，GitHub TrendIing榜第一": the source box says 视频转写与画面文字 and the transcript is the card's text.
- [ ] `[manual-only: visual-polish]` Open "接了个开源CLI，ClaudeCode能生图生视频了": the post's text comes first, then a separate section headed 视频转写与画面文字.
- [ ] `[manual-only: visual-polish]` Open "国产“爱死机”《丧尸清道夫》创作思路分享": the source box says 已完成（原帖不可访问）, and there is no garbled section underneath.

### Mockup coverage

Mockup states: 6 total across 1 mockup file (`docs/designs/2026-10-14-card-design-rewrite.html`; the file under `docs/designs/archive/` is archived and not counted).
- Covered: 6. The QA report maps each state to its own browser test in `site/e2e/faithful-cards.spec.mjs` (tests starting at lines 71, 103, 112, 120, 130 and 148, which I checked), and walked each state live at two widths on two servers.
- Uncovered: 0. Only the post-plus-transcript test names its state in its title; the other five are matched by the QA report's mapping, not by the state's name.

## Plan task completion

| Point in the run | Done | Partial | Missing | Orphan |
|---|---|---|---|---|
| Step 4 entry (inventory before building) | 0 of 10 tasks | 0 | 10 | not applicable |
| End of run | 10 of 10 tasks, 62 of 62 plan steps ticked (`grep` count of ticked boxes in the plan, run by me just now) | 0 | 0 | 0 reported |

- What Stage B did: built all ten tasks as separate commits, then the run log's Step 4 code gate passed.
- The orphan check (a page part that is built but never put on the page) does not apply here: the site is plain JavaScript with no `components/` folder, so the run log records it as a warning, not a finding.
- Confirmed deferred before building: spec section 7 listed removal of the rule "downloads and transcription skip notes the agent already curated" under this slice. The plan audit moved it to the second stage, because removing it before the new trigger exists would make the owner's next sync queue downloads for every curated note, against his ruling "only when needed". The approved spec text was not edited. The run proved the seven files that hold the rule are untouched.

## Step 5 findings table

All three counts are before and after this run's own fixes. Source: run log, Step 5, and the three reports it names.

| Part | Before | After | What is left, and why |
|---|---|---|---|
| Phase 1, code review (`docs/reports/reviews/2026-10-14-favsense-faithful-cards-review.md`) | Critical 0, High 1, Medium 1, Low 3 | Critical 0, High 0, Medium 1, Low 3 | The one High was two cut replies shown as complete, one still showing DianDian's chat opener; fixed by widening the first damage sign (flagged list grew 79 to 81). Medium left: plain `#tags` stay in some titles and texts (Decision 6). |
| Phase 2, design review (the audit under `~/.gstack/projects/rowland-dot-favsense/designs/design-audit-20261014/`) | Critical 0, High 1, Medium 3, Low 4; design B, slop A | High 1, Medium 2, Low 4; design B, slop A | The transcript styling fix landed. The High (garbled text on the unreachable card) was fixed later in Step 6. Remaining items are in the deferred table below and in Decisions 3 and 6. |
| Phase 3, card against drawing comparison (six cards, totals across them) | First pass: Critical 12, High 18 (2 and 3 per card) | After remediation: Critical 0, High 6, Medium 5. Step 7 re-run: Critical 0, High 6, Medium 4, Low 2 | The first-pass findings came from the test setup, not card drift: the loopback address put the page in local-workbench mode, the dialog had an implicit role the tool could not read, and the drawing showed each card half width in a side-by-side column. Fixes: a public-mode test address, a native dialog in the drawing, and the live card's close button added to the drawings (Decision 5). The six High left are explained next. |

Residual High, one cause for all six: the live card is a pop-up near the top of the screen, while the drawing sits inside a long comparison page. In every one of the six reports "structural drift" reads "none": the same elements appear in the same order.

| Card | Live pop-up, pixels from top | Drawing, pixels down the comparison page |
|---|---|---|
| diandian reply | 12 | 427 |
| cut reply | 12 | 1,562 |
| formerly held | 12 | 2,601 |
| transcript as text | 85 | 3,737 |
| post plus transcript | 12 | 4,475 |
| unreachable post | 196 | 5,432 |

The run did not hand this to the fixing agent, which is limited to Critical findings, and the only code change that would clear it is moving the real pop-up to match a spot on a comparison page, which would make the product worse. It is recorded as failed for the owner, not silenced (run log, Steps 5 and 7). Source for the table: `docs/reports/parity/2026-10-14-step7-favsense-faithful-cards-card-design-rewrite-parity.md`. The other six per-card parity files in that folder are earlier passes and are out of date.

## Step 6 QA and Step 7 coverage fill

Step 6 (QA report `docs/reports/qa/2026-10-14-favsense-faithful-cards-qa-report.md`): 2 bugs found, 2 fixed, 0 deferred, health score 94.

- Garbled picture text on the unreachable card, because an old record held text decoded with the wrong code page and its own checksum could not catch it. The reader now treats any saved text containing replacement characters as absent (nothing is repaired or guessed). One card changed in the data; the transcript count went 103 to 102.
- A Python test printed a harmless but confusing error from mixed encodings in one output stream; fixed in the test helper.

Step 7 (test outcome `docs/reports/test-outcomes/2026-10-14-favsense-faithful-cards-test-outcome.md`): 2 more real bugs found and fixed.

- A long tool name pushed the "未核实" mark outside its chip, so the very signal the spec asks for was hidden. Fixed; a browser test guards it.
- The page builder's safety check was weaker than the publisher's. A post containing a password-shaped value or a direct post link would build cleanly and then block the one publish with no note named. The builder now uses the publisher's own list, so it stops early and names the note and field.

Tests added in Step 7: 18 browser runs (9 cases on desktop and phone), 14 builder and boundary tests, 5 smaller ones.

| Measure | Value | Source |
|---|---|---|
| Browser tests (e2e) | 110 at the start, 104 after the plan's intended swap of old tests, 122 at the end (+12 over the start) | run log; test outcome |
| Node test suites passing, my sum of the seven suites | 565 after QA, 587 at the end (+22) | QA report; test outcome |
| Python tests | 532 and 56 pass, no traceback | test outcome |
| Other gates | syntax check (112 modules), accessibility lint, organization tests (38), the project's verify command, all pass | test outcome |
| Regressions | 0: the 24-pass QA re-walk matched the first walk exactly | QA report |

The numbers come from reports of runs made by earlier steps. I did not repeat them.

### Known gaps and deferred items

Deferred means tracked for later work. Every row is either in `TODOS.md` or in the named report. There are 19.

| # | Item | Where it is tracked |
|---|---|---|
| 1 | A watched DianDian run comparing the three copies of one reply | TODOS.md, second stage; waits for the captcha hold to clear and a time you agree |
| 2 | Save only when the copy matches character for character, three tries then "点点未取得", and the re-fetch of the flagged replies | TODOS.md, second stage |
| 3 | Live test of a direct post link, the button wording that follows, and the publish check's ban on direct links | TODOS.md, second stage |
| 4 | Per-folder "已采集 N / 收藏夹共 M" on the home page | TODOS.md, second stage |
| 5 | Reader-engine trigger (download and transcribe only for notes DianDian did not give) and the "3 次" wording in source lines | TODOS.md, second stage |
| 6 | Removal of the rule that skips curated notes for downloads, and its switch | TODOS.md, closes with item 5 |
| 7 | Replace the rule that any DianDian failure stops the whole plan | TODOS.md, closes with items 1 to 5 |
| 8 | Existing notes get paragraph breaks back only when their details are next fetched | TODOS.md; until then the 377 live cards show post text as one block |
| 9 | Delete the unused bridge endpoint and its checker | TODOS.md |
| 10 | Let you mark a flagged reply complete so regeneration keeps it off the list | TODOS.md, closes when you rule on Decision 4 |
| 11 | Put a version marker on the page's script and stylesheet addresses | TODOS.md |
| 12 | Make the pipeline's browser-test start-up check recognise a site with no login | TODOS.md (first line) |
| 13 | The "未核实" mark never appears on real data because no saved tool is unverified | design review, finding 4 |
| 14 | Source sentences on three states follow the plan's wording, not the drawing's | design review, finding 5 |
| 15 | The home counts line breaks mid-phrase at phone width | design review, finding 6 |
| 16 | Cards without a summary still say "查看总结" | design review, finding 7 |
| 17 | The number 377 appears twice in the first screen | design review, finding 8 |
| 18 | A stray extra slash in a code comment | code review, low item 1 |
| 19 | Transcripts and picture text show as one block because the reader flattens line breaks | code review, low item 2 |

### Information only (not decisions)

- **Second reviewer unavailable.** The Codex outside reviewer could not run during the code review, the plan reviews or the design review, so those used Claude's own readers only.
- **Two exceptions before the run, both approved by you at the time.** The pipeline could not detect the installed plugin it checks for (it was installed as a plugin), and you confirmed it was available; this is in the run log only. The browser-test login check stopped the run because FavSense has no login, and you said to carry on; this one is in `TODOS.md` (item 12). Only the second is in `TODOS.md`.
- **The pixel-level comparison never ran inside the pipeline.** Two packages it needs were not installed, the runner handed it the wrong address, and the drawings needed section wrappers. It was run by hand afterwards: pixels different per card were 9.0% (diandian reply), 24.2% (cut reply), 13.3% (formerly held), 16.1% (transcript), 23.2% (post plus transcript) and 9.9% (unreachable). The run log says the images were inspected: same content and layout, with differences from a roughly 35-pixel vertical shift in the drawing, the deferred link wording, the deferred "3 次" wording, the drawing's fixed purple accent, the transcript shown in full versus a 600-character cut in the drawing, and (before the fix) the garbled transcript.
- **Both plan audits stopped at their three-pass limit** with the last pass still finding problems (the last Step 2 pass found a rebuild step that would have halted and 13 cards that would have shown no text; the last Step 3 pass found the catalog writer flattening paragraphs a second time). All of those were fixed in the plan before building, but neither audit ever reached a clean pass.
- **Numbers the plan asked the run to print are not in the run log:** how many cards the add-on changes, and how many cards contain third-party contact details now that full text is public. I did not find them, so I cannot report them; the contact-detail count was meant to inform your earlier ruling to publish full text.
- **After the next rebuild the build version changes.** Page code changed after the last data build; cards and data are unchanged.
- **Preview servers.** QA found both preview servers down and ran its own. A preview started to listen on all network addresses would also serve a small local file the published site excludes.
- **Working folder.** One drawing file (`docs/designs/2026-10-14-card-summary-sources.html`) shows as modified, but only in line endings (a diff that ignores line endings is empty), plus the run's own `.dev-pipeline/` folder and one temporary comparison file. They are not part of this brief's commit.

## Outstanding decisions

Decision 1 is the merge decision. Decisions 2 to 6 can be answered after the merge; the only one that changes what goes live is Decision 2, noted there.

**Decision 1 — Merge and publish:**
Before the run you approved merging and publishing if every check passed. Not every check passed: the card comparison still reports six position differences (the High findings above), all about where the card sits, none about what is on it. Every test suite and the 74-row walk are green.
- Merge and publish now. **Recommendation:** the only open items are a measurement of page layout, not card content; the comparison finds no structural difference in any of the six cards; and the run log's judgement is that moving the real pop-up to satisfy the measurement would make the product worse. Merging runs your normal landing steps: one rebuild and one publish from a frozen snapshot, then the live check against the drawings. Decision 2's sentence goes live as it stands.
- Hold until you have looked at a preview. I start a preview of the branch and open it; you look at the six cards in the manual list above and decide. Nothing is merged or published meanwhile.
- Hold until the second stage (the work that needs Xiaohongshu contact) is done. That waits for the captcha hold to clear and a time you agree, and leaves the live site on the old cards until then.

**Decision 2 — The one new sentence on the 14 cards that show only a cut reply:**
These cards have no usable post text and no transcript, only a saved reply that lost its ending. Showing the saved part beats a blank card (a simulation at plan audit found 13 blank cards otherwise; 14 on real data now). Their source line reads:

> 保存的点点回复缺了内容（是我们采集出错），下一轮重新获取；原帖只有话题标签、没有正文，所以先显示已保存的那部分点点回复。

The first half is wording you approved for cut replies. "原帖只有话题标签、没有正文" reuses a phrase from the transcript drawing. Only "所以先显示已保存的那部分点点回复" is new, and the plan flags it `[needs user-approved copy]`. The text lives at `site/app.js` line 511. Also note "下一轮重新获取" promises a re-fetch that is second-stage work (items 1 and 2 above).
- Approve it as written. **Recommendation:** it reuses your approved wording except one clause, and the alternative is a blank or unexplained card.
- Give your own wording: you send the sentence, and I change that one string plus the two tests that read it, then re-run the checks.
- Show these cards with only the approved first half, ending after "下一轮重新获取；": the card then says the reply lost text but not why only the saved part is shown.

**Decision 3 — Long video transcripts: fold or show in full:**
The spec says nothing about folding transcripts. Live shows them in full. The design review measured the longest at 9,116 characters: about 3.8 screens on a desktop and 9.6 on a phone, with the topics and buttons below it. It counted 45 cards with a transcript as their main text and 65 more with one below the post text. The drawing of the post-plus-transcript card shows the transcript cut at about 600 characters; the drawing of the transcript-as-text card shows no fold.
- Fold transcripts the way DianDian replies fold, with the same "展开全文 · N 字" button. **Recommendation:** the fold code already exists, and nine phone screens of speech-to-text is hard to read. It is a small follow-up change after this merge.
- Keep transcripts in full, as built.
- Fold both transcripts and any long post text.

**Decision 4 — The two doubtful entries on the cut-reply list:**
The list follows the spec's two signs and was not tuned. At plan review 77 of 79 were plainly cut; two are doubtful, and the later widening added two plainly cut ones. The post whose ID ends 01e252 has a reply that ends on the heading "标签" above a line of hashtags, so it may be complete. The post whose ID ends 03930b ends on two short lines, "RAG 医疗问答" and "Agent 智能客服", which could be a finished list. If either is complete, its card shows the post's own text and its source line wrongly blames our capture until the next fetch.
- Keep both on the list. **Recommendation:** you told the run not to tune the rule, the cost of a wrong flag is only a fallback card until the next fetch, and the real fix is the override in deferred item 10.
- Mark one or both complete by hand now. Be aware a hand edit of the private list is undone the next time the list is regenerated, so this lasts only until then.
- Change the rule so a heading followed only by hashtags counts as finished. This affects only the 01e252 case and changes the damage rule you asked to leave alone.

**Decision 5 — Edits the run made to the drawings without asking you:**
Both edits are in `docs/designs/2026-10-14-card-design-rewrite.html`. You had not approved either.
- The commit that added the live card's close button to the six new-design drawings (0c18f49). It was copied word for word from `site/index.html` lines 236 to 238 with its id dropped. The drawings' own screenshots of the current cards show that button; without it the comparison reported an extra button on every card.
- The commit that changed the wrapper around each of the six drawings from a plain division to a section element (0a32dbb). The comparison tool's layout reader only finds section elements. No wording or look changed.
- Accept both. **Recommendation:** both are structure only, copied from the live page, and the drawings stay readable by the comparison tool.
- Accept the section wrappers but take the close button back out.
- Revert both. The comparison tool can then no longer read the drawings, and the extra-button finding returns on all six cards.

**Decision 6 — Plain `#tags` left in some card titles and texts:**
The spec says a fallback title is the post's first line with topic tags removed, but only tags in the `#…[话题]#` form are removed. The code review found one card whose title still ends in "#开源项目 #自媒体 #开发者 #一…" (the post whose ID ends 03d0c8). The QA report counts three titles and twelve post texts affected. Changing it changes card text.
- Strip a run of `#word` tags at the end of a line (the reviewer's suggestion). **Recommendation:** it matches the spec's wording and leaves text such as "C#" or "#1" inside a sentence alone. Done as a follow-up change after the merge.
- Leave as is.
- Strip every `#word` everywhere. Risky: it would also hit "C#" and "#1".

## Recommended next pipeline invocation

The next step is Decision 1, the merge decision. If you choose "Merge and publish now", nothing further runs in this pipeline: the rebuild, the single publish and the live check follow your project's landing rules.

If you hold the merge to have changes made first (Decision 2's wording, or folding transcripts), the most conservative resume point is the building step:

```
/dev-pipeline 4..
```

Sources read for this brief:

- Spec: `docs/specs/2026-10-14-favsense-faithful-cards-spec.md`
- Plan: `docs/plans/2026-10-14-favsense-faithful-cards-plan.md`
- Run log: `docs/reports/audit/2026-10-14-favsense-faithful-cards-audit.md`
- Checklist: `docs/specs/2026-10-14-favsense-faithful-cards-verification-checklist.md`
- Code review: `docs/reports/reviews/2026-10-14-favsense-faithful-cards-review.md`
- Design review: `C:/Users/rowla/.gstack/projects/rowland-dot-favsense/designs/design-audit-20261014/design-audit-127.0.0.1-8779.md`
- Comparison reports: `docs/reports/parity/` (final: the Step 7 file)
- QA: `docs/reports/qa/2026-10-14-favsense-faithful-cards-qa-report.md`
- Test outcome: `docs/reports/test-outcomes/2026-10-14-favsense-faithful-cards-test-outcome.md`
- Follow-ups: `TODOS.md`

Completeness: 8/10  Confidence: 7/10

<!-- pipeline:json
{
  "schema_version": 1,
  "skill": "patch-brief",
  "step": 8,
  "phase": null,
  "severity": {"critical": 0, "high": 0, "medium": 0, "low": 0},
  "completeness": 8,
  "confidence": 7,
  "findings": []
}
-->
