# FavSense Faithful Cards — Slice A Verification Checklist

> Derived from three sources, in this order: the APPROVED spec `docs/specs/2026-10-14-favsense-faithful-cards-spec.md` (behaviours and acceptance criteria), the plan `docs/plans/2026-10-14-favsense-faithful-cards-plan.md` (task scope and edge cases), and the mockups (structure and interaction states only, never CSS styling).
>
> Mockup tag form: `[mockup: <path> § <section>]`. The two files are `docs/designs/2026-10-14-card-design-rewrite.html` (cases ① to ④, right-hand "新设计" panels) and `docs/designs/2026-10-14-card-summary-sources.html` (fold, source box with the edit button inside, footer).
>
> Scope: Slice A only. Slice B items (CAP-01 to CAP-05, LINK-01 to LINK-03, COMP-01, §5.1) have no rows here; the plan lists them.

## How to use this list

- Every row is one action and one named, user-visible outcome, and carries the spec behaviour it covers: `CARD-01` to `CARD-09`, `AC-NOGATE`, `AC-ADDON`, `AC-PARA`, or (for rows no behaviour ID can carry) the spec section.
- Evidence column: `PW n` = test n of `site/e2e/faithful-cards.spec.mjs` in the plan's Task 5 list, run on the desktop and the phone project; `NODE` = a `node:test` file named in the row (`builder test n` = test n of `faithful-cards-builder.test.mjs`, Task 6 list); `PY` = a Python `unittest` file; `RUN` = output of a plan Task 10 run step on real data (the run, never a test); `LIVE` = the check after publishing, done against `docs/designs/2026-10-14-card-design-rewrite.html`.
- A row passes only with the evidence run in the same turn that reports it (exit code or printed value). `manual-only` is limited to `[manual-only: visual-polish]` and `[manual-only: subjective-ux]`; every function here is automated.
- Real card text is public already (it is on the live site). Real private data is never pasted into evidence: report counts, note IDs and hashes only.

## P0 — Primary journey (open the site, browse, open a card, read it)

