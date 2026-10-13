# Audit Log — 2026-10-14-favsense-faithful-cards

Started: 2026-10-14T07:04:34
Branch: feat/faithful-cards

## Pipeline notes

- Tier 1 drift override: superpowers detection failed at all canonical paths (installed as a plugin); owner confirmed availability at runtime ("Continue").
- Prereq 1.a.3 auth probe returned HARD BLOCK (no saved login); FavSense has no login. Owner approved the exception ("Carry on, tests on"); tracked in TODOS.md. INCLUDE_E2E=true.
- Dev server: preview on 8779 (8766-8768 belong to the Playwright fixture server). Baseline e2e before any code change: 110 passed.
- PIPELINE_PRE_SHA=1a9ef293f2779351d8cba1aaff9e2ab1c1a8b483. Range how..brief (spec already approved; step 1 not run). MODEL_PROFILE=default.

---

## Step 2 — HOW (plan audit)

Artifact: docs/plans/2026-10-14-favsense-faithful-cards-plan.md
Skill: /writing-plans (audit mode)
Precheck: spec-testability-precheck ok

### Pass 1

**Issues fixed (11)**
- **Critical** — The plan removed the rule that media download and transcription skip curated notes (Task 8 Step 4, file map, disposition table, Task 9 retired-statement list, checklist V-P3-21). In Slice A that would make the owner's next sync queue downloads for every previously curated note, against his ruling "Only when needed" (spec §2) and §5.1 (reader engine only for notes recorded "点点未取得").
  → Removal moved out of Slice A: new decision D13; risk (1) rewritten; Task 8 files list, Step 4 (now a proof that the seven files are untouched, `git diff --stat 1a9ef29`) and commit message changed; file-map rows and disposition rows say the rule, its tests and `-IncludeCurated` stay; Task 9 no longer retires the `-IncludeCurated` paragraphs (SKILL.md line 134, automatic-workflow.md line 40); the removal is listed under "Not in this plan — Slice B", tied to the §5.1 trigger; coverage row annotated; checklist V-P3-21 now asserts the skip is still in force.
  Completeness: 9/10  Confidence: 9/10
- **Medium** — Task 9 would break the documentation contract test: `task-11-documentation-contract.json` pins, as required phrases, sentences the task retires (SKILL.md "confirmed Skill 必须是 accepted", README overlay sentence, ARCHITECTURE/PUBLISHING/organization-schema/automatic-workflow/curation-standard accepted-gate sentences). The plan said only "update the fixture".
  → Task 9 now lists each pinned phrase by file and number, requires replacing it in lock-step with the new wording (keys kept), keeps the still-true status definitions, adds the `candidateKind` rewording, adds `test_curation_standard.mjs` to the files list and `npm.cmd run test:curation` to Step 4.
  Completeness: 9/10  Confidence: 9/10
- **Medium** — SKILL.md line 78 and the `build-public-site.mjs` example (lines ~83–86) and curation-standard.md (~129, ~150, ~154) teach passing the frozen `prompt_version` to the web builder and say a mismatch demotes DianDian text; Task 6/7 make the builder ignore it, and `test_curation_standard.mjs` lines ~40–58 assert those very sentences. The retired list only covered "merge/review commands".
  → Retired list extended (SKILL.md 78 and example, curation-standard lines, `--diandian-report`); the SKILL.md example case of `test_curation_standard.mjs` is rewritten in Task 9 Step 2 (disposition row added).
  Completeness: 9/10  Confidence: 9/10
- **Medium** — Task 10 Step 4 kept `bridge-*` in place while also moving `bridge-prompt-version.py` (one of the five scripts): the two lists collided (checked against the 242 top-level files; also checked that nothing in the repository reads any moved name).
  → Keep list names `bridge-status.json` and `bridge-token`; move count corrected to about 209 (204 data files + 5 scripts); checklist V-P1-05 and V-P1-06 aligned.
  Completeness: 9/10  Confidence: 9/10
