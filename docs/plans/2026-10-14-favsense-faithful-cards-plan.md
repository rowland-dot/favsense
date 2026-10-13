# FavSense Faithful Cards — Slice A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every saved note becomes one faithful card made by a deterministic step that needs no model, and the acceptance gate stops controlling what a card shows.

**Architecture:** A new pure module (`card-content.mjs`) decides title, main text, source and extracted-text section from the catalog record, the saved DianDian reply, the text taken out of the post's media, and a frozen "damaged replies" list. The public builder calls it instead of the acceptance-gated judgement; the optional add-on (curation entry or sealed candidate) only supplies topics, tools, category suggestion and content kind. The front end drops every status-banner branch and draws one source line from the new data fields.

**Tech Stack:** Node 20 (`node:test`), vanilla browser JS in `site/`, Python 3.12 (`unittest`), Playwright (`playwright.config.mjs` starts `scripts/serve-qa-fixture.mjs` on 127.0.0.1:8766).

**Governing sources (read them; this plan does not restate them):**
- Spec (APPROVED): `docs/specs/2026-10-14-favsense-faithful-cards-spec.md` — §0 and §8 are the boundaries.
- Mockups, authoritative for structure, placement and behaviour: `docs/designs/2026-10-14-card-design-rewrite.html` (cases ①–④) and `docs/designs/2026-10-14-card-summary-sources.html` (fold, source box, footer).
- Invariants: `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `skills/xhs-favorites-organizer/SKILL.md`.
- Verification checklist derived from this plan: `docs/specs/2026-10-14-favsense-faithful-cards-verification-checklist.md`.

**Scope of this plan:** Slice A only (spec §9): §3 card, §5.2 add-on, §6.3 counts, §7 removal and archiving, the frozen damaged-reply list, document updates, and CAP-06/AC-PARA only as far as the offline detail-cleanup change. No Xiaohongshu contact anywhere in it. Slice B items are listed at the end, not planned.

**Conventions for every task**
- Branch `feat/faithful-cards` (already cut; spec committed as `1a9ef29`). One commit per task, conventional message, ending with the attribution trailer the session specifies.
- Windows PowerShell: use `npm.cmd` / `npx.cmd`. The `node --test <files>` and `python -m unittest ...` forms below work in every shell.
- New Node test files must be added to a list in `package.json` (`scripts/check-test-script-paths.mjs` only checks that listed files exist, but an unlisted test never runs in `npm test`). Each task adds its own file to the list as it creates it; Task 10 Step 8's full gate is the proof that none was forgotten. New Python tests are named `test_*.py` and are found by `unittest discover`.
- Test fixtures never share a mutable default object between tests (task-observer note 0025): helpers build a fresh object per call.
- Tests use synthetic inputs or a copy. Nothing in a test reads `.xhs-favorites/`. The real-data steps are labelled **RUN STEP** and are done by the run, never by a test, and never committed (private folder).

---

## Decisions this plan makes (the review brief lists them for the owner)

| # | Gap or choice | Decision | Why |
|---|---|---|---|
| D1 | Spec gap 1: exact rule for the "about 71" damaged replies | Implement exactly the two signs the spec names, over replies the saved-reply loader accepts (a refusal is not a summary and is already rejected). Sign 1: a list-item marker (`-`, `•`, `·`) glued after a comma, semicolon, colon or `、` on the same line. Sign 2: after ignoring trailing hashtag-only lines, the last line ends in `，` `,` `：` `:`, or is a bare heading (short, no sentence punctuation). The RUN STEP prints the count and every ID; the rule is **not** tuned to reach 71. A read-only probe by the planner on 2026-10-14, before the refusal filter, flagged 29 replies by sign 1 and 56 by sign 2 (81 together, 4 on both); the real run will print its own numbers. **Entry-by-entry check (spec §4: the list is "checked entry by entry at plan review"), done at audit pass 3 on 2026-10-14 over the 275 saved replies the loader accepts, with the Task 4 rule as written:** 79 are flagged (28 by sign 1, 50 by the comma/colon ending, 5 by the bare heading; 4 carry two signs). The tail of every one was read: 77 are plainly cut (a list item glued after a comma, or the text stops on a comma or on a heading with nothing under it). Two are doubtful and stay on the list because the rule is not tuned: `…01e252` ends on the heading `标签` followed by a hashtag-only line (the hashtags are ignored by sign 2, so the heading looks empty; the reply is probably complete) and `…03930b` ends on two short bare lines (`RAG 医疗问答`, `Agent 智能客服`; could be a finished list). If either is complete, its card shows the post's own text, or the saved reply itself where the post has none (D10), until the next fetch, and its source line wrongly blames our capture; the run lists both IDs in the review brief for the owner. The spec's "about 71" was an estimate (its own §1 marks the 52 cut-off replies as *estimated*); the two signs as written give 79, and the plan reports that number rather than adjusting the signs towards 71. | Spec §4 last paragraph, owner ruling "Only the ~71 damaged". |
| D2 | Spec gap 2: where the add-on lives | Reuse existing data. The add-on for a note is its entry in the curation file (`skills/xhs-favorites-organizer/references/skills-board-curation.json`, fields `themes`, `tools`, `category`, `kind`, `category_override`), else its sealed candidate (the builder already receives these as `--candidates`; this is where the 31 formerly held cards keep their tools). Both are plain JSON read without the acceptance gate, so no new file is invented. | Spec §5.2; the files exist and are readable without the gate. |
| D3 | The 3 unreachable posts | The only record that a post is unreachable is the review audit file (`.xhs-favorites/curation-audit.json`, `status: "unavailable"` for exactly 3 notes; checked 2026-10-14: those 3 ids appear in neither the curation file, nor the sealed candidates, nor the newest curation bundle, so no add-on carries the flag). The builder therefore reads **only that one fact** from the audit file named in `config.curation_quality.audit_file` (new `loadUnreachableNoteIds` in `curation-quality.mjs`; no audit file configured or on disk means an empty set), and an add-on whose `review_status` is `"unavailable"` counts too. The fact only picks the source-line label `已完成（原帖不可访问）`; it never hides or changes title or main text, and every other audit field (accepted, rejected, hashes, baselines) is no longer read. The snapshot freezes the audit file as an optional input so the label is part of the build version (Task 7). | Spec §3.1 last paragraph keeps that label. Without a data source the label would silently vanish and the Task 10 Step 5a check (expected 3) would stop the overnight run. |
| D4 | Reply and transcript binding | A DianDian reply is read without matching the prompt version or the post's content hash; transcripts and image text are read with their own integrity check (text hash) but without matching the post's content hash. Known limit, same as the review path today: the integrity check hashes the text after whitespace is flattened and needs `schema_version`, `method` and `result_sha256`. Measured on the real folder, 2026-10-14: of 252 finished transcript and picture-text files, 211 pass; the 41 that do not are early-format transcripts (no `schema_version`, `method` or `result_sha256`), which Task 8 Step 3 also stops trusting as evidence. Those hidden transcripts do matter for cards whose reply is damaged and whose post is only topic tags: a simulation at audit pass 3 found 13 such cards, which D10 now covers by showing the saved reply; Task 10 Step 5a prints the real empty-text count and expects 0. | Prompt-version and content binding are gate inputs; the post's description will change when CAP-06 restores paragraphs, and that must not make transcripts disappear. |
| D5 | When the extracted-text section shows | Only when no DianDian reply exists (absent or refused). Not for complete replies, not for damaged replies awaiting re-fetch. | Spec §5.1: the reader engine runs only for notes DianDian did not give; CARD-07. |
| D6 | Source-line copy where the mockups have none | Composed only from phrases the mockups already approved. Damaged: the exact sentence in spec CARD-04. Reply absent with post text: `这篇没有点点总结；先显示原帖自己的文字。` Video transcript as main text: `这篇没有点点总结；原帖只有话题标签、没有正文，所以这里是视频里说的话和画面上的字，未经 AI 改写。` Image text as main text: the same sentence ending `所以这里是图片上的字，未经 AI 改写。` When a damaged reply exists and the extracted text is the main text, the opening `这篇没有点点总结；` is replaced by the first clause of the CARD-04 sentence, `保存的点点回复缺了内容（是我们采集出错），下一轮重新获取；`. Slice B replaces the "没有点点总结" opening with the mockup's "点点 3 次都没拿到总结" once the 3-attempt record exists. **Saved reply shown because nothing else exists (D10):** source label `点点 AI 深度总结`, explanation = that same damaged opening + `原帖只有话题标签、没有正文，所以先显示已保存的那部分点点回复。` Only the last clause (`所以先显示已保存的那部分点点回复`) is new wording; it is listed in the review brief as `[needs user-approved copy]`, chosen over a card with no text at all (13 real cards, D10). | The grounding rule forbids inventing copy; these are lifted fragments, except the one clause named above. |
| D7 | Home counts (CARD-09) | `N 条有完整点点总结` = cards whose main text is a complete DianDian reply (a saved reply shown only because nothing else exists, D10, is not complete and is not counted). `M 条有视频转写` = cards that actually show a video transcript (as main text or as the extra section). Both counts are computed from the cards, so the number matches what the reader can find. | Counts follow what is visible (bug-fix discipline, rule 1). |
| D8 | Tool "未核实" | A tool name is verified when it matches a resource in the registry that has at least one official action link. For a Skill candidate it is verified only when the match is the single confirmed Skill resource. Everything else shows `未核实`. | Spec §3.1 / §5.2. |
| D9 | Local "pending evidence overlay" in `app.js` | Removed with the status fields it keys on. The bridge endpoint and `validateLocalNoteOrganizationStatus` stay for now and are recorded as a follow-up in `TODOS.md` (Task 10). | Its premise (a card waits for review before its text shows) no longer exists; deleting the endpoint is outside the spec's list. |
| D10 | Card with no post text and no extracted text | Order for a damaged reply: the post's text; else the extracted text; **else the saved (cut) reply itself**, marked `replyDamaged`, with the D6 explanation. Only a note with no post text, no extracted text and no saved reply at all renders no text section (no new wording). Measured on the real data at audit pass 3 (2026-10-14, a read-only simulation of the Task 3 rules over the catalog, replies and transcripts): without this last step **13 of the 377 cards** would show no text at all, because their reply is on the damaged list, their post is only topic tags, and they have no transcript that passes the integrity check (6 have none, 6 have only an early-format one, 1 has an empty post). Audit pass 2's finding that no card would be left empty did not count damaged replies. | Spec §3.1 and CARD-01 ("all 377 cards appear") and the owner's ruling that a missing piece of a reply is our capture's fault, not a reason to show nothing. The one new clause of copy is flagged in D6. |
| D12 | Task 1 pulls the offline half of CAP-06 into Slice A | The spec files CAP-06 under §4 (Slice B). The brief for this run asks for the offline detail-cleanup change in `fetch-xhs-details.py` and AC-PARA now; existing notes only regain paragraphs when their details are next fetched (Slice B, platform contact). | Run brief, scope bound. |
| D11 | Two data commits | Task 6 commits a rebuilt `site/data/knowledge.json` (direct builder run, offline) so tests that read the committed file stay green; Task 10 rebuilds it again through the production snapshot path. | Keeps every commit green. |
| D13 | Spec §7 lists "the rule that media download and transcription skip curated notes, and the switch that undoes it" as removed in Slice A | **Not done in this plan.** The rule (`transcribe-pending-videos.py`, `extract-pending-frames.py`, `run-video-analysis.ps1 -IncludeCurated`, `media_urls_to_cache` in `bridge-server.py`) and the tests and documents that describe it stay exactly as they are; the removal moves to the Slice B list, tied to §5.1's trigger (reader engine runs only for notes recorded "点点未取得"). | Owner ruling in spec §2 (video and image evidence: "Only when needed") and §5.1: with the rule gone and the trigger not yet built, the next owner-started sync would queue downloads for every previously curated note. The orchestrator ruled on this at plan audit (pass 1); spec §7's line is therefore deferred, not dropped. |

**Risks to put in the brief:** (1) The rule that media download and transcription skip curated notes is **kept unchanged** in this plan (D13): removing it would make the owner's next sync queue downloads for every previously curated note, against his ruling "Only when needed" (spec §2) and §5.1. Its removal is Slice B, tied to §5.1's trigger. (2) The full post text and the extracted transcripts become public in `knowledge.json` (before: a 240-character excerpt). Spec §3.1 requires it; the safety scan in the builder still refuses tokens and private identifiers. (3) With the "saved after review" exception removed, the next real review run may send some accepted notes back to review; cards are unaffected (AC-NOGATE).

---

## Existing tests that encode the old rule

Spec §9: they are rewritten with the spec, never kept by working around them. Rule applied in every task: a test whose subject is **removed** is deleted; a test whose subject **survives** is updated to the new argument or data shape; nothing is skipped or marked `.todo()`.

Paths in the first column that start with `tests/` or `test-fixtures/` are under `skills/xhs-favorites-organizer/`; paths starting with `site/` or `scripts/` are at the repository root.

| File | What happens |
|---|---|
| `tests/public-judgement.test.mjs`, `tests/public-judgement-builders.test.mjs`, `tests/public-judgement-fixtures.mjs` | Rewritten in Task 6 around the new `judgePublicNote` (kind, category, resources, tools, unverified tools, unreachable flag). Reviewed-title, search-text-from-title and Skill-freshness tests that still describe real behaviour move into `faithful-cards-builder.test.mjs`. Gate-only helpers (`acceptedSkill`, `pointFile`) are deleted from the fixtures file. |
| `tests/test_formal_outputs.mjs`, `tests/reviewed-evidence-only-rebuild.test.mjs` | **Task 6 owns both** (both are in `test:knowledge`, which Task 6 Step 7 runs; one imports the deleted `formalCurationDecision`, the other asserts the old card fields). `test_formal_outputs`: the case "accepted confirmed Skill produces the safe formal outcome in the public JSON" (line ~16) is kept in a new form (confirmed Skill gives `kind "Skill"`, `resourceIds`, `mainSource "diandian"`, `mainText` equal to the saved reply) with its stale-resource and baseline sub-cases (lines ~125–143) removed; "explicit rejected audit overrides a matching baseline" (~153) and "unverified Skill stays a pending candidate…" (~241) are deleted, their subjects are gone (the neutral-kind behaviour is covered by builder test 5). `reviewed-evidence-only-rebuild`: the three `formalCurationDecision` cases (lines ~18–41) and "a not-accepted note shows the sealed candidate's reason…" (~112) are deleted; "the snapshot freezes the sealed candidates of notes that are not accepted…" (~156) stays and Task 7 updates it. |
| `tests/verification-max-age.test.mjs` | Task 6. It imports `acceptedSkill` (deleted from the fixtures) and calls the old `judgePublicNote` shape. Replace the import by `config, note` from the fixtures file and rewrite the `judge(limit, verifiedAt)` helper (line ~69) as `const resource = skillResource({ verified_at: verifiedAt }); return judgePublicNote({ noteId: "n1", note: note(), addOn: { category: "Synthetic", themes: ["testing"], tools: [resource.name], kind: "Skill" }, resourceRegistry: { verified_at: TODAY, resources: [resource] }, config, profile: withLimit(limit), effectiveDate: TODAY });`. The case at line ~91 asserts `judge(30).kind === "Skill"` and, for `judge(1)`, `kind !== "Skill"` with empty `resourceIds` (the check four days old is stale at 1; `accepted` and `reasonCode` no longer exist). The broken-limit cases keep their assertions. The case at line ~111 passes `addOn: { category: "Synthetic", themes: ["testing"], tools: [], kind: "Note" }`, `resourceRegistry: { resources: [] }`, `config`, `effectiveDate: TODAY` and still expects `RESOURCE_MAX_AGE_INVALID`. Every other case in the file (resolver, pipeline, merge, merge command line) is unchanged. |
| `tests/test_public_site.mjs` | Split by owner so every commit stays green. **Task 5** owns the tests that run `app.js` or its validator: lines near 147 (accepted cards display the formal summary), 624 (rejection not rendered as waiting), 707 (provenance and DianDian structure) and the "knowledge payload failures" / malformed-document cases. **Task 6** owns every test that reads the builder or the committed `site/data/knowledge.json`: lines near 505–560 (data shape, `evidence`, missing titles), 564 (curation revision), 580 and 592 (deep summaries), 643 (run-report states), 1299–1359 (DianDian private until acceptance, baseline grandfathering) and the data readers near 1948, 1975 and 2003. The loader-integrity tests near 1374–1433 stay in Task 6, but their assertions move to the new fields: they currently assert on `deepSummarySource` and `deepSummary`, which no longer exist, so `notEqual(undefined, "xiaohongshu-diandian")` would pass without testing anything and `doesNotMatch(mismatched.notes[0].deepSummary, …)` (line ~1386) would throw. Each becomes `mainSource !== "diandian"` (and `mainText` not matching the rejected text) for the wrong-note, credential-shaped and encoded-token records; the `JSON.stringify(data)` assertions stay as they are. The cases at 1299–1359 whose premise is acceptance or the prompt version are deleted (D4); the data reader that checks `data.meta.videoMethod` (line ~2010) asserts `meta.replyCount`/`meta.transcriptCount` instead. Line numbers are as found on 2026-10-14. |
| `site/e2e/organization-recovery.spec.mjs`, `site/e2e/design-text-legibility-regression.spec.mjs` | Task 5. In `organization-recovery`: the three note-recovery banner cases (`summary-failed`, `batch-aborted`, `stale`, near lines 85–96), "local note detail shows captured summary as pending review" and "public origin never mounts or requests the private pending overlay" (near 149–170) are deleted with the banners and the overlay. In `design-text-legibility`: the `kind === "manager" && id === "note-pending"` overlay expectation (line 79) is deleted. The run-panel cases of both files stay. |
| `tests/test_curation_standard.mjs` (imports at lines 12–17), `tests/stable-curation-rebuild.test.mjs` (lines ~107–120), `tests/test_organization_contracts.mjs` (lines ~68–95) | Task 6. They import or call `formalCurationDecision`, `isPublishableCuration`, `publicEvidenceStatus`, `loadCurationAudit` or `hasCompleteAcceptedAudit`, which Task 6 deletes. Remove those imports and the cases whose only subject is the publish decision ("formal output decision binds acceptance…", the `resource_stale` / `audit_pending` reason-code cases); keep the cases about `acceptedRevisionsCurrent`, audits, merge and prepare. Finish with `grep -rn "formalCurationDecision\|isPublishableCuration\|publicEvidenceStatus\|loadCurationAudit\|hasCompleteAcceptedAudit" skills scripts site` returning nothing. |
| `tests/diandian-summary-display.test.mjs` | Reads `mainText` of cards whose `mainSource` is `diandian` instead of `deepSummary` (Task 6). |
| `tests/accepted-text-quality.test.mjs` | Task 6. It imports `hasCompleteAcceptedAudit` (line 4), which Task 6 deletes. The last case ("the publish decision refuses the same entries", line ~159) is deleted; in the case "an accepted entry with no action passes, and is published" (line ~146) the `hasCompleteAcceptedAudit` assertion (line ~150) is removed and the case is renamed "an accepted entry with no action passes the standard"; the validate-curation rules stay. Then the import is removed. |
| `tests/test_curation_standard.mjs` (SKILL.md example case, lines ~40–58) | Task 9, together with the documents: the case asserts `不要直接运行缺少该值的底层 builder` and that the `build-public-site.mjs` example carries `--diandian-prompt-version $promptVersion`; both statements are retired (Task 6 makes the builder ignore the prompt version), so the assertions become "the sentence and the flag are absent". |
| `tests/test_curation_standard.mjs`, `tests/test_organization_snapshot.mjs`, `tests/test_final_build.py`, `tests/test_no_direct_rebuild.py`, `tests/test_bridge.py` | Packet-hash, prompt-version, report-argument and audit/baseline-capture cases (`test_organization_snapshot.mjs` lines ~292 and ~328 pass `publish_only_accepted`) deleted or updated in Tasks 7 and 8. |
| `tests/test_review_include_curated.py`, `test-fixtures/include-curated-review/`, and the "curated" skip cases in `tests/test_transcription_pipeline.py`, `tests/test_media_queue.py`, `tests/test_frame_extraction.py`, `tests/test_bridge.py` (`test_media_queue_skips_curated_and_cached_notes`) | **Stay unchanged** (D13): the curated-skip rule and the `-IncludeCurated` switch are kept in this plan. |
| `site/e2e/card-summary-sources.spec.mjs`, `scripts/fixtures/card-summary-sources.json` | Replaced in Task 5 by `faithful-cards.spec.mjs` and `faithful-cards.json`. |
| `skills/xhs-favorites-organizer/test-fixtures/task-11-documentation-contract.json` and any test that reads it | Updated in Task 9 together with the documents it quotes. |

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `skills/xhs-favorites-organizer/scripts/fetch-xhs-details.py` | modify | Keep line breaks in the post description (Task 1) |
| `skills/xhs-favorites-organizer/tests/test_post_text_paragraphs.py` | create | AC-PARA |
| `skills/xhs-favorites-organizer/scripts/evidence-files.mjs` | create (moved code) | Safe reading of per-note evidence files; used by review and by cards |
| `skills/xhs-favorites-organizer/scripts/extracted-text.mjs` | create | Transcript and image text as extracted |
| `skills/xhs-favorites-organizer/scripts/card-content.mjs` | create | Title, post body, reply state, main text, counts |
| `skills/xhs-favorites-organizer/scripts/damaged-replies.mjs` | create | The two damage signs, the frozen list, its loader |
| `site/diandian-text.mjs` | modify | Export `isBareLine` |
| `skills/xhs-favorites-organizer/scripts/public-judgement.mjs` | rewrite | Kind, category, resources, tools; no acceptance |
| `skills/xhs-favorites-organizer/scripts/curation-quality.mjs` | trim | Drop the publish decision pieces |
| `skills/xhs-favorites-organizer/scripts/build-public-site.mjs` | rewrite per-note block | New public card data |
| `skills/xhs-favorites-organizer/scripts/build-organization-snapshot.mjs` | modify | Freeze new inputs, drop old ones, builder version 8 |
| `skills/xhs-favorites-organizer/scripts/bridge-server.py` | modify | Snapshot arguments; curation-layer exceptions (the curated-skip in `media_urls_to_cache` is kept, D13) |
| `skills/xhs-favorites-organizer/scripts/{merge-curation-results,prepare-curation-review,curation-revision}.mjs` | trim | Packet hash binding, prompt version input |
| `site/app.js`, `site/index.html`, `site/styles.css` | modify | Source line, extracted section, tool badge, counts, banner removal |
| `scripts/serve-qa-fixture.mjs`, `scripts/fixtures/faithful-cards.json` | modify / create | Browser-test data |
| `site/e2e/faithful-cards.spec.mjs` | create | AC-CARD |
| `config/xhs-favorites.example.json` | modify | Drop `publish_only_accepted`, `baseline_file` |
| documents named in Task 9 | modify | One rule, no contradictions |

---

### Task 1: The detail cleanup keeps the post's line breaks (CAP-06 offline, AC-PARA)

**Files:**
- Modify: `skills/xhs-favorites-organizer/scripts/fetch-xhs-details.py` (`clean_text` at line 141, `normalize` at line 219)
- Create: `skills/xhs-favorites-organizer/tests/test_post_text_paragraphs.py`

- [ ] **Step 1: Write the failing test**

```python
"""AC-PARA: the detail cleanup keeps the post's line breaks (spec CAP-06)."""