- [ ] **V-P0-01** · CARD-01 · Open the home page and scroll the whole card grid. → Every card in the data appears, and no card shows `证据未补齐，暂不发布` or any other status banner (`总结未通过审核`, `本篇总结失败`, `本次未尝试`, `需重新核验`, `尚未开始深度整理`, `总结已保存，尚未完成证据核验`, `待审核`). `[mockup: rewrite § ③]` Evidence: PW 1; LIVE 377 cards, zero banners.
- [ ] **V-P0-02** · CARD-09 · Read the numbers on the home page. → One line reads `<noteCount> 条收藏 · <N> 条有完整点点总结 · <M> 条有视频转写`, where N is the number of cards showing a complete DianDian reply (a cut reply shown only because nothing else exists, see V-P3-28, is not counted) and M the number of cards that show a video transcript; `343 条完成深度解读` and `已完成视频内容核验` appear nowhere. Evidence: PW 11; NODE `card-content.test.mjs` (`cardCounts`); builder test 11; LIVE.
- [ ] **V-P0-03** · CARD-02 · Click the card for note `…0090ff`. → The detail title is `一个人，3天，Codex，10W` (the post's own title, not a rewritten one). `[mockup: rewrite § ①]` Evidence: PW 2; builder test 1; LIVE.
- [ ] **V-P0-04** · CARD-03 · In that detail view read the source box. → It says `点点 AI 深度总结` and `点点 AI 的完整回复，原文未改动，共 <N> 字`, and the reply's opening line `根据你引用的笔记` is not shown. `[mockup: rewrite § ①]` `[mockup: summary-sources § ①]` Evidence: PW 3; builder test 2.
- [ ] **V-P0-05** · CARD-03 · Click `展开全文 · <N> 字`. → The whole reply is revealed (headings such as `核心故事`, the numbered list of four questions), and the button now reads `收起`. `[mockup: rewrite § ①]` Evidence: PW 3.
- [ ] **V-P0-06** · CARD-05 · Open the formerly held card `Seedance老废片？花2W得出的提示词模板分享`. → It looks like card ① (same source line, folded reply, no banner). A tool chip without a confirmed source carries the badge `未核实`: on the fixture card this is `Seedance 导演 Skill`; on the real card no chip is expected, because its saved add-on lists no tools (checked 2026-10-14). `[mockup: rewrite § ③]` Evidence: PW 5; builder test 5; LIVE (source line and folded reply only).
- [ ] **V-P0-07** · CARD-04 · Open `小红书爆款高赞Skill汇总‼️` (reply saved with lost text). → The source box says `原帖公开文字` with the sentence `保存的点点回复缺了内容（是我们采集出错），下一轮重新获取；在那之前先显示原帖自己的文字。`, and the main text is the post's whole text with no fold button. `[mockup: rewrite § ②]` Evidence: PW 4; builder test 3; LIVE.
- [ ] **V-P0-08** · CARD-06 · Open `AI搜索引擎项目，GitHub TrendIing榜第一` (a video whose post has only topic tags). → The source box says `视频转写与画面文字` and the main text is the transcript, starting `记住这个地表超强AI搜索引擎项目`. `[mockup: rewrite § ④]` Evidence: PW 6; builder test 7; LIVE.
- [ ] **V-P0-09** · CARD-07 · Open the fixture card whose post has text and whose video has a transcript, with no DianDian reply. → The post's full text is the main text and, below it, a section headed `视频转写与画面文字` shows the transcript. `[mockup: rewrite § ④]` Evidence: PW 7; builder test 8.
- [ ] **V-P0-10** · CARD-08 · Open the fixture card whose post has two paragraphs. → The main text shows two separate paragraphs. Evidence: PW 8; builder test 10; NODE `card-content.test.mjs` (`postBody` keeps breaks).
- [ ] **V-P0-11** · §3.1 post button (LINK-02 is not in this slice) · Look at the detail footer on the public site. → The first control is `在小红书搜索原帖`, a link to a Xiaohongshu search page, followed by `复制卡片链接` and the bookmark button; no link anywhere contains `/explore/`. (In the test this is the public origin `127.0.0.1:8767`; on the local workbench origin `127.0.0.1:8766` the first control is the local `打开原帖` or `请先启动 FavSense 本地服务` button instead.) `[mockup: summary-sources § ①]` Evidence: PW 12; builder test 17.
- [ ] **V-P0-12** · AC-NOGATE · Rebuild with every review record (audit, run report, candidates, curation) removed. → All titles, main texts and main sources are identical to the build with them. Evidence: builder test 13; RUN real-data copy comparison (377 cards, zero differences).

## P1 — Permissions and boundaries (privacy, no platform contact, nothing private shipped)

- [ ] **V-P1-01** · AC-NOGATE · Build public data from a post whose text contains `xsec_token=…`. → The build stops with `Public data safety check failed` and writes no output file. Evidence: builder test 15.
- [ ] **V-P1-02** · AC-NOGATE · Run `npm.cmd run verify`. → It exits 0: no tracked path under `.xhs-favorites/`, `.xhs-tools/`, `config/xhs-favorites.json`, `site/.local/`, and the public tree contains no profile path, board id or token. Evidence: command exit code.
- [ ] **V-P1-03** · §8 · Search the new and changed modules (`card-content`, `damaged-replies`, `extracted-text`, `evidence-files`, the builder) for network access. → None imports `http`, `https`, `net`, `dgram`, a fetch call or a browser driver; the offline rebuild opens no Xiaohongshu page. Evidence: `grep` result printed in the review; RUN Task 10 Step 5 used only `build_organization_snapshot`.
- [ ] **V-P1-04** · AC-ADDON · Change the add-on (curation entry or sealed candidate) for a note. → Topics, tools, category suggestion and kind may change; title, main text, source line and extracted section do not. Evidence: builder test 14.
- [ ] **V-P1-05** · §7 · After the archive step, run `git status`. → No `.xhs-favorites/` path, no archive folder and no private config appears; the archive folder holds the moved files (about 209: roughly 204 batch and review files plus the five private scripts, `bridge-prompt-version.py` among them) and `agent-written-card-texts.json` (about 105 entries). Evidence: RUN printed counts and `git status` output.
- [ ] **V-P1-06** · §7 · After the archive step, list the files that must stay. → `catalog.json`, `curation-audit.json`, `curation-candidates.json`, `curation-scope.json`, `published-baseline.json`, `diandian-rerun-report.json`, `manual-sync.json`, `local-rebuild.json` and `damaged-diandian-replies.json`, `bridge-status.json` and `bridge-token` are still in `.xhs-favorites/`, and the rebuild after the move gives the same titles and main texts. Evidence: RUN.
- [ ] **V-P1-07** · CARD-03 · Save a personal revision of a card's text. → It is stored only in the browser's local storage and the data file the site serves is byte-identical to before. Evidence: PW 15 (new assertions).
- [ ] **V-P1-08** · §3.1 · Open the data file the site loads. → No card carries `summary`, `deepSummary`, `deepSummarySource`, `curationRevision`, `summaryStatus`, `curationStatus`, `summaryReason`, `summaryState`, `summaryReasonCode`, `candidateKind`, `reviewedAt`, `action` or `evidence`. Evidence: builder test 16.

## P2 — Interactions

- [ ] **V-P2-01** · CARD-03 · Click the fold button, then add a bookmark while the reply is open. → The reply stays open after the card is re-drawn, and folds again after the dialog is closed and reopened. `[mockup: summary-sources § ①]` Evidence: PW 15.
- [ ] **V-P2-02** · CARD-03 · Press `编辑描述` in the source box. → The editor opens with the text on screen (the reply without its opening line); the button is inside the source box, right of the label. `[mockup: summary-sources § ①]` Evidence: PW 12.
- [ ] **V-P2-03** · CARD-03 · Save a personal revision, then press `恢复系统版本`. → The revision replaces the reply while saved (the grid label shows `个人修订 · 点点 AI 深度总结`), and the reply with its fold button returns after restoring. Evidence: PW 15.
- [ ] **V-P2-04** · CARD-03 · Open a short reply that fits the folded height. → It shows whole, with no fold button and no fade mask. `[mockup: summary-sources § ①]` Evidence: PW (the kept "short reply" case, fixture card `fixture-short-reply`).
- [ ] **V-P2-05** · CARD-04 · Type a phrase that occurs only in a post's full text into the search box. → The card that shows that post text is listed. Evidence: PW 17.
- [ ] **V-P2-06** · CARD-06 · Type a phrase that occurs only in a shown transcript into the search box. → The transcript card is listed. Evidence: PW 17.
- [ ] **V-P2-07** · CARD-01 · Choose a content-kind filter and a category in the sidebar. → The grid narrows to matching cards and still shows no banner. Evidence: PW 1 on the filtered grid; existing `design-*` specs stay green.
- [ ] **V-P2-08** · CARD-03 · Compare a card in the grid with its detail view. → The grid preview shows the same source label and the same beginning of text as the detail view. Evidence: PW 13.
- [ ] **V-P2-09** · §3.1 · Click `复制卡片链接` with clipboard permission granted. → A toast says `卡片链接已复制` and the copied address ends with `#note=<id>`. Evidence: PW 12 (clipboard assertion added in the plan).
- [ ] **V-P2-10** · AC-ADDON · Open a detail view that has topics and tools. → Topic chips and tool chips both show under "相关主题与工具"; a tool with no official source shows the `未核实` badge as visible text. `[mockup: rewrite § ③]` Evidence: PW 5.

## P3 — Edge cases

- [ ] **V-P3-01** · CARD-04 · Replace the damaged reply's saved copy with a different (re-fetched) one and rebuild. → The card is complete again: source `点点 AI 深度总结`, main text is the new reply. Evidence: builder test 3 (second half).
- [ ] **V-P3-02** · CARD-04 · Build a note whose saved reply is a refusal ("无法访问链接…"). → It is treated as no reply: main text is the post text and it is not on the damaged list. Evidence: builder test 4; NODE `damaged-replies.test.mjs` (refusal excluded).
- [ ] **V-P3-03** · CARD-04 · Run the damaged-list command on the real saved replies. → It prints a count and every note ID using only the two spec signs; the rule is not changed to reach 71 (79 on 2026-10-14, read entry by entry at plan review: 77 plainly cut, 2 doubtful), and the printed list and the two doubtful IDs are recorded in the Task 6 commit body and the review brief. Evidence: RUN printed output.
- [ ] **V-P3-04** · CARD-04 · Give the damage detector a complete reply that ends on a trailing hashtag line. → No sign is reported. Evidence: NODE `damaged-replies.test.mjs`.
- [ ] **V-P3-05** · CARD-04 · Start the builder without a damaged list file; then with a malformed one. → The first builds with no damaged replies; the second stops with an error, not an empty list. Evidence: NODE `damaged-replies.test.mjs`.
- [ ] **V-P3-06** · CARD-02 · Build a note with no title and a first line of 60 characters. → The title is the first 51 characters followed by `…`. Evidence: NODE `card-content.test.mjs`; builder test 1.
- [ ] **V-P3-07** · CARD-02 · Build a note with neither title nor text. → The title is `<author>的收藏`. Evidence: builder test 1.
- [ ] **V-P3-08** · CARD-06 · Open a card whose post has only topic tags and which has no transcript and no saved DianDian reply at all (fixture `fixture-no-text`). → The detail view shows its header and chips, no source box and no text section, and no new wording. (No real card is in this state; a card with a cut reply is V-P3-28.) Evidence: NODE `card-content.test.mjs` ("nothing at all gives an empty main text"); PW 16.
- [ ] **V-P3-09** · CARD-07 · Build a note with a complete reply and an existing transcript. → The reply is the main text, no transcript section is drawn, and the transcript is not counted in M. Evidence: builder tests 8 and 11.
- [ ] **V-P3-10** · CARD-06 · Build an image post with picture text and no post text. → The source box says `图片文字` and the main text is the picture text. Evidence: builder test 9; PW 10.
- [ ] **V-P3-11** · CARD-05 · Build a note whose add-on says Skill but whose tool has no matching verified resource. → The kind is not `Skill`, the tool name is listed with `未核实`, and the card is not hidden. Evidence: builder test 5.
- [ ] **V-P3-12** · CARD-05 · Build a note whose add-on says Skill with exactly one fresh verified resource. → The kind is `Skill`, there is no `未核实` badge, and the resource appears under "相关资源". Evidence: builder test 6.
- [ ] **V-P3-13** · §3.1 unreachable post · Build a note that the review audit file marks `unavailable` (or whose sealed candidate says so; plan D3). → The source box says `已完成（原帖不可访问）` with `原帖可能已被作者隐藏或删除；已保留现有记录并结束补证，不作为正式核验结果发布。`; title and main text are the same as without the flag. Evidence: builder test 12; PW 9.
- [ ] **V-P3-14** · AC-PARA · Feed the detail cleanup `第一段  有空格\n\n第二段\n第三行`. → The saved description is `第一段 有空格\n\n第二段\n第三行`. Evidence: PY `test_post_text_paragraphs.py`.
- [ ] **V-P3-15** · AC-PARA · Feed it Windows and old-Mac line endings, three or more blank lines, a blank-only text, and 25,000 characters. → Line endings become `\n`, blank runs shrink to one blank line, blank-only text is empty, and the text is cut at 20,000. Evidence: PY `test_post_text_paragraphs.py`.
- [ ] **V-P3-16** · AC-PARA · Feed it a title and an author containing line breaks. → They stay on one line. Evidence: PY `test_post_text_paragraphs.py`.
- [ ] **V-P3-17** · CARD-08 · Build a note with a 5,000-character post. → The main text is all 5,000 characters. Evidence: NODE `card-content.test.mjs`.
- [ ] **V-P3-18** · CARD-07 · Change the post's text so its content hash changes, keeping the saved transcript. → The transcript still shows (it is not matched to the post's hash); a transcript whose text does not match its own hash is not shown. Evidence: NODE `extracted-text.test.mjs`.
- [ ] **V-P3-19** · AC-NOGATE · Build with a stale private config that still has `curation_quality.publish_only_accepted` and a missing audit file. → The build succeeds and the cards are unchanged. Evidence: builder test 13.
- [ ] **V-P3-20** · AC-NOGATE · Run the snapshot after the damaged list, a transcript or the audit file (the unreachable list) changes. → The build version differs; with nothing changed it is identical. Evidence: NODE `test_organization_snapshot.mjs` (new cases); PY `test_final_build.py`.
- [ ] **V-P3-21** · §5.1 / §2 "Only when needed" (plan D13) · Queue downloads, transcription and frames for a note that is already in the curation file, without naming it. → It is still skipped, and `-IncludeCurated` with `-NoteId` still lifts the skip for the named note: the curated-skip rule is kept in Slice A (its removal waits for the §5.1 trigger in Slice B), so the owner's next sync does not queue downloads for previously curated notes. Evidence: PY `test_media_queue.py`, `test_transcription_pipeline.py`, `test_frame_extraction.py`, `test_review_include_curated.py` and `test_bridge.py::test_media_queue_skips_curated_and_cached_notes` pass unchanged; `git diff --stat 1a9ef29 -- <the seven files>` prints nothing (plan Task 8 Step 4).
- [ ] **V-P3-22** · §7 · Merge a review item that carries no packet hash, with no prompt version supplied. → The merge succeeds; review preparation outputs no packet hash. Evidence: NODE `test_curation_standard.mjs`.
- [ ] **V-P3-23** · §7 · Build curation evidence for an accepted note that has a reply saved after review. → The reply counts as evidence (no "saved after review" exception). Evidence: PY `test_bridge.py`.
- [ ] **V-P3-24** · §7 · Search the documents for the retired rules. → None of `SKILL.md`, `CONTEXT.md`, `README.md`, `curation-standard.md`, `automatic-workflow.md`, `organization-schema.md` says a card shows its text only when accepted, and each carries the new card rule. Evidence: NODE `faithful-cards-docs.test.mjs`; NODE `test_curation_standard.mjs` (the documentation-contract case reading `task-11-documentation-contract.json`, updated in lock-step with the documents).
- [ ] **V-P3-25** · §3.1 · Open the site with a data file in the old shape. → The page shows the recoverable load error (`知识数据文件格式损坏或不完整`) instead of a half-drawn grid. Evidence: the existing malformed-data test in `test_public_site.mjs`, updated for the new validator.