- **Medium** — No real-data check that the four mockup cards come out as drawn, that exactly 3 cards are unreachable, or that real transcripts survive the integrity check (D4 admits a flattened-whitespace limit that could hide the case-④ transcript); the live check would have been the first to find out.
  → New Task 10 Step 5a (print-only scratch check with expected values, stop-and-report rule, no tuning); new checklist row V-P3-27 and coverage entries.
  Completeness: 8/10  Confidence: 8/10
- **Medium** — Task 7's new test imports `canonicalVersion`, which is a private function in `build-organization-snapshot.mjs` (line 22); Step 3 only said to change its value.
  → Step 3 now says to export it.
  Completeness: 10/10  Confidence: 10/10
- **Medium** — `tests/accepted-text-quality.test.mjs` imports `hasCompleteAcceptedAudit` (deleted in Task 6) and also uses it in a case that is not the last one ("an accepted entry with no action passes, and is published"); the disposition row only mentioned the last case, so Task 6's commit would not be green.
  → Row rewritten (Task 6 owns it; assertion at line ~150 removed, case renamed, import removed).
  Completeness: 9/10  Confidence: 9/10
- **Low** — Task 6 builder rewrite left loose ends unsaid: unused `open`, `curationRevision`, `frameVerifiedNoteIds`; `evidenceStats` must stay for `#proof-frames`; `test:site` (home of `test_public_site.mjs` and `diandian-summary-display.test.mjs`) was never run in Task 6.
  → Step 5 lists what to delete and what to keep; Step 8 ends with `npm.cmd run test:site` (explicitly after the data-reading cases are updated).
  Completeness: 9/10  Confidence: 9/10
- **Low** — Disposition table paths were ambiguous (`tests/…` vs root `scripts/…`), and its `test_organization_snapshot.mjs` row omitted the audit/baseline-capture cases (lines ~292, ~328) that Task 7 invalidates.
  → One sentence defining the path roots; row extended.
  Completeness: 9/10  Confidence: 9/10
- **Low** — README line ~176 still describes home-page counts as "深度解读数", contradicting CARD-09 after Task 5; the Task 9 grep would not find it.
  → Added to the Task 9 retired list with the replacement wording.
  Completeness: 9/10  Confidence: 8/10
- **Low** — Task 4 said the `isBare` rename touches "two internal callers"; there are four uses inside `headingText`.
  → Wording corrected so the rename leaves no stale name.
  Completeness: 10/10  Confidence: 10/10

**Auto-accept decisions (4)**
- Spec §7 (approved) lists the curated-skip removal under Slice A, which conflicts with the owner's own rulings in §2 and §5.1 and with the orchestrator's finding.
  → Auto-accepted: follow the rulings and defer the removal to Slice B (decision D13); the approved spec text is not edited — the deferral is recorded in the plan and checklist.
  Completeness: 9/10  Confidence: 8/10
- The mockup's case ① source box ends "共 N 字。", while the live wording (kept by the plan) continues "；按小标题与列表排版。".
  → Auto-accepted: keep the live sentence approved in #99; the mockup is authoritative for structure, placement and behaviour, and the Playwright assertion is a substring match that holds either way.
  Completeness: 8/10  Confidence: 8/10
- Whether Task 8 should add a new pinning test for the kept curated-skip behaviour.
  → Auto-accepted: no new test; the existing Python tests already pin it and Task 8 Step 4 proves they are untouched and green.
  Completeness: 9/10  Confidence: 8/10
- Whether the contract-fixture phrases may be deleted instead of replaced.
  → Auto-accepted: replace in the same edit, keep every key, so the documents stay under the same contract.
  Completeness: 9/10  Confidence: 9/10

### Pass 2