import importlib.util
from pathlib import Path
import unittest

SCRIPTS = Path(__file__).parents[1] / "scripts"
NOTE_ID = "a" * 24


def load_fetcher():
    spec = importlib.util.spec_from_file_location("xhs_fetcher_paragraphs", SCRIPTS / "fetch-xhs-details.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


FETCHER = load_fetcher()


def description_of(raw_text):
    return FETCHER.normalize({"作品描述": raw_text}, NOTE_ID)["description"]


class PostTextParagraphs(unittest.TestCase):
    def test_paragraph_breaks_survive_and_spaces_are_tidied_per_line(self):
        self.assertEqual(description_of("第一段  有空格\n\n第二段\n第三行"), "第一段 有空格\n\n第二段\n第三行")

    def test_windows_and_old_mac_line_endings_become_newlines(self):
        self.assertEqual(description_of("甲\r\n乙\r丙"), "甲\n乙\n丙")

    def test_three_or_more_newlines_become_one_blank_line(self):
        self.assertEqual(description_of("甲\n\n\n\n乙"), "甲\n\n乙")

    def test_leading_and_trailing_blank_lines_are_dropped(self):
        self.assertEqual(description_of("\n\n甲\n乙\n\n"), "甲\n乙")

    def test_an_empty_description_stays_none(self):
        self.assertIsNone(description_of("  \n \n"))

    def test_the_twenty_thousand_character_limit_still_applies(self):
        self.assertEqual(len(description_of("字" * 25_000)), 20_000)

    def test_the_title_and_other_single_line_fields_stay_on_one_line(self):
        result = FETCHER.normalize({"作品标题": "标题\n 第二行", "作者昵称": "作者\n名"}, NOTE_ID)
        self.assertEqual(result["title"], "标题 第二行")
        self.assertEqual(result["author"], "作者 名")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it and see it fail**

Run: `python -m unittest discover -s skills/xhs-favorites-organizer/tests -p "test_post_text_paragraphs.py"`
Expected: FAIL — the first test gets `"第一段 有空格 第二段 第三行"`.

- [ ] **Step 3: Minimal implementation**

Add next to `clean_text` and change one line in `normalize` (leave `clean_text` for every other field):

```python
def clean_paragraphs(value, max_chars: int = 20_000):
    """Like clean_text, but keeps the post's line breaks: spaces are tidied line by line and a run of
    three or more newlines becomes one blank line."""
    if value is None:
        return None
    lines = [" ".join(line.split()) for line in str(value).replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    return text[:max_chars] or None
```

In `normalize`: `"description": clean_paragraphs(raw.get("作品描述"), 20_000),`.

- [ ] **Step 4: Run the new test and the neighbours that load the same file**

Run: `python -m unittest discover -s skills/xhs-favorites-organizer/tests -p "test_post_text_paragraphs.py"` then `python -m unittest discover -s skills/xhs-favorites-organizer/tests -p "test_safety_stop_sources.py"` then `python -m unittest discover -s skills/xhs-favorites-organizer/tests -p "test_import_result_shape.py"`
Expected: PASS. (The content hash collapses whitespace in `scripts/content-revision.mjs`, so restoring paragraphs does not change any note's `content_sha256`.)

- [ ] **Step 5: Commit**

```bash
git add skills/xhs-favorites-organizer/scripts/fetch-xhs-details.py skills/xhs-favorites-organizer/tests/test_post_text_paragraphs.py
git commit -m "fix: keep the post's line breaks when saving note details (AC-PARA)"
```

---

### Task 2: One safe reader for per-note evidence files, and the extracted-text loader

**Files:**
- Create: `skills/xhs-favorites-organizer/scripts/evidence-files.mjs`
- Create: `skills/xhs-favorites-organizer/scripts/extracted-text.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/prepare-curation-review.mjs` (import instead of defining)
- Create: `skills/xhs-favorites-organizer/tests/extracted-text.test.mjs`
- Modify: `package.json` (`test:knowledge` gains `skills/xhs-favorites-organizer/tests/extracted-text.test.mjs`)

- [ ] **Step 1: Baseline for the refactor**

Run: `node --test skills/xhs-favorites-organizer/tests/test_curation_standard.mjs`
Expected: PASS (this is the guard for the move in Step 3).

- [ ] **Step 2: Write the failing test** (`extracted-text.test.mjs`)

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtractedText } from "../scripts/extracted-text.mjs";

const NOTE = "6a2a81d1000000001702d3de";
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const evidence = (text, method, status, overrides = {}) => ({
  schema_version: 1, status, method, content_sha256: "c".repeat(64), provider: "local", tool_version: "1",
  text, result_sha256: sha(text), ...overrides,
});
const transcript = (text, overrides) => evidence(text, "local_transcription", "transcribed", overrides);
const imageText = (text, overrides) => evidence(text, "local_image_ocr", "extracted", overrides);

async function withRoot(files, run) {
  const root = await mkdtemp(join(tmpdir(), "favsense-extracted-"));
  try {
    await mkdir(join(root, NOTE), { recursive: true });
    for (const [name, value] of Object.entries(files)) await writeFile(join(root, NOTE, name), JSON.stringify(value));
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a video's transcript is returned as video-transcript text", async () => {
  await withRoot({ "transcription.json": transcript("记住这个项目") }, async (root) => {
    assert.deepEqual(loadExtractedText(root, NOTE, "视频"), { kind: "video-transcript", text: "记住这个项目" });
  });
});

test("a video's transcript and its on-screen text are returned together, transcript first", async () => {
  await withRoot({ "transcription.json": transcript("口播"), "visual-ocr.json": imageText("画面字") }, async (root) => {
    assert.deepEqual(loadExtractedText(root, NOTE, "视频"), { kind: "video-transcript", text: "口播\n\n画面字" });
  });
});

test("an image post's picture text is returned as image-text and a stray transcript is ignored", async () => {
  await withRoot({ "visual-ocr.json": imageText("图里的字"), "transcription.json": transcript("不该出现") }, async (root) => {
    assert.deepEqual(loadExtractedText(root, NOTE, "图文"), { kind: "image-text", text: "图里的字" });
  });
});

test("the post's own content hash is not matched, so restored paragraphs cannot hide a transcript", async () => {
  await withRoot({ "transcription.json": transcript("口播", { content_sha256: "d".repeat(64) }) }, async (root) => {
    assert.equal(loadExtractedText(root, NOTE, "视频").text, "口播");
  });
});

test("a record whose text does not match its own hash is not used", async () => {
  await withRoot({ "transcription.json": transcript("口播", { result_sha256: "e".repeat(64) }) }, async (root) => {
    assert.equal(loadExtractedText(root, NOTE, "视频"), null);
  });
});

test("a record with the wrong method or status is not used", async () => {
  await withRoot({ "transcription.json": transcript("口播", { status: "partial" }) }, async (root) => {
    assert.equal(loadExtractedText(root, NOTE, "视频"), null);
  });
});

test("no folder, no files, or an image post without picture text give null", async () => {
  assert.equal(loadExtractedText(join(tmpdir(), "favsense-no-such-root"), NOTE, "视频"), null);
  await withRoot({}, async (root) => {
    assert.equal(loadExtractedText(root, NOTE, "视频"), null);
    assert.equal(loadExtractedText(root, NOTE, "图文"), null);
  });
});
```

- [ ] **Step 3: Run it and see it fail**, then move the code

Run: `node --test skills/xhs-favorites-organizer/tests/extracted-text.test.mjs`
Expected: FAIL — module not found.

Create `evidence-files.mjs` by **moving** (not copying) from `prepare-curation-review.mjs`: `clean`, `HASH`, `EXACT`, `sameFileIdentity`, `containedEvidenceFile`, `readContainedText`, `readEvidence`, and `currentEvidence`, together with the `node:fs`, `node:path` and `node:crypto` imports they use. Export them; `readEvidence` and the two helpers it uses throw `Curation evidence path is unsafe` on a symlink or escaping path and return `null` only for a missing root, folder or file, which is the behaviour the extracted-text tests below rely on. Split `currentEvidence` so card code can use it without the content binding:

```js
// Everything about a transcript or picture-text record except which version of the post it was made for.
export function evidenceText(record, contract) {
  if (
    !record || typeof record !== "object" || Array.isArray(record)
    || record.schema_version !== 1 || record.status !== contract.status || record.method !== contract.method
    || !clean(record.provider) || !clean(record.tool_version)
  ) return null;
  const text = clean(record.text);
  const resultSha256 = clean(record.result_sha256);
  if (!text || !HASH.test(resultSha256) || createHash("sha256").update(text, "utf8").digest("hex") !== resultSha256) return null;
  return {
    text,
    evidence: { method: record.method, provider: clean(record.provider), version: clean(record.tool_version), result_sha256: resultSha256 },
  };
}

// The review's reading: the record must also belong to this exact version of the post.
export function currentEvidence(record, contentSha256, contract) {
  if (!HASH.test(contentSha256) || clean(record?.content_sha256) !== contentSha256) return null;
  return evidenceText(record, contract);
}
```

In `prepare-curation-review.mjs` delete the moved definitions and add `import { HASH, clean, containedEvidenceFile, currentEvidence, readContainedText, readEvidence } from "./evidence-files.mjs";` (its `readDiandianSummary` at lines 145–161 still calls `containedEvidenceFile` and `readContainedText`, and `HASH` and `clean` are used throughout; export all six from the new module). `isStableNoteId`, `normalized`, `aliasesFor` and `prepareReview` stay where they are. The new module needs `node:fs`, `node:path` and `node:crypto` for the code it received; `prepare-curation-review.mjs` **keeps** its own `fs` (read and write of the review file), `path`, `fileURLToPath` and `createHash` (the summary hash at line 274) imports, and only the definitions move.

Create `extracted-text.mjs`:

```js
import { evidenceText, readEvidence } from "./evidence-files.mjs";

const TRANSCRIPT = { status: "transcribed", method: "local_transcription" };
const PICTURE_TEXT = { status: "extracted", method: "local_image_ocr" };

// The text the reader engine took out of a post's media, exactly as extracted (never rewritten).
// A video gives its transcript followed by any on-screen text; an image post gives its picture text.
// Returns { kind, text } or null.
export function loadExtractedText(videoAnalysisRoot, noteId, mediaType) {
  const spoken = evidenceText(readEvidence(videoAnalysisRoot, noteId, "transcription.json"), TRANSCRIPT)?.text || "";
  const onScreen = evidenceText(readEvidence(videoAnalysisRoot, noteId, "visual-ocr.json"), PICTURE_TEXT)?.text || "";
  if (mediaType === "图文") return onScreen ? { kind: "image-text", text: onScreen } : null;
  const text = [spoken, onScreen].filter(Boolean).join("\n\n");
  return text ? { kind: "video-transcript", text } : null;
}
```

- [ ] **Step 4: Run both suites**

Run: `node --test skills/xhs-favorites-organizer/tests/extracted-text.test.mjs skills/xhs-favorites-organizer/tests/test_curation_standard.mjs`
Expected: PASS (the review preparation behaves exactly as before).

- [ ] **Step 5: Commit**

```bash
git add skills/xhs-favorites-organizer/scripts/evidence-files.mjs skills/xhs-favorites-organizer/scripts/extracted-text.mjs skills/xhs-favorites-organizer/scripts/prepare-curation-review.mjs skills/xhs-favorites-organizer/tests/extracted-text.test.mjs package.json
git commit -m "refactor: share the evidence-file reader and add the extracted-text loader"
```

---

### Task 3: The card rules as one pure module (CARD-02, CARD-03, CARD-04, CARD-06, CARD-07, CARD-08)

**Files:**
- Create: `skills/xhs-favorites-organizer/scripts/card-content.mjs`
- Create: `skills/xhs-favorites-organizer/tests/card-content.test.mjs`
- Modify: `package.json` (`test:knowledge` gains the test)

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { cardCounts, cardText, cardTitle, postBody, replyState } from "../scripts/card-content.mjs";

const point = (summary = "完整回复", hash = "a".repeat(64)) => ({ summary, summary_sha256: hash });
const video = { kind: "video-transcript", text: "口播文字" };

test("postBody removes topic tags and keeps every paragraph break", () => {
  const body = postBody("第一段 说明。\r\n\r\n\r\n第二段  有   空格。 #AI工具[话题]# #aiagent[话题]# ");
  assert.equal(body, "第一段 说明。\n\n第二段 有 空格。");
});

test("a post with only topic tags has an empty body", () => {
  assert.equal(postBody("#AI工具[话题]# #趋势[话题]#"), "");
  assert.equal(postBody(undefined), "");
});

test("postBody never cuts a long post", () => {
  const long = "字".repeat(5000);
  assert.equal(postBody(long).length, 5000);
});

test("the title is the post's own title, tidied but not cut", () => {
  assert.equal(cardTitle({ title: "  一个人，3天，Codex，10W ", body: "正文", author: "甲", noteId: "n" }), "一个人，3天，Codex，10W");
  const long = "标".repeat(80);
  assert.equal(cardTitle({ title: long, body: "", author: "", noteId: "n" }), long);
});

test("without a title the first line of the post text is the title, cut at 52 characters with an ellipsis", () => {
  const first = "行".repeat(60);
  assert.equal(cardTitle({ title: "", body: `${first}\n第二行`, author: "甲", noteId: "n" }), `${"行".repeat(51)}…`);
  assert.equal(cardTitle({ title: undefined, body: "\n短标题\n后面", author: "", noteId: "n" }), "短标题");
});

test("without a title or text the title is the author's collection, then the note id tail", () => {
  assert.equal(cardTitle({ title: "", body: "", author: "金黄说AI", noteId: "n" }), "金黄说AI的收藏");
  assert.equal(cardTitle({ title: "", body: "", author: "", noteId: "6a2a81d1000000001702d3de" }), "收藏条目 · 02d3de");
});

test("replyState tells absent, complete and damaged apart by the saved reply's own hash", () => {
  const damaged = new Map([["n1", "a".repeat(64)]]);
  assert.equal(replyState("n1", null, damaged), "absent");
  assert.equal(replyState("n1", point("x", "a".repeat(64)), damaged), "damaged");
  assert.equal(replyState("n1", point("x", "b".repeat(64)), damaged), "complete", "a re-fetched reply replaces the damaged one");
  assert.equal(replyState("n2", point(), damaged), "complete");
});

test("complete reply: the reply is the main text and nothing else is added", () => {
  const out = cardText({ body: "原帖文字", point: point("回复全文"), state: "complete", extracted: video });
  assert.deepEqual(out, { mainText: "回复全文", mainSource: "diandian", extractedSection: null });
});

test("damaged reply with post text: post text is the main text, no extra section", () => {
  const out = cardText({ body: "原帖文字", point: point(), state: "damaged", extracted: video });
  assert.deepEqual(out, { mainText: "原帖文字", mainSource: "post-text", extractedSection: null });
});

test("no reply with post text: post text first, extracted text as its own section (CARD-07)", () => {
  const out = cardText({ body: "原帖文字", point: null, state: "absent", extracted: video });
  assert.deepEqual(out, { mainText: "原帖文字", mainSource: "post-text", extractedSection: video });
});

test("no reply and a post with only tags: the extracted text is the main text (CARD-06)", () => {
  assert.deepEqual(cardText({ body: "", point: null, state: "absent", extracted: video }), { mainText: "口播文字", mainSource: "video-transcript", extractedSection: null });
  const picture = { kind: "image-text", text: "图里的字" };
  assert.equal(cardText({ body: "", point: null, state: "absent", extracted: picture }).mainSource, "image-text");
});

test("a damaged reply with an empty post still falls back to extracted text", () => {
  assert.equal(cardText({ body: "", point: point(), state: "damaged", extracted: video }).mainSource, "video-transcript");
});

test("a damaged reply, a post with only tags and no extracted text: the saved reply is shown rather than nothing (D10)", () => {
  assert.deepEqual(
    cardText({ body: "", point: point("被截断的回复，"), state: "damaged", extracted: null }),
    { mainText: "被截断的回复，", mainSource: "diandian", extractedSection: null },
  );
});

test("nothing at all (no post text, no extracted text, no saved reply) gives an empty main text", () => {
  assert.deepEqual(cardText({ body: "", point: null, state: "absent", extracted: null }), { mainText: "", mainSource: "post-text", extractedSection: null });
});

test("cardCounts counts complete replies and transcripts shown, never a cut reply or a transcript hidden behind a reply", () => {
  const cards = [
    { mainSource: "diandian", replyDamaged: false, extracted: null },
    { mainSource: "diandian", replyDamaged: false, extracted: null },
    { mainSource: "diandian", replyDamaged: true, extracted: null },
    { mainSource: "video-transcript", replyDamaged: false, extracted: null },
    { mainSource: "post-text", replyDamaged: false, extracted: video },
    { mainSource: "post-text", replyDamaged: false, extracted: { kind: "image-text", text: "x" } },
    { mainSource: "post-text", replyDamaged: false, extracted: null },
  ];
  assert.deepEqual(cardCounts(cards), { replyCount: 2, transcriptCount: 2 });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `node --test skills/xhs-favorites-organizer/tests/card-content.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Minimal implementation** (`card-content.mjs`)

```js
// One deterministic step: what a card says. Its inputs are the catalog record, the saved DianDian reply,
// the text taken out of the post's media, and (elsewhere) the optional add-on. It reads no review state
// and no run record, so no agent session can decide whether a card shows in full.

const TITLE_LIMIT = 52;
const tidy = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

// The post's own words with its topic tags taken out. Line breaks are kept and nothing is cut.
export function postBody(description) {
  const lines = String(description ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/#[^#\n]*?\[话题\]#?/g, " ")
    .replace(/\[[^\]\n]*话题[^\]\n]*\]/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0\u3000]+/g, " ").trim());
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The post's own title; else the first line of its text (cut at 52 with an ellipsis); else the author's collection.
export function cardTitle({ title, body, author, noteId }) {
  const own = tidy(title);
  if (own) return own;
  const first = tidy(String(body ?? "").split("\n").find((line) => line.trim()) ?? "");
  if (first) return first.length > TITLE_LIMIT ? `${first.slice(0, TITLE_LIMIT - 1)}…` : first;
  const who = tidy(author);
  return who ? `${who}的收藏` : `收藏条目 · ${String(noteId).slice(-6)}`;
}

// "damaged" means the saved reply is the very copy on the frozen damaged list; a re-fetched reply has a
// different hash and counts as complete again. A refusal never reaches here (the loader drops it), so it is "absent".
export function replyState(noteId, point, damagedReplies) {
  if (!point) return "absent";
  return damagedReplies.get(noteId) === point.summary_sha256 ? "damaged" : "complete";
}

export function cardText({ body, point, state, extracted }) {
  if (state === "complete") return { mainText: point.summary, mainSource: "diandian", extractedSection: null };
  if (body) return { mainText: body, mainSource: "post-text", extractedSection: state === "absent" ? extracted : null };
  if (extracted) return { mainText: extracted.text, mainSource: extracted.kind, extractedSection: null };
  // A damaged reply is the only text left (D10): showing its saved part beats a card with no text.
  if (point) return { mainText: point.summary, mainSource: "diandian", extractedSection: null };
  return { mainText: "", mainSource: "post-text", extractedSection: null };
}

// The two numbers on the home page: cards that show a complete DianDian reply, cards that show a video transcript.
export function cardCounts(cards) {
  return {
    replyCount: cards.filter((card) => card.mainSource === "diandian" && !card.replyDamaged).length,
    transcriptCount: cards.filter((card) => card.mainSource === "video-transcript" || card.extracted?.kind === "video-transcript").length,
  };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test skills/xhs-favorites-organizer/tests/card-content.test.mjs`
Expected: PASS, 15 tests.

- [ ] **Step 5: Commit**

```bash
git add skills/xhs-favorites-organizer/scripts/card-content.mjs skills/xhs-favorites-organizer/tests/card-content.test.mjs package.json
git commit -m "feat: add the deterministic card rules (title, main text, reply state, counts)"
```

---

### Task 4: The frozen damaged-reply list (gap 1, supports CARD-04 and CAP-05 in Slice B)

**Files:**
- Modify: `site/diandian-text.mjs` (export the existing `isBare` as `isBareLine`)
- Create: `skills/xhs-favorites-organizer/scripts/damaged-replies.mjs`
- Create: `skills/xhs-favorites-organizer/tests/damaged-replies.test.mjs`
- Modify: `package.json` (`test:knowledge`)

- [ ] **Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { damageSigns, loadDamagedReplies } from "../scripts/damaged-replies.mjs";
import { diandianReplyCases } from "./public-judgement-fixtures.mjs";

const script = fileURLToPath(new URL("../scripts/damaged-replies.mjs", import.meta.url));
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const record = (id, summary) => ({
  version: 2, provider: "xiaohongshu-diandian", prompt: "总结", note_id: id, title: "t", summary,
  content_sha256: "c".repeat(64), prompt_version: "7".repeat(64), request_sha256: "8".repeat(64),
  summary_sha256: sha(summary), captured_at: "2026-10-02T00:00:00.000Z",
});

const COMPLETE = "这篇笔记讲了三件事。\n\n第一件，先做 A。\n第二件，再做 B。\n\n整体来说，值得收藏。\n\n#ai #agent #skill";

test("a complete reply, even one ending on a hashtag line, shows no sign", () => {
  assert.deepEqual(damageSigns(COMPLETE), []);
});

test("sign 1: a list marker glued after a comma means text was lost where two items joined", () => {
  const joined = "图文制作类\n\n**jimeng**（@甲）：即梦信息图生成，- **guizang**（@乙）：社交媒体配图。\n结束。";
  assert.deepEqual(damageSigns(joined), ["joined-list-items"]);
  assert.deepEqual(damageSigns("A - B 是一个普通的连字符用法，不算。"), []);
});

test("sign 1 needs the bullet on the same line: a colon line followed by a bullet line is normal formatting", () => {
  assert.deepEqual(damageSigns("核心内容：\n- 第一点\n- 第二点\n\n整体来说，值得收藏。"), []);
});

test("sign 2: the reply stops on a comma or a colon", () => {
  assert.deepEqual(damageSigns("前面都完整。\n\n完整地址在笔记评论区，"), ["ends-on-comma-or-colon"]);
  assert.deepEqual(damageSigns("前面都完整。\n\n这样做：\n"), ["ends-on-comma-or-colon"]);
});

test("sign 2: the reply stops on a bare heading, trailing hashtag lines ignored", () => {
  assert.deepEqual(damageSigns("前面都完整。\n\n核心亮点"), ["ends-on-bare-heading"]);
  assert.deepEqual(damageSigns("前面都完整。\n\n核心亮点\n\n#ai #agent"), ["ends-on-bare-heading"]);
});

test("both signs can be reported together", () => {
  assert.deepEqual(damageSigns("项目，- 另一个项目\n\n结尾是逗号，"), ["joined-list-items", "ends-on-comma-or-colon"]);
});

test("zero-width characters around bold markers do not hide a sign", () => {
  assert.deepEqual(damageSigns("项目\u200b\u200b，- \u200b\u200b下一个\u200b\u200b。"), ["joined-list-items"]);
});

test("the command lists only complete-looking-damaged replies the loader accepts, with the sealed hash", async () => {
  const work = await mkdtemp(join(tmpdir(), "favsense-damaged-"));
  try {
    await mkdir(join(work, "replies"));
    const ids = { ok: "a".repeat(24), cut: "b".repeat(24), refusal: "c".repeat(24), none: "d".repeat(24) };
    await writeFile(join(work, "catalog.json"), JSON.stringify({ version: 1, notes: Object.fromEntries(Object.values(ids).map((id) => [id, {}])) }));
    await writeFile(join(work, "replies", `${ids.ok}.json`), JSON.stringify(record(ids.ok, COMPLETE)));
    const cut = "前面都完整。\n\n完整地址在笔记评论区，";
    await writeFile(join(work, "replies", `${ids.cut}.json`), JSON.stringify(record(ids.cut, cut)));
    // A refusal is not a summary: the loader drops it, so it can never be "damaged".
    const refusal = diandianReplyCases.find((entry) => entry.id === "refusal-cannot-open-link-asks-for-copy").text.trim();
    await writeFile(join(work, "replies", `${ids.refusal}.json`), JSON.stringify(record(ids.refusal, refusal)));
    const run = spawnSync(process.execPath, [script, "--catalog", join(work, "catalog.json"), "--diandian-dir", join(work, "replies"), "--output", join(work, "damaged.json")], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const printed = JSON.parse(run.stdout);
    assert.equal(printed.count, 1);
    assert.deepEqual(printed.ids, [ids.cut]);
    const list = JSON.parse(await readFile(join(work, "damaged.json"), "utf8"));
    assert.deepEqual(list.entries, [{ note_id: ids.cut, summary_sha256: sha(cut), signs: ["ends-on-comma-or-colon"] }]);
    assert.deepEqual([...loadDamagedReplies(join(work, "damaged.json"))], [[ids.cut, sha(cut)]]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("a missing list means nothing is damaged; a malformed one is an error, not an empty list", async () => {
  assert.equal(loadDamagedReplies(join(tmpdir(), "favsense-no-such-list.json")).size, 0);
  const work = await mkdtemp(join(tmpdir(), "favsense-damaged-"));
  try {
    await writeFile(join(work, "bad.json"), JSON.stringify({ entries: [{ note_id: "x", summary_sha256: "nope" }] }));
    assert.throws(() => loadDamagedReplies(join(work, "bad.json")), /damaged reply list/i);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
```

(`public-judgement-fixtures.mjs` still exports `diandianReplyCases` after its Task 6 rewrite; keep that export.)

- [ ] **Step 2: Run it and see it fail**

Run: `node --test skills/xhs-favorites-organizer/tests/damaged-replies.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implementation**

In `site/diandian-text.mjs` rename `function isBare(line)` to `export function isBareLine(line)` and update every internal use (the three calls inside `headingText`, lines 57–59); no alias is kept.

`damaged-replies.mjs`:

```js
#!/usr/bin/env node
// The frozen list of saved DianDian replies that lost text when we captured them (spec §4, last paragraph).
// The rule is the two signs the spec names and nothing more; it is not tuned to a target count.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFormalPointSummary } from "./curation-quality.mjs";
import { isBareLine } from "../../../site/diandian-text.mjs";

const INVISIBLE = /[\u200b-\u200d\ufeff]/g;
// Same line only: a bullet on the NEXT line after a colon is ordinary formatting, not lost text.
const JOINED_LIST_ITEM = /[，,；;：:、][ \t]*[-•·][ \t]+\S/;
const HASHTAG_LINE = /^(?:#\S+\s*)+$/;
const COMMA_OR_COLON_END = /[，,：:]$/;
const HASH = /^[a-f0-9]{64}$/;
const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function damageSigns(reply) {
  const text = String(reply ?? "").replace(INVISIBLE, "").replace(/\r\n?/g, "\n");
  const signs = [];
  if (JOINED_LIST_ITEM.test(text)) signs.push("joined-list-items");
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  while (lines.length && HASHTAG_LINE.test(lines.at(-1))) lines.pop();
  const last = lines.at(-1) ?? "";
  if (COMMA_OR_COLON_END.test(last)) signs.push("ends-on-comma-or-colon");
  else if (last && isBareLine(last)) signs.push("ends-on-bare-heading");
  return signs;
}

// Only replies the saved-reply loader accepts are looked at: a refusal is not a summary.
export function findDamagedReplies({ diandianDir, noteIds }) {
  const entries = [];
  for (const noteId of [...noteIds].sort()) {
    const point = loadFormalPointSummary(diandianDir, noteId);
    const signs = point ? damageSigns(point.summary) : [];
    if (signs.length) entries.push({ note_id: noteId, summary_sha256: point.summary_sha256, signs });
  }
  return entries;
}

// note id -> hash of the damaged copy. A missing file means nothing is damaged; a malformed one is refused.
export function loadDamagedReplies(path) {
  let source;
  try { source = readFileSync(path, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  const list = JSON.parse(source.replace(/^\ufeff/, ""));
  if (!Array.isArray(list?.entries) || list.entries.some((entry) => !NOTE_ID.test(entry?.note_id) || !HASH.test(entry?.summary_sha256))) {
    throw new Error("damaged reply list is malformed");
  }
  return new Map(list.entries.map((entry) => [entry.note_id, entry.summary_sha256]));
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`--${name} is required`);
  return resolve(process.argv[index + 1]);
}

function main() {
  const catalog = JSON.parse(readFileSync(option("catalog"), "utf8").replace(/^\ufeff/, ""));
  const entries = findDamagedReplies({ diandianDir: option("diandian-dir"), noteIds: Object.keys(catalog.notes || {}).filter((id) => NOTE_ID.test(id)) });
  const output = option("output");
  mkdirSync(dirname(output), { recursive: true });
  const staging = `${output}.${process.pid}.tmp`;
  writeFileSync(staging, `${JSON.stringify({ schema_version: 1, signs: ["joined-list-items", "ends-on-comma-or-colon", "ends-on-bare-heading"], entries }, null, 2)}\n`, "utf8");
  renameSync(staging, output);
  process.stdout.write(`${JSON.stringify({ count: entries.length, ids: entries.map((entry) => entry.note_id) })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
```

- [ ] **Step 4: Run it and see it pass**

Run: `node --test skills/xhs-favorites-organizer/tests/damaged-replies.test.mjs skills/xhs-favorites-organizer/tests/diandian-summary-display.test.mjs`
Expected: PASS (the second file proves the renamed export did not break the formatting module).

- [ ] **Step 5: Commit**

```bash
git add site/diandian-text.mjs skills/xhs-favorites-organizer/scripts/damaged-replies.mjs skills/xhs-favorites-organizer/tests/damaged-replies.test.mjs package.json
git commit -m "feat: add the frozen damaged-reply list and its two damage signs"
```

---

### Task 5: Front end — one source line, extracted section, tool badge, honest counts (AC-CARD; CARD-01..09)

Mockup references for every step below: the right-hand "新设计" panels of `docs/designs/2026-10-14-card-design-rewrite.html` § ① to § ④ (structure, order, behaviour), and the fold, source box (`summary-provenance` with the edit button inside), and footer of `docs/designs/2026-10-14-card-summary-sources.html` § ①. Styling comes from `site/styles.css` tokens, never the mockup's `t-*` classes.

**Files:**
- Modify: `site/app.js`, `site/index.html`, `site/styles.css`
- Modify: `scripts/serve-qa-fixture.mjs`
- Create: `scripts/fixtures/faithful-cards.json` (frozen cards, built once by the scratch script in Step 1)
- Create: `site/e2e/faithful-cards.spec.mjs`
- Delete: `site/e2e/card-summary-sources.spec.mjs`, `scripts/fixtures/card-summary-sources.json`
- Modify: the data-shape and banner tests in `skills/xhs-favorites-organizer/tests/test_public_site.mjs` (see the disposition table)

**New public card data (the contract the front end reads; Task 6 produces it):**
`mainText` (string, paragraphs kept), `mainSource` (`"diandian"` | `"post-text"` | `"video-transcript"` | `"image-text"`), `replyDamaged` (bool), `postUnreachable` (bool), `extracted` (`{kind, text}` or `null`), `tools` (string[]), `unverifiedTools` (string[]), plus the unchanged `id number title author sourceUrl publishedAt likes collections mediaType category categorySource categoryReason suggestedCategory sourceBoards themes kind resources resourceIds`. Meta gains `replyCount`, `transcriptCount`; it loses `verifiedNoteCount` and `videoMethod`. Removed per card: `summary deepSummary deepSummarySource curationRevision summaryStatus curationStatus summaryReason summaryState summaryReasonCode candidateKind reviewedAt action evidence`.

- [ ] **Step 1: Freeze the cards** (scratch script in the session scratchpad, not committed)

Write `scripts/fixtures/faithful-cards.json` in the public-data shape above, meta copied from the old fixture (`meta.resourceIndex`, `kindLabels`, titles) with real counts computed by `cardCounts`. Cards, with the text lifted verbatim from the named source:
1. `6a7dc92600000000250090ff` — case ①. Title `一个人，3天，Codex，10W`, author `陈祝器`, publishedAt `2026-08-13`, category `AI自媒体`, kind `Workflow`, suggestedCategory `内容增长与商业`, themes `["商业验证","复盘智能体","经验产品化"]`. `mainText` = the real DianDian reply: take `deepSummary` of that id from the **currently committed** `site/data/knowledge.json` (public data, old shape) **only if** that card's `deepSummarySource` there is `xiaohongshu-diandian` (for an accepted card it is; check, do not assume).
2. `6a44938c0000000006021e9e` — case ②. Title `小红书爆款高赞Skill汇总‼️`, `mainSource: "post-text"`, `replyDamaged: true`, `mainText` = the single paragraph in the mockup's case ② (`.structured-summary` of line 62), author `金黄说AI`, publishedAt `2026-07-01`, category `AI自媒体`, kind `Note`, suggestedCategory `AI内容`, themes `["Agent Skill","Skill仓库","内容创作"]`.
3. `6ab3dfdc00000000140023f9` — case ③. Title `Seedance老废片？花2W得出的提示词模板分享`, `mainText` = the reply shown in the mockup's case ③ panel (line 73), turned back into plain reply text (each `<h4>` a bare heading line, each `<p>` a paragraph line, each `<li>` a `-` line, blank line between blocks). Do **not** use the committed public data for this card: while it was held it published only the 240-character excerpt, not the reply. `tools: ["Seedance 导演 Skill"]`, `unverifiedTools: ["Seedance 导演 Skill"]` (lifted from the mockup's chip; the real note's add-on lists no tools, so this is what the badge test needs, not a claim about the real data), kind `Tool`, category `AI视频生成`, suggestedCategory `Skills与工作流`, author `Kiwi的AI实验室🥝`, publishedAt `2026-09-24`.
4. `6a2a81d1000000001702d3de` — case ④. Title `AI搜索引擎项目，GitHub TrendIing榜第一`, `mainSource: "video-transcript"`, `mainText` = the transcript paragraph in the mockup's case ④ (line 84), kind `Note`, category `Skills`, themes `["last30days","社媒研究","趋势"]`, author `AI小蔡狗`, publishedAt `2026-06-12`.
5. Synthetic, ids prefixed `fixture-`: `fixture-post-and-transcript` (CARD-07: `post-text` main of two paragraphs plus `extracted: {kind:"video-transcript", text:"…"}`), `fixture-paragraphs` (CARD-08: `mainText: "第一段。\n\n第二段。"`), `fixture-unreachable` (`postUnreachable: true`, `mainSource: "diandian"`), `fixture-image-text` (`mainSource: "image-text"`), `fixture-short-reply` (a `diandian` reply short enough to need no fold), `fixture-no-text` (`mainText: ""`, `mainSource: "post-text"`), `fixture-damaged-transcript` (`replyDamaged: true`, `mainSource: "video-transcript"`, a short transcript as `mainText`), `fixture-damaged-only-reply` (D10: `replyDamaged: true`, `mainSource: "diandian"`, `mainText` a short reply that stops on a comma, e.g. `这篇讲了两件事，第一件，`; it stands for the 13 real cards whose only text is a cut reply).
Every card has `unverifiedTools: []` unless stated, `resources: []`, `resourceIds: []`, `extracted: null`, `postUnreachable: false`, `replyDamaged: false` unless stated. `meta.noteCount` is the number of cards in the file; `meta.replyCount` and `meta.transcriptCount` are produced by running `cardCounts` over them (never typed by hand).

- [ ] **Step 2: Write the failing browser test** (`site/e2e/faithful-cards.spec.mjs`)

Keep the harness of the old spec (reset, scenario `faithful-cards`, `openCard`), compute expectations from the fixture instead of hard-coding lengths:

```js
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const headers = { "X-FavSense-Test": "favsense-synthetic-v1" };
const fixture = JSON.parse(readFileSync(new URL("../../scripts/fixtures/faithful-cards.json", import.meta.url), "utf8"));
const card = (id) => fixture.notes.find((note) => note.id === id);
const REPLY = "6a7dc92600000000250090ff", DAMAGED = "6a44938c0000000006021e9e", FORMER_HELD = "6ab3dfdc00000000140023f9";
const VIDEO_ONLY_TAGS = "6a2a81d1000000001702d3de";
const BANNERS = ["证据未补齐", "暂不发布", "总结未通过审核", "本篇总结失败", "本次未尝试", "需重新核验", "尚未开始深度整理", "总结已保存，尚未完成证据核验", "待审核"];

test.afterEach(async ({ page }) => { await page.request.post("http://127.0.0.1:8766/__test/reset", { headers }); });

async function openCard(page, id) {
  await page.request.post("http://127.0.0.1:8766/__test/reset", { headers });
  await page.request.post("http://127.0.0.1:8766/__test/scenario", { headers, data: { scenario: "faithful-cards" } });
  await page.goto(`/#note=${id}`);
  const detail = page.getByRole("dialog");
  await expect(detail.locator(".detail-title")).toBeVisible();
  return detail;
}
```

Tests (each runs on the desktop and phone projects automatically):
1. **CARD-01** — open the grid; for every card in the fixture, `.card-summary-source` contains none of `BANNERS`; no element anywhere contains `证据未补齐，暂不发布`.
2. **CARD-02** — `REPLY` detail title equals the fixture title; `fixture-post-and-transcript` etc. likewise.
3. **CARD-03** [mockup § ①] — source `strong` is `点点 AI 深度总结`; provenance contains `点点 AI 的完整回复，原文未改动，共 ${card(REPLY).mainText.trim().length} 字` (the source box counts the trimmed reply, the fold button below counts the whole `mainText.length`, exactly as the live code does today); the opening sentence `根据你引用的笔记` is absent; `.summary-fold-toggle` text is `展开全文 · ${length} 字`, `aria-expanded` goes `false` → `true` on click, collapsed body height ≤ 421, expanded height greater; tool/theme chips `商业验证` present.
4. **CARD-04** [mockup § ②] — source `strong` is `原帖公开文字`; provenance contains exactly `保存的点点回复缺了内容（是我们采集出错），下一轮重新获取；在那之前先显示原帖自己的文字。`; `.structured-summary` text equals the fixture `mainText`; no `.summary-fold-toggle`; chips `Agent Skill`, `Skill仓库`, `内容创作` present.
5. **CARD-05** [mockup § ③] — source `点点 AI 深度总结`; the chip `Seedance 导演 Skill` contains the badge `未核实`; no banner.
6. **CARD-06** [mockup § ④] — source `视频转写与画面文字`; provenance contains `原帖只有话题标签、没有正文`; main text starts `记住这个地表超强AI搜索引擎项目`; and for `fixture-damaged-transcript` (`replyDamaged: true`, `mainSource: "video-transcript"`) the explanation starts `保存的点点回复缺了内容（是我们采集出错），下一轮重新获取；原帖只有话题标签`.
7. **CARD-07** — `fixture-post-and-transcript`: main text equals the post paragraphs; a `section` headed `视频转写与画面文字` follows and contains the transcript.
8. **CARD-08** — `fixture-paragraphs`: the main text renders two separate `<p>` elements.
9. **Unreachable** — `fixture-unreachable`: source `已完成（原帖不可访问）` and the approved explanation.
10. **Image text** — `fixture-image-text`: source `图片文字`.
11. **CARD-09** — home page: `#hero-counts` has text `${fixture.meta.noteCount} 条收藏 · ${fixture.meta.replyCount} 条有完整点点总结 · ${fixture.meta.transcriptCount} 条有视频转写`; the page text contains neither `条完成深度解读` nor `已完成视频内容核验`; `#proof-replies` and `#proof-transcripts` show the same two numbers; the four `.method-proof > div` cells sit on one row at desktop width (equal top offset, the note below or beside them but never between), and at both widths the document has no sideways scroll (`scrollWidth - clientWidth <= 0`).
12. **Footer and source box** [mockup (summary-sources) § ①] — the QA server has two origins sharing the scenario: `http://127.0.0.1:8766` is the local workbench (the footer's first control is `打开原帖` or a disabled `请先启动 FavSense 本地服务`, never a link) and `http://127.0.0.1:8767` is the public site. On **8767** (`page.goto("http://127.0.0.1:8767/#note=<REPLY>")`, after the scenario is set through 8766) the footer holds, in this order, the link `在小红书搜索原帖` (its `href` starts `https://www.xiaohongshu.com/search_result?` and no link anywhere on the page contains `/explore/`), `复制卡片链接` and the bookmark button; on 8766 the first control is that local button and the other two follow it. The `编辑描述` button sits inside the source box (inside its bounding box, right of the label), and opens the editor with the text on screen; with clipboard permission granted to the page (`context.grantPermissions(["clipboard-read", "clipboard-write"])`), clicking `复制卡片链接` shows the toast `卡片链接已复制` and the clipboard text ends with `#note=<id>`.
13. **Grid parity** — the grid preview shows the same source label and the same first text as the detail view for `REPLY` and `DAMAGED`.
14. **No sideways scroll** — dialog `scrollWidth - clientWidth <= 0` for `REPLY` and for the longest transcript card, at both widths.
15. **Personal revision** — ported from the old spec: revision wins over the reply, restoring brings the reply back, fold state survives a re-draw and resets after closing. New assertions: after saving a revision the browser's local storage holds it, and the JSON served at `/data/knowledge.json` is byte-identical to what was served before the save.
16. **No text** — `fixture-no-text` (`mainText: ""`, no extracted text): the detail view has its title and chips but no source box and no text section, and no new wording appears (decision D10).
17. **Search** — typing a phrase that occurs only in the `DAMAGED` post text lists that card; typing a phrase that occurs only in the `VIDEO_ONLY_TAGS` transcript lists that card.
18. **Cut reply is the only text (D10)** — `fixture-damaged-only-reply`: source `strong` is `点点 AI 深度总结`; provenance starts `保存的点点回复缺了内容（是我们采集出错），下一轮重新获取；` and ends `先显示已保存的那部分点点回复。`; it does not contain `点点 AI 的完整回复`; `.structured-summary` text equals the fixture `mainText`; no banner. The home counts (test 11) do not include this card in `replyCount`.

Also keep the unchanged old cases that still describe live behaviour (compact detail view: no `核心结论` heading, no next-step box; short reply shows no fold button with `mask-image: none`).

- [ ] **Step 3: Run it and see it fail**

Run: `npx.cmd playwright test site/e2e/faithful-cards.spec.mjs --project=chromium`
Expected: FAIL — the scenario name `faithful-cards` is unknown to the QA server and `app.js` still draws status banners.

- [ ] **Step 4: QA server**

In `scripts/serve-qa-fixture.mjs`: add `"faithful-cards"` to `scenarios` in place of `"card-sources"`; load `scripts/fixtures/faithful-cards.json` instead of `card-summary-sources.json`; rewrite the four synthetic `knowledge.notes` (lines 31–35) to the new shape (add `mainText mainSource replyDamaged postUnreachable extracted tools unverifiedTools`, delete `summaryStatus summaryState summaryReason curationRevision reviewedAt evidence deepSummarySource candidateKind`, give `meta` `replyCount transcriptCount`); delete the note mutations for the `summary-failed`, `batch-aborted` and `stale` scenarios (lines 66–70: those scenarios keep driving the run panel, they no longer change a card). `git rm` the two old files.

- [ ] **Step 5: `app.js`**

Make these changes (each is a deletion or a replacement of the named function):
- `validateKnowledgeData`: require `typeof note.mainText === "string"`, `["diandian","post-text","video-transcript","image-text"].includes(note.mainSource)`, `[themes, tools, unverifiedTools, resources].every(isStringArray)`; delete the `evidence` check; `emptyKnowledgeData().meta` gets `replyCount: 0, transcriptCount: 0` and loses `verifiedNoteCount`.
- Delete `localEvidenceDescription`, `loadLocalNoteOrganizationStatus`, `localOrganizationHtml`, `state.noteOrganizationStatus`, `state.noteOrganizationPending`, the `validateLocalNoteOrganizationStatus` import, and the call in `openNote`.
- `showsDianDianReply(note)` → `note.mainSource === "diandian" && Boolean(note.mainText.trim())`.
- `noteDescription(note)`: personal revision first; then `showsDianDianReply` → `stripDiandianOpener(note.mainText).text`; else `note.mainText`.
- Replace `descriptionHtml` so only the three real formatters remain: revision → `formatSummaryHtml`, reply → `formatDiandianHtml`, everything else → the new `formatPostHtml`:

```js
// Post text and extracted text are shown as written: blank lines separate paragraphs, a single line break stays a line break.
function formatPostHtml(text) {
  return String(text ?? "").split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`).join("");
}
```

- Replace `summarySourcePresentation` with:

```js
const SOURCE_COPY = {
  damaged: "保存的点点回复缺了内容（是我们采集出错），下一轮重新获取；在那之前先显示原帖自己的文字。",
  noReply: "这篇没有点点总结；先显示原帖自己的文字。",
  // Opening of the two "extracted text is the main text" sentences: a saved-but-damaged reply says so, otherwise there is none.
  openingDamaged: "保存的点点回复缺了内容（是我们采集出错），下一轮重新获取；",
  openingNoReply: "这篇没有点点总结；",
  videoOnlyRest: "原帖只有话题标签、没有正文，所以这里是视频里说的话和画面上的字，未经 AI 改写。",
  imageOnlyRest: "原帖只有话题标签、没有正文，所以这里是图片上的字，未经 AI 改写。",
  damagedOnlyRest: "原帖只有话题标签、没有正文，所以先显示已保存的那部分点点回复。",
  unreachable: "原帖可能已被作者隐藏或删除；已保留现有记录并结束补证，不作为正式核验结果发布。",
};
const opening = (note) => (note.replyDamaged ? SOURCE_COPY.openingDamaged : SOURCE_COPY.openingNoReply);

function summarySourcePresentation(note) {
  if (note.postUnreachable) return { label: "已完成（原帖不可访问）", tone: "metadata", explanation: SOURCE_COPY.unreachable };
  // D10: the only text there is, a reply that lost its ending; it is shown as saved and says so.
  if (note.mainSource === "diandian" && note.replyDamaged) return { label: "点点 AI 深度总结", tone: "diandian", explanation: SOURCE_COPY.openingDamaged + SOURCE_COPY.damagedOnlyRest };
  if (note.mainSource === "diandian") {
    const reply = note.mainText.trim();
    return {
      label: "点点 AI 深度总结", tone: "diandian",
      explanation: `点点 AI 的完整回复，原文未改动，共 ${reply.length} 字；${stripDiandianOpener(reply).removed ? "只去掉开头的对话语句，" : ""}按小标题与列表排版。`,
    };
  }
  if (note.mainSource === "video-transcript") return { label: "视频转写与画面文字", tone: "evidence", explanation: opening(note) + SOURCE_COPY.videoOnlyRest };
  if (note.mainSource === "image-text") return { label: "图片文字", tone: "evidence", explanation: opening(note) + SOURCE_COPY.imageOnlyRest };
  return { label: "原帖公开文字", tone: "metadata", explanation: note.replyDamaged ? SOURCE_COPY.damaged : SOURCE_COPY.noReply };
}
```

(The sentence with `共 N 字` keeps the live behaviour that adds the opener clause only when an opener was removed; the mockup's ① shows the sentence without it because that reply has no opener.)
- `descriptionSection`: if `note.mainText` is empty and there is no personal revision, return `""` (no provenance box, no wording; decision D10). Fold body uses `note.mainText.length` in place of `note.deepSummary.length`.
- New section after the main text in `renderDetail`, plus tool chips with the badge:

```js
function extractedSectionHtml(note) {
  if (!note.extracted) return "";
  const heading = note.extracted.kind === "video-transcript" ? "视频转写与画面文字" : "图片文字";
  return `<section class="detail-section extracted-section" aria-label="${heading}"><h3>${heading}</h3><div class="extracted-text">${formatPostHtml(note.extracted.text)}</div></section>`;
}
function toolChip(note, name) {
  const badge = note.unverifiedTools.includes(name) ? ' <small class="tool-unverified">未核实</small>' : "";
  return `<span class="tool-chip">${escapeHtml(name)}${badge}</span>`;
}
```

  `renderDetail` inserts `${extractedSectionHtml(note)}` right after `${descriptionSection(note)}` and builds the "相关主题与工具" chips with `note.themes.map(plain chip)` + `note.tools.map(toolChip)`; `noteCard` builds `tools` with `toolChip`.
- `filteredNotes` haystack: `[note.title, note.author, note.category, note.suggestedCategory, noteDescription(note), note.extracted?.text ?? "", ...note.themes, ...note.tools]`.
- `init`: set `#hero-counts` to exactly `` `${meta.noteCount} 条收藏 · ${meta.replyCount} 条有完整点点总结 · ${meta.transcriptCount} 条有视频转写` ``, set `#proof-replies` to `meta.replyCount` and `#proof-transcripts` to `meta.transcriptCount`; delete the `#proof-videos` line.

- [ ] **Step 6: `index.html` and `styles.css`**

`index.html`: inside `.hero-copy`, after `#hero-intro`, add `<p class="hero-counts" id="hero-counts"></p>`. In `.method-proof` replace the `#proof-videos` cell with `<div><strong id="proof-replies">—</strong><span>条有完整点点总结</span></div>` and add `<div><strong id="proof-transcripts">—</strong><span>条有视频转写</span></div>`.
`styles.css`: the strip now has four number cells plus the note instead of three plus the note, so its grids change with it: line 339 `grid-template-columns: repeat(3, 1fr) 2fr` becomes `repeat(4, 1fr) 2fr`; the tablet rule at line 557 (`repeat(3, 1fr)`) becomes `repeat(2, 1fr)` (two rows of two; the note already spans the full row); the phone rule at line 589 (`1fr`) stays. Without this the fourth cell lands in the wide note column and the note drops to a second row. Then add

```css
.hero-counts { margin: 12px 0 0; color: var(--ink-soft); font-size: 14px; font-weight: 700; }
.extracted-text p { margin: 0 0 8px; color: var(--ink); font-size: 13px; line-height: 1.75; white-space: pre-wrap; }
.tool-unverified { margin-left: 4px; padding: 1px 5px; border-radius: 5px; background: color-mix(in srgb, var(--gold, #b58b00), var(--surface) 80%); color: var(--ink); font-size: 10.5px; font-weight: 700; }
```

(Use the real token names found in `styles.css`; the `.tool-unverified` text is the signal, colour is only reinforcement.)

- [ ] **Step 7: Rewrite the tests Task 5 owns** (see the disposition table): the `app.js` and validator cases in `test_public_site.mjs`, the banner and overlay cases in `organization-recovery.spec.mjs`, and the overlay line in `design-text-legibility-regression.spec.mjs`. The static-app asset test must also expect `hero-counts`, `proof-replies`, `proof-transcripts`. Do **not** touch the cases that read `site/data/knowledge.json` or run the builder: the committed data is still the old shape until Task 6, and those cases still describe it truthfully.

- [ ] **Step 8: Run**

Run: `npx.cmd playwright test` (both projects, the whole e2e folder), then `node --test skills/xhs-favorites-organizer/tests/test_public_site.mjs`, then `npm.cmd run lint:a11y` and `npm.cmd run check:syntax`
Expected: PASS everywhere. Other e2e specs (`organization-recovery`, `design-*`, `qa-accepted-skill-metadata.regression-1`) keep passing on the rewritten synthetic notes; fix any selector that depended on a removed field.

- [ ] **Step 9: Commit**

```bash
git add site/app.js site/index.html site/styles.css scripts/serve-qa-fixture.mjs scripts/fixtures/faithful-cards.json site/e2e/faithful-cards.spec.mjs skills/xhs-favorites-organizer/tests/test_public_site.mjs
git rm site/e2e/card-summary-sources.spec.mjs scripts/fixtures/card-summary-sources.json
git commit -m "feat: draw every card from its own text, with one honest source line and real counts"
```

---

### Task 6: The builder makes the card, without the gate (CARD-01..09, AC-NOGATE, AC-ADDON, §7 card path)

**Files:**
- Rewrite: `skills/xhs-favorites-organizer/scripts/public-judgement.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/build-public-site.mjs`
- Trim: `skills/xhs-favorites-organizer/scripts/curation-quality.mjs`
- Create: `skills/xhs-favorites-organizer/tests/faithful-cards-builder.test.mjs`
- Rewrite: `tests/public-judgement.test.mjs`, `tests/public-judgement-builders.test.mjs`, `tests/public-judgement-fixtures.mjs`; update `tests/diandian-summary-display.test.mjs` and the other files in the disposition table
- Modify: `package.json` (`test:knowledge`)

- [ ] **Step 1: Write the failing builder test** (`faithful-cards-builder.test.mjs`)

Helper (fresh objects every call, no shared defaults):

```js
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TODAY, hex, note, profile, root, skillResource } from "./public-judgement-fixtures.mjs";

const builder = join(root, "skills/xhs-favorites-organizer/scripts/build-public-site.mjs");
const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const reply = (id, summary) => ({
  version: 2, provider: "xiaohongshu-diandian", prompt: "总结", note_id: id, title: "t", summary,
  content_sha256: hex("c"), prompt_version: hex("7"), request_sha256: hex("8"), summary_sha256: sha(summary),
  captured_at: "2026-10-02T00:00:00.000Z",
});
const evidence = (text, method, status) => ({ schema_version: 1, status, method, content_sha256: hex("d"), provider: "local", tool_version: "1", text, result_sha256: sha(text) });

// Runs the builder on a set of notes. `build` returns { meta, cards by id }; `buildResult` returns the raw
// process result (for the cases that must fail). `damaged` is a list of { id, summary } naming the saved
// replies that are on the frozen list. Every call makes its own objects.
async function run({ notes, curation = {}, candidates = {}, replies = {}, transcripts = {}, pictureText = {}, damaged = [], resources = [], audit = null, extraConfig = {} }, read) {
  const work = await mkdtemp(join(tmpdir(), "favsense-cards-"));
  const at = (name) => join(work, name);
  try {
    await mkdir(at("replies"), { recursive: true });
    for (const [id, summary] of Object.entries(replies)) await writeFile(join(at("replies"), `${id}.json`), JSON.stringify(reply(id, summary)));
    for (const [id, text] of Object.entries(transcripts)) {
      await mkdir(join(at("video"), id), { recursive: true });
      await writeFile(join(at("video"), id, "transcription.json"), JSON.stringify(evidence(text, "local_transcription", "transcribed")));
    }
    for (const [id, text] of Object.entries(pictureText)) {
      await mkdir(join(at("video"), id), { recursive: true });
      await writeFile(join(at("video"), id, "visual-ocr.json"), JSON.stringify(evidence(text, "local_image_ocr", "extracted")));
    }
    await writeFile(at("catalog.json"), JSON.stringify({ version: 1, notes }));
    await writeFile(at("curation.json"), JSON.stringify(curation));
    await writeFile(at("candidates.json"), JSON.stringify(candidates));
    await writeFile(at("profile.json"), JSON.stringify(profile));
    await writeFile(at("resources.json"), JSON.stringify({ verified_at: TODAY, resources }));
    await writeFile(at("damaged.json"), JSON.stringify({ entries: damaged.map(({ id, summary }) => ({ note_id: id, summary_sha256: sha(summary), signs: ["ends-on-comma-or-colon"] })) }));
    if (audit) await writeFile(at("audit.json"), JSON.stringify({ version: 2, notes: audit }));
    await writeFile(at("config.json"), JSON.stringify({
      version: 1, domain_profile: at("profile.json"), curation_file: at("curation.json"),
      boards: [{ id: "private-board-id", name: "Synthetic", enabled: true }], public_stats: {},
      ...(audit ? { curation_quality: { audit_file: at("audit.json") } } : {}),
      ...extraConfig,
    }));
    const result = spawnSync(process.execPath, [
      builder, "--catalog", at("catalog.json"), "--config", at("config.json"), "--curation", at("curation.json"),
      "--candidates", at("candidates.json"), "--profile", at("profile.json"), "--resources", at("resources.json"),
      "--effective-date", TODAY, "--diandian-dir", at("replies"), "--video-analysis", at("video"),
      "--damaged-replies", at("damaged.json"), "--output", at("public.json"),
    ], { cwd: root, encoding: "utf8" });
    return await read(result, at("public.json"));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const readCards = async (result, outputPath) => {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const data = JSON.parse(await readFile(outputPath, "utf8"));
  return { meta: data.meta, cards: Object.fromEntries(data.notes.map((card) => [card.id, card])) };
};
const build = (inputs) => run(inputs, readCards);
const buildResult = (inputs) => run(inputs, async (result, outputPath) => ({ status: result.status, stderr: result.stderr, written: await readFile(outputPath, "utf8").then(() => true, () => false) }));
```

The tests:

1. **CARD-02 titles** — own title kept; no title → first line cut to 52 with `…`; no text → `<author>的收藏`.
2. **CARD-03** — complete reply: `mainSource "diandian"`, `mainText` equals the reply, `replyDamaged false`.
3. **CARD-04** — same note on the damaged list: `mainSource "post-text"`, `mainText` is the post body, `replyDamaged true`; then replace the reply (different text) with the same list → complete again.
4. **Refusal** — a refusal text saved as the reply → `mainSource "post-text"`, not damaged.
5. **CARD-05** — a sealed candidate `{ kind: "Skill", tools: ["Seedance 导演 Skill"], themes: [...] }` with no matching resource: `kind` is not `Skill` (use `profile.classification.default` expectations from the fixture profile), `tools` includes the name, `unverifiedTools` equals `["Seedance 导演 Skill"]`, the reply is still the main text.
6. **Confirmed Skill** — curation entry with `tools: [resource.name]` and a fresh `skillResource()`: `kind "Skill"`, `unverifiedTools []`, `resources` has the name, `resourceIds` has the id.
7. **CARD-06** — video post, description `#趋势[话题]#`, transcript file: `mainSource "video-transcript"`.
8. **CARD-07** — video post with text, no reply, transcript: `mainSource "post-text"`, `extracted.kind "video-transcript"`. A second note with a complete reply **and** a transcript file (named `n-reply-and-transcript` so test 11 can refer to it): its `extracted` is `null` and its `mainSource` is `diandian`.
9. **Image post** — `type "图文"` with picture text and no body: `mainSource "image-text"`.
10. **CARD-08** — description `"第一段\n\n第二段 #x[话题]#"` → `mainText "第一段\n\n第二段"`.
11. **CARD-09** — meta `replyCount`/`transcriptCount` equal the counts from the cards in tests 2–10, with `n-reply-and-transcript` counted in `replyCount` and **not** in `transcriptCount`; `meta` has no `verifiedNoteCount` or `videoMethod`.
12. **Unreachable (D3)** — three builds of one note: (a) `audit: { [id]: { status: "unavailable" } }` (the helper points `config.curation_quality.audit_file` at it), (b) a sealed candidate carrying `review_status: "unavailable"`, (c) neither. (a) and (b) give `postUnreachable true`, (c) gives `false`; in all three `title`, `mainText` and `mainSource` are identical. A fourth build with an `audit` that marks the note `rejected` or `pending` also gives `postUnreachable false` (only `unavailable` is read), and one whose `audit_file` points at a path that does not exist builds without error.
13. **AC-NOGATE** — build the notes of tests 2–10 twice: once with `curation`, `candidates`, an `audit` of `rejected`/`pending` states and `extraConfig.curation_quality = { publish_only_accepted: true, audit_file: <missing> }`; once with all of those removed. For every card `title`, `mainText` and `mainSource` are identical.
14. **AC-ADDON** — build with and without the add-on: only `themes tools unverifiedTools category categorySource categoryReason suggestedCategory kind resources resourceIds` may differ; `title`, `mainText`, `mainSource`, `extracted`, `replyDamaged` do not.
15. **Public safety** — with `buildResult`, a description containing `xsec_token=abc` makes the builder exit non-zero with `Public data safety check failed` in `stderr`, and `written` is `false`.
16. **No fields left behind** — a card has none of `summary deepSummary deepSummarySource curationRevision summaryStatus curationStatus summaryReason summaryState summaryReasonCode candidateKind reviewedAt action evidence`.
17. **Search link unchanged** — `sourceUrl` still starts `https://www.xiaohongshu.com/search_result?` and carries no `/explore/` (LINK-02 is not planned).
18. **Cut reply is the only text (D10)** — a note whose saved reply is on the damaged list, whose description is `#趋势[话题]#` and which has no transcript file: `mainSource "diandian"`, `replyDamaged true`, `mainText` equal to the saved reply, `extracted null`. It is not counted in `meta.replyCount` (test 11 adds this note to its set and expects the same `replyCount` as before). A note with the same description, no reply and no transcript still gets `mainText ""` (the only empty card left).

- [ ] **Step 2: Run it and see it fail**

Run: `node --test skills/xhs-favorites-organizer/tests/faithful-cards-builder.test.mjs`
Expected: FAIL — `--damaged-replies` unknown or old fields present.

- [ ] **Step 3: Rewrite `public-judgement.mjs`** (keep `validateContentKindProfile`, `resourceLookup`, `classify`; replace `fallbackEntry` and `judgePublicNote`)

`fallbackEntry` keeps the category and kind rules but no longer builds a 240-character summary or the "尚未解读" placeholder:

```js
function fallbackEntry(note, profile) {
  /* identical category and kind rule loops as today ... */
  return { category, themes: [], summary: "", action: "", tools: [], kind };
}
```

```js
// What the add-on may say about a note: its content kind, category suggestion, topics and tools.
// Whether the card is shown in full is not decided here.
export function judgePublicNote({ noteId, note, addOn = null, unreachableIds = new Set(), resourceRegistry, config, profile, effectiveDate }) {
  const maxAgeDays = verificationMaxAgeDays(profile);
  const matchResources = resourceLookup(profile, resourceRegistry);
  const entry = addOn ?? fallbackEntry(note, profile);
  const matched = [...new Map(matchResources(entry.tools).map((resource) => [resource.name, resource])).values()];
  const candidateKind = classify(profile, entry, matched);
  const confirmed = candidateKind === "Skill"
    ? confirmedSkillResource(matched.map((resource) => resource.raw), { today: effectiveDate, maxAgeDays })
    : null;
  const category = resolveCategoryPolicy({ entry, note, config, profile, entryOrigin: addOn ? "curation" : "content_rule" });
  const actionFields = (profile.resource_index?.actions || []).map((action) => action.field);
  const hasOfficialSource = (resource) => actionFields.some((name) => String(field(resource.raw, name) || "").trim());
  const verified = (tool) => {
    const found = matchResources([tool]);
    return candidateKind === "Skill"
      ? Boolean(confirmed) && found.some((resource) => resource.id === confirmed.id)
      : found.some(hasOfficialSource);
  };
  const tools = [...new Set((entry.tools || []).map((tool) => String(tool).trim()).filter(Boolean))];
  const shown = candidateKind === "Skill" ? matched.filter((resource) => confirmed && resource.id === confirmed.id) : matched;
  return {
    kind: formalContentKind(profile, candidateKind, Boolean(confirmed)),
    tools,
    unverifiedTools: tools.filter((tool) => !verified(tool)),
    resourceNames: shown.map((resource) => resource.name),
    resourceIds: shown.map((resource) => resource.id),
    category: category.category,
    categorySource: category.categorySource,
    categoryReason: category.categoryReason,
    suggestedCategory: category.suggestedCategory,
    sourceBoards: category.sourceBoards,
    themes: category.themes,
    // Only the source-line label reads this (D3): the audit's "unavailable" list, or an add-on that says so.
    postUnreachable: unreachableIds.has(noteId) || addOn?.review_status === "unavailable",
  };
}
```

Remove the imports of `currentFormalRevisions`, `formalCurationDecision`, `isPublishableCuration`, `sealedCandidateFor`. (`entryOrigin: addOn ? "curation" : "content_rule"` is deliberate: an add-on's `category` becomes the category suggestion, and a note with no add-on keeps the content-rule category it has today.)

- [ ] **Step 4: Trim `curation-quality.mjs`**

First prove nothing else uses them: `grep -rn "isPublishableCuration\|hasCompleteAcceptedAudit\|formalCurationDecision\|publicEvidenceStatus\|loadCurationAudit" skills scripts site` must list only the builder, the judgement module and tests. Then delete those five exports and `revisionReason` and the `auditCuration` import, and add the one narrow reader that replaces `loadCurationAudit` (D3; `fs` and `path` are already imported in this file):

```js
// Notes whose post can no longer be opened, as the review audit records them. Only the card's source-line
// label uses this; it never changes a title or text. No audit file configured, or none on disk, means none.
export function loadUnreachableNoteIds(workspace, config) {
  const file = config?.curation_quality?.audit_file;
  if (!file) return new Set();
  let audit;
  try {
    audit = JSON.parse(fs.readFileSync(path.resolve(workspace, file), "utf8").replace(/^﻿/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw new Error(`curation audit could not be read: ${error.message}`);
  }
  return new Set(Object.entries(audit?.notes || {}).filter(([, entry]) => entry?.status === "unavailable").map(([id]) => id));
}
```

Keep `sealedCandidateFor`, `acceptedRevisionsCurrent`, `currentFormalRevisions` (until Task 8), `formalContentKind`, `parseFormalPointSummaryRecord`, `loadFormalPointSummary`. (Reading the audit only when `audit_file` is configured keeps tests off the private folder: a config without it never touches `.xhs-favorites/`.)

- [ ] **Step 5: Rewrite the per-note block of `build-public-site.mjs`**

Arguments: add `damaged: arg("damaged-replies", resolve(workspace, ".xhs-favorites/damaged-diandian-replies.json"))`; delete `--diandian-prompt-version`, `--diandian-report`, `loadDiandianRunStates` and everything that read them, `loadCurationAudit`, `curationQuality`/`curationAudit`/baseline destructuring (replace them with the single line `const unreachableIds = loadUnreachableNoteIds(workspace, config);`, importing it from `./curation-quality.mjs`), the now-unused `tidySpaces`, `displayTitle`, `titleFromText`, `cleanedPostText`'s title use (keep `TITLE_LIMIT`, `cleanedPostText` and `searchTextOf` for the unchanged search link, which still cuts at that limit), `deepSummarySources`, `publicEvidenceStatus`. Then:

```js
import { cardCounts, cardText, cardTitle, postBody, replyState } from "./card-content.mjs";
import { loadExtractedText } from "./extracted-text.mjs";
import { loadDamagedReplies } from "./damaged-replies.mjs";
import { loadFormalPointSummary, sealedCandidateFor } from "./curation-quality.mjs";

const damagedReplies = loadDamagedReplies(paths.damaged);
const notes = Object.entries(rawNotes).map(([noteId, raw], index) => {
  const addOn = Object.hasOwn(curation, noteId) ? curation[noteId] : sealedCandidateFor(sealedCandidates, noteId);
  const verdict = judgePublicNote({ noteId, note: raw, addOn, unreachableIds, resourceRegistry, config, profile, effectiveDate });
  const body = postBody(raw.description);
  // The reply is read whatever prompt version saved it and whichever version of the post it was made for.
  const point = loadFormalPointSummary(paths.diandian, noteId);
  const state = replyState(noteId, point, damagedReplies);
  const text = cardText({ body, point, state, extracted: loadExtractedText(paths.videoAnalysis, noteId, raw.type) });
  const title = cardTitle({ title: raw.title, body, author: raw.author, noteId });
  return {
    id: noteId, number: index + 1, title, author: raw.author || "",
    sourceUrl: publicSourceUrl(searchTextOf(raw) || title, raw.author || ""),
    publishedAt: raw.published_at || "", likes: raw.liked_count || "", collections: raw.collected_count || "",
    mediaType: raw.type || "视频",
    category: verdict.category, categorySource: verdict.categorySource, categoryReason: verdict.categoryReason,
    suggestedCategory: verdict.suggestedCategory, sourceBoards: verdict.sourceBoards, themes: verdict.themes,
    mainText: text.mainText, mainSource: text.mainSource,
    replyDamaged: state === "damaged", postUnreachable: verdict.postUnreachable,
    extracted: text.extractedSection,
    tools: verdict.tools, unverifiedTools: verdict.unverifiedTools,
    kind: verdict.kind, resources: verdict.resourceNames, resourceIds: verdict.resourceIds,
  };
});
```

`meta`: add `...cardCounts(notes)`; delete `verifiedNoteCount`, `videoMethod`. Keep the `forbidden` patterns and private-identifier checks exactly as they are (they now also scan the post text and transcripts). Remove the now-unused `verifiedNoteCount` constant, `frameVerifiedNoteIds`, the `open` import from `node:fs/promises` (only `loadDiandianRunStates` used it) and the `curationRevision` import. Keep `collectVideoEvidenceStats`, `frameEvidenceCount` and `evidenceStatsAutoUpdated`: they feed the unchanged "张可复核画面" counter (`#proof-frames`).

- [ ] **Step 6: Rewrite the old judgement tests and fixtures** (disposition table). `public-judgement-fixtures.mjs` keeps `root hex profile config diandianReplyCases refusalReply normalReply TODAY skillResource note`; delete `PROMPT`, `acceptedSkill`, `pointFile`. Then clear the other users of the deleted functions and fixtures named in the disposition table (`test_curation_standard.mjs`, `stable-curation-rebuild.test.mjs`, `test_organization_contracts.mjs`, `test_formal_outputs.mjs`, `reviewed-evidence-only-rebuild.test.mjs`, `verification-max-age.test.mjs`) and the `test_public_site.mjs` cases Task 6 owns. Before Step 7, `grep -rln "acceptedSkill\|pointFile\|PROMPT" skills/xhs-favorites-organizer/tests` must list no file that still imports them from `public-judgement-fixtures.mjs`.

- [ ] **Step 7: Run**

Run: `node --test skills/xhs-favorites-organizer/tests/faithful-cards-builder.test.mjs skills/xhs-favorites-organizer/tests/public-judgement.test.mjs skills/xhs-favorites-organizer/tests/public-judgement-builders.test.mjs` then `npm.cmd run test:knowledge` and `npm.cmd run test:curation`
Expected: PASS. (`test_public_site.mjs` and `diandian-summary-display.test.mjs` live in `test:site` and read the committed data, so they are run at the end of Step 8, not here.) Fix each remaining failure by the disposition rule, never by loosening an assertion.

- [ ] **Step 8: RUN STEP (real data, read-only on replies, private output) — the frozen list and the data the committed tests read**

```bash
node skills/xhs-favorites-organizer/scripts/damaged-replies.mjs --catalog .xhs-favorites/catalog.json --diandian-dir .xhs-favorites/diandian-summaries --output .xhs-favorites/damaged-diandian-replies.json
```

It prints `{count, ids}`. Record the count and the IDs in the commit body of Task 10 and in the review brief; **do not adjust the signs to change the count** (D1). Expected on today's data: 79 (D1's entry-by-entry reading). If the printed count or IDs differ from D1 (a reply was saved since), do not stop: read the last two lines of each ID that D1 did not cover, state in the brief which look cut, and list the two doubtful IDs from D1 (`…01e252`, `…03930b`) for the owner. Then rebuild the committed data directly (offline, no publish):

```bash
node skills/xhs-favorites-organizer/scripts/build-public-site.mjs --candidates <sealed-candidates.json> --effective-date <today> --output site/data/knowledge.json
```

where `<sealed-candidates.json>` is made by the scratch snippet `Object.fromEntries(Object.entries(bundle.curation).filter(([, entry]) => entry.review_status !== "accepted"))` over the newest `.xhs-favorites/organization-transactions/*-curation-bundle.json`, and the other arguments take the builder defaults (catalog, curation, profile, resources, replies, video analysis, damaged list). Then update `tests/diandian-summary-display.test.mjs` and the `site/data/knowledge.json` readers in `test_public_site.mjs` (lines near 506, 1948, 1975, 2003) to the new fields. Then run `npm.cmd run test:site`. Expected: PASS (no case may be skipped).

- [ ] **Step 9: Commit**

```bash
git add skills/xhs-favorites-organizer/scripts skills/xhs-favorites-organizer/tests site/data/knowledge.json package.json
git commit -m "feat: build each card from its own text; the acceptance gate no longer decides what shows (AC-NOGATE, AC-ADDON)"
```

The commit body carries the damaged-reply count and ID list from Step 8.

---

### Task 7: The snapshot freezes the new inputs and stops freezing the old ones

**Files:**
- Modify: `skills/xhs-favorites-organizer/scripts/build-organization-snapshot.mjs`
- Modify: `skills/xhs-favorites-organizer/scripts/bridge-server.py` (`build_organization_snapshot`, around line 6600–6660)
- Modify: `skills/xhs-favorites-organizer/tests/test_organization_snapshot.mjs`, `web-only-snapshot.test.mjs`, `site-code-in-build-version.test.mjs`, `private-output-short-path.test.mjs`, `tests/test_final_build.py`, `tests/test_no_direct_rebuild.py`, `tests/test_bridge.py`
- Modify: `config/xhs-favorites.example.json`

- [ ] **Step 1: Write the failing tests**

In `test_organization_snapshot.mjs` add (reading the file's existing helpers first, then using them):
1. a build whose frozen input folder receives `damaged-replies.json` when the private file exists, and receives `video-analysis/<id>/transcription.json` and `visual-ocr.json` byte for byte;
2. two builds that differ only in the damaged list get different build versions, and two that differ only in one frozen `transcription.json` do too (both are build inputs);
3. a build with no damaged list file succeeds (the file is optional);
4. the CLI refuses `--diandian-report` and `--diandian-prompt-version` as unknown arguments;
5. `canonicalVersion` (export it from the module) equals the SHA-256 of the exact JSON preimage built in the test with `builders: { public_site: 8 }`, so a silent revert to 7 fails.
6. the audit file named by `config.curation_quality.audit_file` is frozen byte for byte (a note it marks `unavailable` comes out `postUnreachable` in the built data), is optional (a build with the key absent, or the file missing, succeeds), and a build whose only change is that file's content gets a different build version; a `baseline_file` key is ignored and never captured.

In `test_final_build.py` / `test_no_direct_rebuild.py` extend the existing assertions on the snapshot command: it contains no `--diandian-report` and no `--diandian-prompt-version`, and contains `--damaged-replies <state>/damaged-diandian-replies.json` only when that file exists.

- [ ] **Step 2: Run them and see them fail**

Run: `node --test skills/xhs-favorites-organizer/tests/test_organization_snapshot.mjs` and `python -m unittest discover -s skills/xhs-favorites-organizer/tests -p "test_final_build.py"`
Expected: FAIL on the new assertions only.

- [ ] **Step 3: Implement**

`build-organization-snapshot.mjs`:
- `canonicalVersion` (line 22, currently not exported): change it to `export function canonicalVersion(...)` so the new test can import it, and set `builders: { public_site: 8 }`.
- `captureBuilderInputs`: remove `report` from `fixed` and from the `Promise.allSettled` list; remove `promptVersion` handling and the `diandian-prompt-version` input; in the `quality.publish_only_accepted` block, drop the baseline capture and the condition, and keep the audit as an optional input read only for the unreachable label (D3): `if (typeof quality.audit_file === "string" && quality.audit_file) inputs.push(await boundedFile(root, resolve(root, quality.audit_file), "audit_file", { optional: true }));`; add `boundedFile(root, damagedPath, "damaged-replies", { optional: true, maxBytes: 1024 * 1024 })` where `damagedPath` is `options.damagedReplies ? resolve(options.damagedReplies) : null` (skip when null); inside the per-note loop add, for 24-hex ids, `boundedFile(root, join(noteDirectory, "transcription.json"), `transcript:${noteId}`, { optional: true, maxBytes: 4 * 1024 * 1024 })` and the same for `visual-ocr.json` as `picture-text:${noteId}`.
- `materializeCapturedInputs`: write `damaged-replies` to `paths.damaged = join(inputRoot, "damaged-replies.json")` when present; write `transcript:` and `picture-text:` entries into `video/<id>/transcription.json` and `visual-ocr.json`; delete the `report` and `baseline` paths and the `publish_only_accepted` condition, and replace that branch with: when `config.curation_quality?.audit_file` is a string, point it at `paths.audit` and write the frozen `audit_file` entry there (if the file was missing the entry is not written and the loader treats the missing path as "none"); drop `baseline_file` from the frozen config; return `damaged` (empty string when absent) and drop `promptVersion`.
- `cliArgs`: `required` loses `diandian-report`; `optional` becomes `["resources", "damaged-replies"]`.
- `runCli`: pass `damagedReplies` into `captureOptions`; `buildPublicSite` passes `["--damaged-replies", frozen.damaged]` when set and no longer passes `--diandian-report` or `--diandian-prompt-version`.

`bridge-server.py` `build_organization_snapshot`: delete the `--diandian-report` pair and the `if self.diandian_skill_path is not None:` block that adds the prompt version; add

```python
        damaged_replies = self.state_dir / "damaged-diandian-replies.json"
        if damaged_replies.is_file() and not path_is_reparse_point(damaged_replies):
            command.extend(["--damaged-replies", str(damaged_replies)])
```

Leave `self.diandian_report_path` alone (other code still writes the report); leave `diandian_prompt_version()` alone (record validation uses it).

`config/xhs-favorites.example.json`: remove `"publish_only_accepted": true,` and `"baseline_file": ...,` from `curation_quality` (keep `audit_file`, `scope_file`).

- [ ] **Step 4: Run**

Run: `npm.cmd run test:knowledge` then `npm.cmd run test:organization` then `python -m unittest discover -s skills/xhs-favorites-organizer/tests -p "test_*.py"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/xhs-favorites-organizer config/xhs-favorites.example.json
git commit -m "feat: freeze the damaged-reply list and extracted text in the snapshot; drop the report and prompt-version inputs"
```

---

### Task 8: Trim the curation layer (spec §7, second paragraph, except the curated-skip rule: D13)

**Files:**
- Trim: `scripts/merge-curation-results.mjs`, `scripts/prepare-curation-review.mjs`, `scripts/curation-revision.mjs`, `scripts/curation-quality.mjs` (`currentFormalRevisions`)
- Trim: `scripts/bridge-server.py` (evidence assembly in `run_curation_pipeline` only)
- Update: `tests/test_curation_standard.mjs`, `tests/test_bridge.py`, `tests/exact-file-identity.test.mjs`, `tests/image-text-evidence-required.test.mjs`
- All paths relative to `skills/xhs-favorites-organizer/` unless shown.
- **Not touched (D13):** the curated-skip rule and its switch: `scripts/transcribe-pending-videos.py`, `scripts/extract-pending-frames.py`, `scripts/run-video-analysis.ps1`, `media_urls_to_cache` and its caller in `scripts/bridge-server.py`, `tests/test_review_include_curated.py`, `test-fixtures/include-curated-review/`, and the curated-skip cases in `tests/test_transcription_pipeline.py`, `tests/test_media_queue.py`, `tests/test_frame_extraction.py`. The owner's ruling (spec §2, "Only when needed") and §5.1 mean the rule must stay until the reader-engine trigger exists (Slice B).

Each removal below is its own RED → GREEN step; do them in this order, running the named command after each, one commit at the end.

- [ ] **Step 1: Review-packet hash binding.** RED: in `test_curation_standard.mjs` replace the packet-binding cases with one case asserting that a review item carrying no `review_packet_sha256` merges, and that `prepareReview` output has no `review_packet_sha256` key. Run `node --test skills/xhs-favorites-organizer/tests/test_curation_standard.mjs`, see them fail. GREEN: delete `reviewPacketRevision` from `curation-revision.mjs`; delete `requirePacketBinding`, `expectedReviewPacket` and the three packet `throw`s from `mergeResults`; delete `item.review_packet_sha256 = ...` in `prepareReview`; remove their imports. Re-run, PASS.
- [ ] **Step 2: The frozen prompt version as a merge input.** RED: assert `mergeResults` and `prepareReview` ignore a missing `expectedPromptVersion`, that the CLIs accept no `--diandian-prompt-version`, and that `currentFormalRevisions(note, entry, resource)` takes three arguments. GREEN: remove the parameter and its checks from `mergeResults`, `prepareReview` (`readDiandianSummary` calls `parseFormalPointSummaryRecord(record, noteId)` with no version; its first line, `!HASH.test(expectedPromptVersion)` returning `""`, and the version check near line 232 of `prepareReview` go too, or no reply would ever be read once the argument is gone), both `main()` argument lists (`prepare-curation-review.mjs` drops `diandian-prompt-version` from its required list), and `currentFormalRevisions` (drop the `pointDependencies` version check). Run the same file plus `exact-file-identity.test.mjs` and `image-text-evidence-required.test.mjs`.
- [ ] **Step 3: The two evidence exceptions in the bridge.** RED in `test_bridge.py`: an accepted audit that never listed a saved reply still gets that reply as a `diandian_summary` method in the evidence it sends to the curation pipeline; an early-format `transcription.json` (status only, no `result_sha256`) contributes no method. GREEN in `run_curation_pipeline`: delete `sealed_early_transcripts`, the `audit_used_summary` block and the `point = None` line, and the `result_sha256 is None and filename == "transcription.json" ...` branch. Run `python -m unittest discover -s skills/xhs-favorites-organizer/tests -p "test_bridge.py"` and `-p "test_organization_pipeline.py"`.
- [ ] **Step 4: Prove the kept behaviour did not move, then commit.** Nothing in this task touches the curated-skip rule (D13). Run `git diff --stat 1a9ef29 -- skills/xhs-favorites-organizer/scripts/transcribe-pending-videos.py skills/xhs-favorites-organizer/scripts/extract-pending-frames.py skills/xhs-favorites-organizer/scripts/run-video-analysis.ps1 skills/xhs-favorites-organizer/tests/test_review_include_curated.py skills/xhs-favorites-organizer/tests/test_media_queue.py skills/xhs-favorites-organizer/tests/test_transcription_pipeline.py skills/xhs-favorites-organizer/tests/test_frame_extraction.py` (`1a9ef29` is the spec commit the branch started from). Expected: no output (all seven files untouched by Tasks 1–8).

Run: `npm.cmd run test:curation` then `python -m unittest discover -s skills/xhs-favorites-organizer/tests -p "test_*.py"` then `npm.cmd run test:organization`
Expected: PASS, including `test_review_include_curated.py` and the curated-skip cases, unchanged.

```bash
git add -A skills/xhs-favorites-organizer
git commit -m "refactor: remove packet-hash binding, prompt-version merge input and the curation-layer evidence exceptions"
```

(Also in this task's commit, nothing touches `curation_agent`: it exists only in the private config and is removed in Task 10.)

---

### Task 9: One rule in every document (spec §7, last paragraph)

**Files (all under the repository root):**
- Modify: `skills/xhs-favorites-organizer/SKILL.md`, `skills/xhs-favorites-organizer/references/curation-standard.md`, `references/automatic-workflow.md`, `references/organization-schema.md`, `CONTEXT.md`, `README.md`, `CHANGELOG.md`, `docs/ARCHITECTURE.md`, `docs/PUBLISHING.md` (only where they quote the retired rules)
- Update: `skills/xhs-favorites-organizer/test-fixtures/task-11-documentation-contract.json` and `skills/xhs-favorites-organizer/tests/test_curation_standard.mjs` (the only test that reads it)
- Create: `skills/xhs-favorites-organizer/tests/faithful-cards-docs.test.mjs` (add to `test:curation` in `package.json`)
- Modify: `package.json`
- Move: `docs/plans/2026-08-22-favsense-end-to-end-organization-recovery-plan.md` → `docs/plans/archive/` with `git mv`, first line marked `> Superseded by docs/specs/2026-10-14-favsense-faithful-cards-spec.md` (file-govern: archive, never delete)

- [ ] **Step 1: Write the failing test** (`faithful-cards-docs.test.mjs`): read the six documents and assert that each retired statement is gone and each new statement is present.

Retired (must not appear): in `SKILL.md` — the sentence at line 158 `只有 \`accepted\` 条目可以写入正式 curation 与公开站点；\`pending\` 必须说明缺失证据且不得发布`, the clause at line 14 `公开 \`confirmed Skill\` 必须是 accepted，并且恰好关联`, the sentence at line 78 that says the frozen `prompt_version` is passed to the web builder (`并把已验证 DianDian Skill 合同的冻结 \`prompt_version\` 传给网页 builder` and `不要直接运行缺少该值的底层 builder，否则含点点证据的正式总结会安全降级`) together with the `$promptVersion` line and the `--diandian-prompt-version $promptVersion` argument of the `build-public-site.mjs` example (lines ~83–86), and the sentence at line 158 about the pending-review overlay and raw DianDian records (below). **Kept, not retired:** the `-IncludeCurated` paragraph at line 134 (and its twin in `automatic-workflow.md` line 40), because the curated-skip rule stays (D13), and the line 113 sentence about 搜索原帖 (LINK-02 is not decided); `CONTEXT.md` — "笔记按审核条目显示时，就是审核条目自己的 `title`" and "已通过审核的笔记只使用审核过的字段"; `README.md` and `curation-standard.md` — any sentence that says a card shows its text only after `accepted`, `证据未补齐，暂不发布`, `publish_only_accepted`, `published-baseline` as a display gate, or `--diandian-prompt-version` / `--diandian-report` on the merge, review, snapshot or public-site commands (`curation-standard.md` lines ~129, ~150 and the paragraph at ~154 that says a missing or mismatched `prompt_version` demotes DianDian text and "一律降级，不得发布"; the Bridge keeps using the prompt version to validate records it saves, but no document may say it gates what a card shows). `README.md` line ~176 says the home page shows "收录数、深度解读数、可复核画面数和资源数": rewrite it to the CARD-09 counts (收录数、有完整点点总结数、有视频转写数、可复核画面数、资源数). Run `grep -n "accepted\|pending_review\|证据未补齐\|publish_only_accepted\|baseline\|IncludeCurated\|prompt.version" <each document>` to find them all and list the hits you changed in the commit body.

Replacements to write (assert each is present): `SKILL.md` line 14 — `公开 confirmed Skill 恰好关联一个当前、完整、已核验的官方资源` (the Skill marker rule of spec §5.2, without "accepted"); line 158 — `审核通过（accepted）的条目写入正式 curation，作为卡片的可选附加信息；卡片本身不受审核状态控制`. Also in line 158 retire `本机可通过鉴权的待审核 overlay 查看清理后的 captured 证据` (the card overlay is gone, decision D9) and `公开站不得直接消费 raw 点点记录`; replace the latter with `公开卡片展示点点回复原文（只去掉开头的对话语句），不展示其记录里的其他字段`. Do the same for any README sentence that describes the pending-review overlay (`grep -n "overlay\|待审核" README.md`).

New (must appear): `SKILL.md` — a paragraph stating that every card is built by the deterministic card step, that the curation file/sealed candidate is an optional add-on that adds topics, tools, category suggestion and content kind but never title or main text, and that the DianDian rule "任一失败都必须放弃当前及剩余点点计划并停止" is **unchanged until Slice B**; `CONTEXT.md` — **公开判定** redefined as "category, kind, resources and tools for a card; it does not decide whether the card is shown in full", **卡片标题** as "the post's own title, else the first line of the post text, else the author's collection (no reviewed title)", **搜索原帖文字** unchanged; `automatic-workflow.md` and `organization-schema.md` — the new public card fields from Task 5.

**Documentation contract fixture (`test-fixtures/task-11-documentation-contract.json`, read by `tests/test_curation_standard.mjs` lines ~181–200).** It pins exact sentences as `required_phrases`, and several of them are the statements this task retires. Replace each in the same edit as its document, with the new sentence written in Step 3 (same file, same key), never by deleting the key: `SKILL.md` phrase 3 (`公开 \`confirmed Skill\` 必须是 accepted，并且恰好关联…`); `README.md` phrases 2 and 3 (the pending-review overlay sentence and the `confirmed Skill` sentence); `curation-standard.md` phrase 2 (`…还必须通过 accepted/current/resource 门`); `organization-schema.md` phrase 1 (`…未满足 accepted/current/resource 门…只有 accepted 且恰好关联一个 fresh verified resource 时才是 confirmed Skill`); `automatic-workflow.md` phrase 5 (`\`accepted\` 才能进入公开页面`); `docs/ARCHITECTURE.md` phrases 2 and 4 (`…唯一 acceptance decision…`, `…只有在 accepted 且恰好一个 fresh verified resource 时才提升为 confirmed Skill`); `docs/PUBLISHING.md` phrase 1 (`只有通过 current curation 与 accepted audit 的正式摘要可以进入；captured/pending 证据只留在本机 overlay。`). The new wording for the Skill marker is the one in the SKILL.md replacement above (恰好关联一个当前、完整、已核验的官方资源, no "accepted"). Public cards no longer carry `candidateKind` (Task 5 field list), so wherever a replaced sentence says the builder "outputs" or "额外输出" `candidateKind`, reword it as: a keyword match only makes a Skill candidate in the curation layer, and the card's kind is `Skill` only with exactly one verified resource. The `captured / pending / accepted / failed / batch_aborted` status definitions (SKILL.md phrases 1–2, `automatic-workflow.md` phrases 1–2, `curation-standard.md` phrase 1) describe the curation layer and the run, which remain, so they stay.

- [ ] **Step 2: Run it and see it fail**

Run: `node --test skills/xhs-favorites-organizer/tests/faithful-cards-docs.test.mjs`
Expected: FAIL on the retired statements. (Also update the SKILL.md example case of `tests/test_curation_standard.mjs`, lines ~40–58, in this step: the assertions on `不要直接运行缺少该值的底层 builder` and on `--diandian-prompt-version $promptVersion` / `$promptVersion = "<` become "absent"; keep the assertions on `正式网页数据只由快照步骤写入` and `“仅本地重建”`.)

- [ ] **Step 3: Edit the documents**, replacing each retired statement with the new one (do not leave both). `CHANGELOG.md` gets one entry under the unreleased heading summarising the user-visible change: cards show the post's own title and full text, no held cards, honest home counts. `docs/ARCHITECTURE.md` and `docs/PUBLISHING.md`: change only the sentences the grep finds.

- [ ] **Step 4: Run**

Run: `node --test skills/xhs-favorites-organizer/tests/faithful-cards-docs.test.mjs skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs skills/xhs-favorites-organizer/tests/open-original-docs.test.mjs` then `npm.cmd run test:curation` (it runs the documentation contract and the SKILL.md example case) then `npm.cmd run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A README.md CHANGELOG.md CONTEXT.md docs skills/xhs-favorites-organizer package.json
git commit -m "docs: one card rule everywhere; archive the superseded plan"
```

---

### Task 10: Production-path rebuild, real-data runs, archiving, and the final checks (RUN STEPS; nothing here is committed except the rebuilt data and `TODOS.md`)

**Files:**
- Modify: `site/data/knowledge.json` (rebuilt through the production snapshot path)
- Modify: `TODOS.md` (follow-ups)
- Private, never committed: `.xhs-favorites/damaged-diandian-replies.json`, `.xhs-favorites/archive-2026-10-14/`, `config/xhs-favorites.json`

All steps run against the real workspace by the run itself (no browser, no Xiaohongshu contact). Tests never do this.

- [ ] **Step 1: Write the follow-ups into `TODOS.md`**, one line each in the project's entry shape:
  - `- [ ] Delete the bridge endpoint /notes/organization-status and validateLocalNoteOrganizationStatus in site/local-bridge-utils.mjs (the card overlay that used them is gone) — closes when no code or test references either — written by the faithful-cards run, 2026-10-14`
  - one line per Slice B item named at the end of this plan, each with its closing condition ("closes when the captcha hold clears and the owner agrees a time for the watched run").

- [ ] **Step 2: Regenerate the damaged list** (idempotent; same command as Task 6 Step 8). Compare the printed IDs with the Task 6 commit body: identical unless a reply was saved in between. Report the count; do not tune.

- [ ] **Step 3: Archive the agent-written card texts first** (copy, not move): write `.xhs-favorites/archive-2026-10-14/agent-written-card-texts.json` holding `{id, title, summary, action}` of every curation-file entry whose note has **no** complete reply (`loadFormalPointSummary` returns null, or the reply is on the damaged list). The expected count is about 105 (spec §7); print it.

- [ ] **Step 4: Move the hand-made batch files and private scripts** into `.xhs-favorites/archive-2026-10-14/` (a `git`-ignored folder; moves only, nothing deleted). First print the dry-run list and save it; then move exactly these top-level files: `agent-batch-*`, `pending-*`, `rejected-*`, `new-notes-*`, `rereview-*`, `refusal-rereview-*`, `issue79-*`, `issue86-*`, `issue87-*`, `latest-note-*`, `unavailable-final-review.json`, `final-*`, `curation-agent-*`, `diandian-fallback-review.json`, `remaining-evidence-plan.json`, `all-notes-scope.json`, and the five scripts `build-agent-batch.mjs`, `bridge-prompt-version.py`, `issue86-local-rebuild.py`, `rebind-agent-review.mjs`, `registry-add.mjs`. **Keep in place:** `catalog.json`, `curation-audit.json`, `curation-baseline.json`, `curation-candidates.json`, `curation-quality-report.json`, `curation-request.json`, `curation-review.json`, `curation-scope.json`, `published-baseline.json`, `diandian-rerun-report.json`, `manual-sync.json`, `local-rebuild.json`, `bridge-status.json`, `bridge-token` (not `bridge-*`: `bridge-prompt-version.py` is one of the five scripts that move), `media-download-safety-stop*.json`, `software-resources.before-*`, every directory, and `damaged-diandian-replies.json`. The expected move count is about 209 (the planner counted 204 data files and 5 scripts on 2026-10-14, 89 of them `agent-batch-*`); any other top-level file (status files, lock files, logs, images, `xhs-favorites.user.js`, `live-diandian-reply.txt`) matches none of these names and stays. Nothing in the repository reads any moved name (searched 2026-10-14); `curation-standard.md` shows `diandian-fallback-review.json` only as an example output path. Step 5 spells out its own driver, so moving `issue86-local-rebuild.py` first is safe.

- [ ] **Step 5: Production-path rebuild without publishing.** Call the bridge's own method from a scratch driver in the session scratchpad. Load `skills/xhs-favorites-organizer/scripts/bridge-server.py` with `importlib.util.spec_from_file_location`, construct `module.Bridge(workspace, workspace / "skills" / "xhs-favorites-organizer", workspace / "config" / "xhs-favorites.json", workspace.parent / "SOP - 小红书", 47631)` (the same arguments the private `issue86-local-rebuild.py` uses; no browser is opened and no request leaves the machine), then make a batch id of its own (`batch = "faithfulcards" + <YYYYMMDDHHMMSS>`, which fits the 80-character run-id pattern) and the full scope, and call the two steps the bridge's own `run_final_build` runs before it publishes: `note_ids = bridge.local_rebuild_scope()`, then `bridge.run_curation_pipeline(batch=batch, note_ids=note_ids)`, then `bridge.build_organization_snapshot(batch=batch, note_ids=note_ids)`. Do **not** call `trigger_local_rebuild()`, which would also publish, and do **not** pass the newest batch in `manual-sync.json` (`manual20261013025553339527`) to `build_organization_snapshot`: that round's sealed scope is 207 notes, the snapshot compares it with the 377 in the catalog and stops with `SNAPSHOT_SCOPE_DIGEST_MISMATCH` (checked 2026-10-14: the newest curation bundle's `scope.note_ids` has 207 entries). The curation step writes `<batch>-curation-input.json` and `<batch>-curation-bundle.json` under `.xhs-favorites/organization-transactions/` (private, ignored by git, no platform contact), exactly as a local rebuild does. The snapshot then runs `build-organization-snapshot.mjs` and swaps `site/data/knowledge.json` atomically with a real `buildVersion`. Every later re-run (Step 7) uses a new batch id. Then `git diff --stat site/data/knowledge.json`.

- [ ] **Step 5a: Real-data check of the four mockup cards and the counts** (a scratch script reading the rebuilt `site/data/knowledge.json`; prints values only, never private text). Expected, from the spec and the mockup: note `6a7dc92600000000250090ff` has `mainSource "diandian"` and title `一个人，3天，Codex，10W`; `6a44938c0000000006021e9e` has `mainSource "post-text"` and `replyDamaged true`; `6ab3dfdc00000000140023f9` has `mainSource "diandian"`, `replyDamaged false` and `kind` `Tool` (not `Skill`; its sealed candidate says `Skill` but names no verified resource) — its `tools` list is expected to be **empty**, because the real sealed candidate and the curation bundle entry for this note both have `tools: []`, so the mockup's `Seedance 导演 Skill · 未核实` chip is an illustration of the badge (proved by the fixture card, builder test 5 and Playwright test 5), not a value the real data produces; `6a2a81d1000000001702d3de` has `mainSource "video-transcript"`. Also print: the number of cards (expected 377), the number with `postUnreachable true` (expected 3, spec §3.1: the three ids the audit file marks `unavailable`, via D3; the run must have `config.curation_quality.audit_file` still set, so Step 7 keeps that key), counts by `mainSource`, `meta.replyCount` and `meta.transcriptCount`, the number of cards with an empty `mainText` (expected **0**), and the number of cards with `mainSource "diandian"` and `replyDamaged true` (a read-only simulation at audit pass 3 gave 13, all with a tags-only post and no usable transcript; printed, not asserted). The same simulation gave about 196 complete replies and 103 video transcripts shown; those two are printed for the brief, not asserted. A transcript is shown only when its text matches its own hash after whitespace is flattened (D4), so if the fourth card is not a `video-transcript`, or the unreachable count is not 3, or any card has an empty `mainText`, **stop and report it with the printed numbers; do not change the card rules to make the numbers match**.
- [ ] **Step 6: AC-NOGATE on real data, on copies.** Copy `catalog.json`, `diandian-summaries/`, `video-analysis/` transcript files, the damaged list, the curation file and the sealed candidates into a scratch folder. Build twice with `build-public-site.mjs`: once with the curation file and candidates, once with both replaced by `{}` and no audit or report (pass `--config` a scratch copy of `config/xhs-favorites.json` in both builds, and delete its `curation_quality` block for the second one; the builder's default config would otherwise still point at the real audit file). Compare every card's `title`, `mainText`, `mainSource`. Expected: 377 cards, zero differences. Save the one-line result for the brief.

- [ ] **Step 7: Private config cleanup.** In `config/xhs-favorites.json` remove the unread `curation_agent` block and the `curation_quality.publish_only_accepted` and `baseline_file` keys (keep `audit_file` and `scope_file`: the audit file is what marks the 3 unreachable posts, D3) (the private config is git-ignored; back it up to `.xhs-favorites/archive-2026-10-14/xhs-favorites.config.before.json` first). Then re-run Step 5 and confirm it still builds and that every card's `title`, `mainText` and `mainSource` equals the Step 5 result; commit the data from this last run.

- [ ] **Step 8: Full gates**

Run: `npm.cmd run release:check`
Expected: exit 0 (check:syntax, lint:a11y, npm test, test:organization, test:python, test:e2e on desktop and phone, verify).

- [ ] **Step 9: Commit**

```bash
git add site/data/knowledge.json TODOS.md
git commit -m "data: rebuild the site data with faithful cards; record follow-ups"
```

After merge the run does what the pipeline's later steps own: local rebuild and publish once from a frozen snapshot, then the live check of the cards against `docs/designs/2026-10-14-card-design-rewrite.html` using the verification checklist.

---

## Not in this plan — Slice B (needs Xiaohongshu contact; starts only at a time the owner agrees)

- CAP-01 watched DianDian run comparing the three copies of one reply.
- CAP-02 character-for-character check on save; CAP-03 three attempts then "点点未取得" and move on; CAP-04 unchanged safety stop; CAP-05 re-fetch of the damaged replies listed in the frozen file (the list and the card's handling of it are Slice A; the re-fetch is not).
- LINK-01 live test of `/explore/<id>`; LINK-02 and LINK-03 (button label and the public-tree ban on `/explore/<id>`, `/discovery/item/<id>`). **LINK-02's code is conditional on that live test: the search button behaviour stays and `public-tree-policy.mjs` is not changed here.**
- COMP-01 per-folder "已采集 N / 收藏夹共 M".
- §5.1 reader-engine trigger (download and transcribe only for notes recorded "点点未取得") and replacing the D6 source-line openings with the "3 次" wording.
- **Removal of the curated-skip rule and its switch** (spec §7, second paragraph; moved here from Slice A by D13): delete `include_curated` and the `reasons[note_id] = "curated"` branches in `transcribe-pending-videos.py` and `extract-pending-frames.py`, `[switch]$IncludeCurated` in `run-video-analysis.ps1`, `curated_ids` in `media_urls_to_cache` (`bridge-server.py`), `tests/test_review_include_curated.py` with its fixture folder, the curated-skip cases of the three Python queue tests, and the `-IncludeCurated` sentences in `SKILL.md` (line 134) and `references/automatic-workflow.md` (line 40). **Closes only together with the §5.1 trigger**: that is what makes downloads happen "only when needed" without the skip.
- The `SKILL.md` rule "任一失败都必须放弃当前及剩余点点计划并停止" stays until the CAP work replaces it.
- Existing notes regain paragraphs only when their details are next fetched (CAP-06's platform half).

---

## Coverage: every behaviour has a task and a check

| Spec item | Task | Check |
|---|---|---|
| CARD-01 | 5, 6 | Playwright test 1; builder test 16 |
| CARD-02 | 3, 6 | `card-content` title tests; builder test 1; Playwright test 2 |
| CARD-03 | 3, 5, 6 | builder test 2; Playwright test 3 |
| CARD-04 | 3, 4, 5, 6, 10 | builder tests 3 and 18 (cut reply as the only text, D10); Playwright tests 4 and 18; Task 10 Step 5a (zero empty cards on real data) |
| CARD-05 | 5, 6 | builder test 5; Playwright test 5 |
| CARD-06 | 3, 5, 6 | builder test 7; Playwright test 6 |
| CARD-07 | 3, 5, 6 | builder test 8; Playwright test 7 |
| CARD-08 | 1, 3, 5, 6 | `test_post_text_paragraphs.py`; builder test 10; Playwright test 8 |
| CARD-09 | 3, 5, 6 | `cardCounts` test; builder test 11; Playwright test 11 |
| AC-NOGATE | 6, 10 | builder test 13; Task 10 Step 6 on real copies |
| AC-ADDON | 6 | builder test 14 |
| AC-PARA | 1 | `test_post_text_paragraphs.py` |
| AC-CARD | 5 | `faithful-cards.spec.mjs` on desktop and phone projects |
| §3 / §3.1 | 3, 5, 6 | above |
| §5.2 add-on | 6 | builder tests 5, 6, 12, 14 |
| §6.3 counts | 3, 5, 6 | CARD-09 rows |
| §7 card path removal | 5, 6 | builder test 16; `grep` in Task 6 Step 4 |
| §7 curation-layer removal | 7, 8, 10 | Task 7 and 8 tests; Task 10 Step 7. **Except** the curated-skip rule and its switch: kept (D13), listed under Slice B; Task 8 Step 4 proves the files are untouched |
| §7 archiving | 10 | Steps 3–4 (counts printed, moves not deletes) |
| §7 documents | 9 | `faithful-cards-docs.test.mjs` |
| Frozen damaged list | 4, 6, 10 | `damaged-replies.test.mjs`; printed count and IDs |