- [ ] **V-P3-26** · CARD-04 · Open the fixture card whose saved reply is damaged and whose post has only topic tags but a transcript. → The source box says `视频转写与画面文字` and its sentence starts `保存的点点回复缺了内容（是我们采集出错），下一轮重新获取；原帖只有话题标签`. Evidence: PW 6 (second half).
- [ ] **V-P3-27** · CARD-02 to CARD-06, §3.1 unreachable post · Rebuild from the real saved data (no browser, no platform contact) and read the four mockup notes and the totals. → `…0090ff` is a DianDian-reply card titled `一个人，3天，Codex，10W`; `…021e9e` shows the post's text with its reply marked damaged; `…0023f9` is a DianDian-reply card of kind `Tool` with its reply not damaged (its saved add-on lists no tools, so no `未核实` chip is expected on the real card); `…02d3de` shows a video transcript as its main text; 377 cards; exactly 3 flagged as unreachable. No card has an empty main text (a read-only simulation found 13 that would, before the cut-reply fallback of V-P3-28). A mismatch is reported with the printed numbers and is not tuned away. Evidence: RUN plan Task 10 Step 5a (counts, ids and field values only).
- [ ] **V-P3-28** · CARD-04 · Build a note whose saved reply is on the damaged list, whose post has only topic tags, and which has no usable transcript (plan D10; 13 real cards are in this state). → The card is not blank: the source box says `点点 AI 深度总结` with the sentence `保存的点点回复缺了内容（是我们采集出错），下一轮重新获取；` followed by `原帖只有话题标签、没有正文，所以先显示已保存的那部分点点回复。` (the last clause is new wording, `[needs user-approved copy]`, flagged to the owner), the main text is the saved reply, and the card is not counted in N of V-P0-02. Evidence: `card-content.test.mjs` (cut reply as the only text); builder test 18; PW 18.