**Issues fixed (8)**
- **Critical** — The "unreachable post" label (spec §3.1, last paragraph; checklist V-P3-13) had no data source. D3 read `review_status === "unavailable"` from the add-on, but on the real data the three posts the audit file marks `unavailable` (`6a1fd8a2…ff7a`, `69de08cd…0efd`, `6a1f1198…6d34`) are in neither the curation file, the sealed candidates (`review_status` absent) nor the newest curation bundle. As written all three would have lost the label, and Task 10 Step 5a (expects 3) would have stopped the overnight run. The same change would also have dropped the audit file from the snapshot, so no frozen build could ever see the fact.
  → D3 rewritten: the builder reads only the audit's `unavailable` list (new `loadUnreachableNoteIds`, replacing `loadCurationAudit`; empty when `config.curation_quality.audit_file` is unset or the file is missing) and also honours an add-on `review_status: "unavailable"`. `judgePublicNote` gets `unreachableIds`; builder test 12 now covers audit, sealed candidate, neither, a non-`unavailable` audit and a missing audit file, and the test helper wires `audit_file`; Task 7 keeps the audit as an optional frozen input (new snapshot test 6) and drops only the baseline; Task 10 Step 5a and Step 7 keep `audit_file`; checklist V-P3-13 and V-P3-20 updated.
  Completeness: 9/10  Confidence: 9/10
- **Medium** — Task 10 Step 5a expected the real Seedance card (`…0023f9`) to carry `unverifiedTools` containing `Seedance 导演 Skill`; the real sealed candidate and bundle entry for that note both have `tools: []` (the chip exists only in the mockup), so the check could never pass and would have stopped the run; checklist V-P0-06 and V-P3-27 repeated the claim.
  → Step 5a now expects an empty `tools` list, kind `Tool`, reply complete and not damaged, and says the badge is proved by the fixture card, builder test 5 and Playwright test 5; the Task 5 fixture note says it is lifted from the mockup, not from real data; V-P0-06 and V-P3-27 reworded.
  Completeness: 9/10  Confidence: 9/10
- **Medium** — Playwright test 12 and checklist V-P0-11 expect the `在小红书搜索原帖` link as the footer's first control, but the test opens the card on `127.0.0.1:8766`, the local-workbench origin, where `isLocalWorkbenchLocation()` is true and the first control is `打开原帖` or a disabled `请先启动 FavSense 本地服务`. The public link only exists on `127.0.0.1:8767`.
  → Test 12 now names both origins and asserts the link, its `href` prefix and the absence of `/explore/` on 8767, and the local button on 8766; V-P0-11 says the same.
  Completeness: 9/10  Confidence: 9/10
- **Medium** — Task 5 adds a fourth number cell to `.method-proof` without touching the grids that were written for three cells plus a note (`styles.css` lines 339 and 557), so the cell would land in the wide note column and push the note to a second row.
  → Step 6 now changes line 339 to `repeat(4, 1fr) 2fr` and the tablet rule at 557 to `repeat(2, 1fr)`; Playwright test 11 asserts the four cells share a row on desktop and that neither width scrolls sideways; V-P4-05 extended.
  Completeness: 8/10  Confidence: 8/10
- **Medium** — The disposition table said the loader-integrity cases of `test_public_site.mjs` (lines ~1374–1433) "stay", but they assert on `deepSummarySource` and `deepSummary`, which Task 6 removes: three `notEqual(undefined, …)` assertions would pass without testing anything and `doesNotMatch(mismatched.notes[0].deepSummary, …)` (line ~1386) would throw; the `data.meta.videoMethod` reader (line ~2010) would throw too.
  → Row rewritten: those cases keep their setups but assert `mainSource !== "diandian"` and `mainText`; the acceptance/prompt-version cases at 1299–1359 are deleted; the `videoMethod` reader asserts `replyCount`/`transcriptCount`.
  Completeness: 9/10  Confidence: 9/10
- **Low** — D4 blamed whitespace flattening for transcripts that fail the integrity check. Measured on the real folder: 211 of 252 finished transcript and picture-text files pass; the 41 that fail are early-format files with no `schema_version`, `method` or `result_sha256`. A simulation over the real catalog found no card left with empty main text.
  → D4 states the measured cause and counts and points at Task 10 Step 5a's empty-text count.
  Completeness: 9/10  Confidence: 8/10
