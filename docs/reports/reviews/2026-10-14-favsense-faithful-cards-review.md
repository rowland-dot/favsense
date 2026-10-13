# FavSense faithful cards — pre-landing review (Step 5, Phase 1, pass 1)

- Branch: `feat/faithful-cards` against `main` (merge base `c42ed2f`), reviewed at `ce6d185`, fixed to `f93455f`
- Governing spec: `docs/specs/2026-10-14-favsense-faithful-cards-spec.md`, Slice A only
- Principle (from `CLAUDE.md`): "核心运行链路必须保持 Agent 无关。Claude 只能作为可选策展层编辑结构化 curation JSON，然后运行同一构建器"

## Result

CRITICAL=0 HIGH=0 MEDIUM=1 LOW=3

One HIGH was found and fixed in place (Fix-First). Nothing CRITICAL. The card path obeys the principle: `card-content.mjs` builds title and main text from the catalog record, the saved reply, the frozen damaged list and extracted text only; `judgePublicNote` reads the add-on for kind, category, topics and tools and nothing else; no review state or run record reaches a card (`build-public-site.mjs:135-173`).

Scope check: CLEAN. Intent (spec §3, §5.2, §6.3, §7, frozen damaged list, document updates) matches the diff; Slice B items (capture fix, re-fetch, live link test, reader-engine trigger) are absent from code and recorded in `TODOS.md`.

## Findings

### HIGH — fixed (`f93455f`)

**H1. The first damage sign missed list items glued after a sentence end, so two cut replies were shown as complete DianDian summaries.** (confidence 9/10)
`skills/xhs-favorites-organizer/scripts/damaged-replies.mjs:13` was

```js
const JOINED_LIST_ITEM = /[，,；;：:、][ \t]*[-•·][ \t]+\S/;
```

Saved reply `…03cc55` reads "…普通人写愿望，高手写规格。- 用途：…" and "画面如何组织？- 色彩：…"; saved reply `…038601` reads "三个关键点记录：…为什么会停下来看——第一眼在看什么 / 案例拆解 / …的卖点。- 厨房置物架案例：…" (one of the three points survives). Both are the spec's sign "text lost where list items join" (§4), but the marker follows 。 or ？, which the rule did not list. Effect on the live cards: both counted in "条有完整点点总结", and `…03cc55` still showed DianDian's opening chat line, because the opener shares a line with the first list item and `stripDiandianOpener` only removes an opener that stands as its own paragraph (the approved #99 display removes it).

Fix: the sign now also covers 。？！?! before a glued marker; a new test in `tests/damaged-replies.test.mjs` uses the real reply shapes (RED before, GREEN after; a marker on the next line is still not a sign). The frozen list was regenerated with the same command (old copy kept at `.xhs-favorites/archive-2026-10-14/damaged-diandian-replies.79-before-review.json`): 79 → 81, exactly `…038601` and `…03cc55` added, none removed. Site data was rebuilt through the production snapshot path (batch `faithfulcardsreview20261014103815`, no publish); compared with the previous data only those two cards and `meta.replyCount` (196 → 194) changed; 81 cards are `replyDamaged` = 81 list entries, 3 unreachable, 0 empty. `…03cc55` now shows "原帖公开文字" with the damaged-capture explanation (CARD-04); `…038601` has a tags-only post, so it keeps the saved reply under the damaged explanation (plan D10). `test:site` 149/149, `test:knowledge` 112/112, `test:curation` 222/222 pass on the fixed tree.

Note for the brief: the plan's D1 rule (comma, semicolon, colon, 、) was widened here to match the spec's own sign; the count is 81, not tuned toward any target.

### MEDIUM — logged

**M1. Plain hashtags without the `[话题]` suffix stay in the title fallback and in the post text.** (confidence 8/10)
`card-content.mjs:12-13` removes only `#…[话题]#` and `[…话题…]` forms. Note `…03d0c8` has no post title, so its card title is the first line with tags left in: "一人自媒体公司全流程（内容创作、分发、互动、变现）打通的开源项目 #开源项目 #自媒体 #开发者 #一…". The old builder cut at the first `#`. Spec §3.1 says the fallback title is the first line "with topic tags removed" (CARD-02). Three post-text cards also end with plain `#标签` runs. Not fixed: removing every `#word` would also hit text such as "C#" or "#1"; the rule for what counts as a plain topic tag needs a decision. Suggested: strip a trailing run of whitespace-separated `#word` tokens at the end of a line.

### LOW — logged

**L1.** `public-judgement.mjs:73` starts its comment with `///` (typo). (confidence 10/10)

**L2.** Transcripts and picture text are shown as one block: `evidenceText` flattens whitespace (`evidence-files.mjs:640`, `clean(record.text)`) because the stored hash is over the flattened text. Known and stated in the plan's risk list (6). (confidence 9/10)

**L3.** The full post text and transcripts are now public (before: a 240-character excerpt). Spec §3.1 requires it and the builder's safety scan still refuses tokens and private identifiers; third-party contact details are only counted (Task 10 Step 6), never blocked. Plan risk (2). (confidence 7/10)

## Checked and fine

- No review state reaches a card: `cardText`/`cardTitle` take no curation input; AC-NOGATE builder test present (`faithful-cards-builder.test.mjs`).
- Damaged-list fail-closed path: the snapshot refuses to build when replies exist and no list is frozen (`build-organization-snapshot.mjs:589-592`); the bridge passes the list only when it is a plain file (`bridge-server.py:6644-6648`).
- Evidence reads stay inside their root: shared `containedEvidenceFile`/`readContainedText` moved unchanged into `evidence-files.mjs`; note IDs used for media paths are filtered to 24-hex in the snapshot.
- Front end escapes every inserted value (`formatPostHtml`, `toolChip`, `extractedSectionHtml` all go through `escapeHtml`); the data validator requires the new fields.
- Removed flags (`--diandian-report`, `--diandian-prompt-version`, packet binding) have no remaining caller in `scripts/` (grep).

## Not run

The gstack Review Army specialists and the Codex adversarial pass were not dispatched in this pass; findings above come from a direct read of the production diff, the spec, and checks run against the real built data.

<!-- pipeline:json
{"schema_version":1,"skill":"review","step":5,"phase":"phase-1","severity":{"CRITICAL":0,"HIGH":0,"MEDIUM":1,"LOW":3},"completeness":7,"confidence":8,"findings":[{"severity":"HIGH","status":"fixed","commit":"f93455f","summary":"Damage sign missed list items glued after 。？！; two cut replies shown as complete DianDian summaries, one still showing the chat opener (…03cc55)"},{"severity":"MEDIUM","status":"open","summary":"Plain #hashtags without [话题] stay in the fallback title (…03d0c8) and in three post texts"},{"severity":"LOW","status":"open","summary":"public-judgement.mjs:73 comment starts with ///"},{"severity":"LOW","status":"open","summary":"Extracted text shown as one block because evidenceText flattens whitespace"},{"severity":"LOW","status":"open","summary":"Full post text and transcripts now public; contact details counted, not blocked (spec-approved)"}]}
-->