## P4 — Mobile (390 × 844, the `mobile-chromium` project)

- [ ] **V-P4-01** · CARD-03 · Open card ① on the phone. → The dialog does not scroll sideways (`scrollWidth - clientWidth <= 0`). Evidence: PW 14 on `mobile-chromium`.
- [ ] **V-P4-02** · CARD-03 · Look at the source box on the phone. → The label and the `编辑` button stay inside the box, with the explanation on its own row below. `[mockup: rewrite § ①, narrow layout]` Evidence: PW 12 on `mobile-chromium`.
- [ ] **V-P4-03** · CARD-03 · Tap `展开全文 · <N> 字` on the phone. → The reply expands and the button reads `收起`; tapping again folds it. Evidence: PW 3 on `mobile-chromium`.
- [ ] **V-P4-04** · CARD-06 · Open the longest transcript card on the phone. → The transcript wraps inside the dialog without sideways scroll. `[mockup: rewrite § ④]` Evidence: PW 14 on `mobile-chromium`.
- [ ] **V-P4-05** · CARD-09 · Open the home page on the phone. → The counts line wraps and stays fully visible, the four proof numbers and their note stack without sideways scroll. Evidence: PW 11 on `mobile-chromium`.
- [ ] **V-P4-06** · CARD-05 · Open the formerly held card on the phone. → The `未核实` badge stays on the same chip as the tool name. `[mockup: rewrite § ③]` Evidence: PW 5 on `mobile-chromium`.
- [ ] **V-P4-07** · §3.1 · Check the footer controls on the phone. → The three controls are all reachable, none is cut off, and tap targets still meet the existing target-size test. `[mockup: summary-sources § ①]` Evidence: `design-target-size-regression.spec.mjs` on `mobile-chromium`.