- **Low** — Task 4 said `isBare` has "four calls" inside `headingText`; it has three (lines 57–59), plus the definition.
  → Wording corrected so the rename leaves no stale name.
  Completeness: 10/10  Confidence: 10/10
- **Low** — Task 2's "move" list omitted the `node:fs`/`node:path`/`node:crypto` imports that travel with the moved code, and did not say that `readEvidence` throws on an unsafe path (symlink, escape) and returns `null` only for missing files, which the new tests depend on.
  → Both stated in Step 3.
  Completeness: 9/10  Confidence: 9/10

**Auto-accept decisions (4)**
- Where the unreachable fact should come from: copy it into the add-on files, or read it from the audit file.
  → Auto-accepted: read only the audit's `unavailable` list, for the source-line label — it is the single existing record of the fact, the card's title and text never depend on it, and AC-NOGATE (titles, main texts, main sources unchanged without any review record) still holds.
  Completeness: 9/10  Confidence: 8/10
- The mockup's `Seedance 导演 Skill · 未核实` chip cannot be produced from the real data (no tool is recorded for that note).
  → Auto-accepted: keep the badge behaviour and its tests on the fixture card, and expect no chip on the real card; no tool name is invented for it (spec §5.2 forbids guessed values).
  Completeness: 9/10  Confidence: 9/10
- The 41 early-format transcripts do not pass the integrity check and will not be shown.
  → Auto-accepted: leave as is — no card ends up with empty text because of them, Task 8 Step 3 already stops trusting that format, and Step 5a prints the real empty-text count.
  Completeness: 8/10  Confidence: 8/10
- Tablet layout of the four-cell proof strip (the mockups do not cover it).
  → Auto-accepted: two rows of two; the phone layout stays one column.
  Completeness: 8/10  Confidence: 7/10

### Pass 3