## P5 — Accessibility

- [ ] **V-P5-01** · CARD-03 · Inspect the fold button. → It exposes `aria-expanded` that flips `false` to `true` on activation, and its text is the same as its visible label. Evidence: PW 3.
- [ ] **V-P5-02** · CARD-05 · Read a card with an unverified tool in the accessibility tree. → The words `未核实` are text inside the chip, not only a colour. Evidence: PW 5 (text content assertion).
- [ ] **V-P5-03** · CARD-06 · Read the extracted-text section. → It is a labelled section (`aria-label` equal to its heading) with an `h3`, below the `h2` title and above the footer. Evidence: PW 7.
- [ ] **V-P5-04** · CARD-03 · Tab through a detail view. → Focus reaches the edit button, the fold button and the three footer controls in reading order, each with a visible focus ring. `[mockup: summary-sources § ①]` Evidence: `design-keyboard-flow-regression.spec.mjs` and `design-focus-regression.spec.mjs` stay green.
- [ ] **V-P5-05** · CARD-03 · Press Escape in an open detail view. → The dialog closes and focus returns to the card that opened it. Evidence: the existing dialog tests in `test_public_site.mjs` and the Playwright specs.
- [ ] **V-P5-06** · CARD-01 · Run `npm.cmd run lint:a11y`. → Exit 0 on `site/app.js`, `site/local-bridge-utils.mjs`, `site/resource-utils.mjs`. Evidence: command exit code.
- [ ] **V-P5-07** · CARD-04 · Check text contrast of the source line and the extracted text in the light and dark themes. → The existing contrast regression (`design-text-legibility-regression.spec.mjs`) passes with the new elements on the page. Evidence: Playwright run of that spec.

## Final gates

- [ ] **V-GATE-01** · all · Run `npm.cmd run release:check` and `python -m unittest discover -s ".\skills\xhs-favorites-organizer\tests" -p "test_*.py"`. → Both exit 0.
- [ ] **V-GATE-02** · all · After publishing once from a frozen snapshot, compare the live cards for cases ① to ④ with `docs/designs/2026-10-14-card-design-rewrite.html`. → Structure, placement and behaviour match; styling follows the site's own tokens. Evidence: LIVE.

## Coverage

| Behaviour | Rows |
|---|---|
| CARD-01 | V-P0-01, V-P2-07, V-P5-06 |
| CARD-02 | V-P0-03, V-P3-06, V-P3-07, V-P3-27 |
| CARD-03 | V-P0-04, V-P0-05, V-P1-07, V-P2-01 to V-P2-04, V-P2-08, V-P4-01 to V-P4-03, V-P5-01, V-P5-04, V-P5-05 |
| CARD-04 | V-P0-07, V-P2-05, V-P3-01 to V-P3-05, V-P3-26, V-P3-28, V-P5-07 |
| CARD-05 | V-P0-06, V-P3-11, V-P3-12, V-P4-06, V-P5-02 |
| CARD-06 | V-P0-08, V-P2-06, V-P3-08, V-P3-10, V-P4-04, V-P5-03 |
| CARD-07 | V-P0-09, V-P3-09, V-P3-18 |
| CARD-08 | V-P0-10, V-P3-17 |
| CARD-09 | V-P0-02, V-P4-05 |
| AC-NOGATE | V-P0-12, V-P1-01, V-P1-02, V-P3-19, V-P3-20 |
| AC-ADDON | V-P1-04, V-P2-10 |
| AC-PARA | V-P3-14 to V-P3-16 |
| Sections with no behaviour ID (§3.1 post button, §7 removal and archiving, §8 boundaries) | V-P0-11, V-P1-03, V-P1-05, V-P1-06, V-P1-08, V-P2-09, V-P3-13, V-P3-21 to V-P3-25, V-P3-27, V-P4-07 |