**Issues fixed (8)**
- **Critical** — Task 10 Step 5 told the run to call `build_organization_snapshot(batch=<newest batch in manual-sync.json>)`. That batch (`manual20261013025553339527`) was sealed over 207 notes (its curation bundle's `scope.note_ids`, probed), while the call takes the 377 notes of the catalog when no note list is given; the snapshot compares the two digests and stops with `SNAPSHOT_SCOPE_DIGEST_MISMATCH`, so the overnight run would have halted at its main step.
  → Step 5 now builds a fresh batch id and the full scope (`local_rebuild_scope()`), then calls `run_curation_pipeline(batch, note_ids)` and `build_organization_snapshot(batch, note_ids)` — the two steps `run_final_build` runs before it publishes — never `trigger_local_rebuild()`; it says why the newest batch must not be reused, where the new bundle files land (private, no platform contact), and that every re-run uses a new batch id.
  Completeness: 9/10  Confidence: 9/10
- **Critical** — 13 of the 377 real cards would have shown no text at all: their saved DianDian reply is on the damaged list, their post is only topic tags, and they have no transcript that passes the integrity check (6 have none, 6 only an early-format one, 1 has an empty post). Pass 2's statement that a simulation found no empty card did not count damaged replies; Task 10 Step 5a only printed the empty count and never stopped on it, so 13 blank cards would have been published.
  → New decision D10 (damaged reply: post text, else extracted text, else the saved cut reply, marked `replyDamaged`); D4 sentence corrected; D6 gains the source-line sentence (one new clause, flagged `[needs user-approved copy]`); D7 counts only complete replies. Task 3: `cardText` fallback, `cardCounts` excludes cut replies, two tests changed and one added (15 tests). Task 5: fixture card `fixture-damaged-only-reply`, `damagedOnlyRest` copy, a source-line branch, Playwright test 18. Task 6: builder test 18. Task 10 Step 5a expects 0 empty cards (stop-and-report otherwise) and prints the cut-reply count. Coverage row and checklist rows V-P0-02, V-P3-08, V-P3-27 and new V-P3-28 updated.
  Completeness: 9/10  Confidence: 8/10
- **Medium** — `tests/verification-max-age.test.mjs` (in `test:curation`, which Task 6 Step 7 runs) imports `acceptedSkill` and calls the old `judgePublicNote` shape and its `accepted`/`reasonCode` results; Task 6 deletes all three and the disposition table never named the file, so Task 6's commit could not be green.
  → New disposition row with the replacement helper, the changed assertions (kind and `resourceIds` instead of `accepted`/`reasonCode`) and the unchanged cases; Task 6 Step 6 lists the file and adds a grep that no test still imports the deleted fixtures.
  Completeness: 9/10  Confidence: 9/10
- **Medium** — `test_formal_outputs.mjs` (in `test:knowledge`) asserts the old card fields (`summaryStatus`, `deepSummary`, `curationStatus`) and `reviewed-evidence-only-rebuild.test.mjs` imports the deleted `formalCurationDecision`, but their row said only "gate cases deleted … updated in Task 7", so the owning task and the surviving cases were undefined.
  → Row rewritten: Task 6 owns both; the surviving cases are kept in a new form, the others are listed as deleted with their line numbers, and the snapshot-freeze case stays for Task 7.
  Completeness: 9/10  Confidence: 9/10
- **Medium** — Spec §4 requires the frozen damaged-reply list to be "checked entry by entry at plan review"; the plan had no such check and quoted 81 from an earlier probe.
  → Done now with the Task 4 rule on the 275 loadable replies: 79 flagged (28 / 50 / 5 by sign, 4 on two), tail of each read, 77 plainly cut, 2 doubtful (`…01e252`, `…03930b`). Recorded in D1; Task 6 Step 8 says what to do if the run's list differs and to list the two IDs in the brief; checklist V-P3-03 updated. Rule not tuned.
  Completeness: 8/10  Confidence: 8/10
- **Low** — Task 2 Step 3 said the moved code travels "with its imports", which could be read as stripping `fs`, `path` and `createHash` from `prepare-curation-review.mjs`, which still uses them.
  → Sentence states what the new module imports and what the review script keeps.
  Completeness: 9/10  Confidence: 9/10
- **Low** — Task 8 Step 2 removes the prompt-version argument from `prepareReview` but not the two guards that would then return no reply at all (`readDiandianSummary` line 146 and the check near line 232).
  → Both named in the step.
  Completeness: 9/10  Confidence: 9/10
- **Low** — Task 10 Step 6 builds "with no audit or report" using the builder's default config, which still points at the real audit file.
  → Step says to pass a scratch copy of the config in both builds and drop its `curation_quality` block for the second.
  Completeness: 9/10  Confidence: 8/10

**Auto-accept decisions (4)**
- Whether a damaged reply with nothing else to show should render a blank card (spec silent; grounding rule forbids unapproved copy) or its saved part.
  → Auto-accepted: show the saved part with the approved damaged opening plus one new clause, flagged for the owner as `[needs user-approved copy]` — a blank card breaks CARD-01 and the owner's ruling that missing text is our capture's fault.
  Completeness: 8/10  Confidence: 7/10
- The two doubtful entries on the damaged list (a reply ending on `标签` plus hashtags, a reply ending on two short list lines).
  → Auto-accepted: keep them on the list and name them in the brief; the spec's two signs are the rule and the owner said not to tune; the cost of a wrong flag is a fallback card until the next fetch.
  Completeness: 9/10  Confidence: 8/10
- Whether a cut reply shown as the only text counts in "条有完整点点总结".
  → Auto-accepted: no — the count stays "complete replies" (D7), so the home page never calls a cut reply complete.
  Completeness: 9/10  Confidence: 9/10
- Whether Task 10 may write a new curation bundle under `.xhs-favorites/organization-transactions/` for the rebuild.
  → Auto-accepted: yes — it is private, git-ignored, offline, and exactly what a local rebuild writes before it builds; reusing an old bundle is impossible (scope mismatch above).
  Completeness: 9/10  Confidence: 8/10

Final verdict: AUDIT-INCOMPLETE — Step 2 — HOW (plan audit), 3-pass cap exhausted
