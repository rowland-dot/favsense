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

---

## Step 3 — PLAN (spec coverage pre-flight)

Spec: docs/specs/2026-10-14-favsense-faithful-cards-spec.md · Plan: docs/plans/2026-10-14-favsense-faithful-cards-plan.md

- §3 / CARD-01..09 → Tasks 3, 5, 6 (plan coverage table). §5.2 → Task 6. §6.3 → Tasks 3, 5, 6. §7 card path → Tasks 5, 6; curation layer → Tasks 7, 8, 10 Step 7; archiving → Task 10 Steps 3–4; documents → Task 9. Frozen damaged list → Tasks 4, 6, 10. AC-CARD/NOGATE/ADDON/PARA → Tasks 5, 6, 10, 1.
- Slice B by spec §9 and the plan's "Not in this plan — Slice B": §4 CAP-01..05 (CAP-06 offline half in Task 1, D12), §5.1, §6.1 LINK-01..03 (and the conditional "搜索原帖文字" removal in §7), §6.2 COMP-01, AC-CAP, AC-LINK, §10 live checks.
- §7 curated-skip rule removal → Slice B by plan decision D13 (owner rulings §2, §5.1).
- §0–§2, §8, §11: principle, derivation, rulings, boundaries, approval — no behaviour to assign.

UNASSIGNED: 0. Nothing auto-deferred; TODOS.md and the spec unchanged.

---

## Step 3 — PLAN (reviewed plan audit)

Artifact: docs/plans/2026-10-14-favsense-faithful-cards-plan.md
Skill: /autoplan (audit mode)
Machine checks: PASS (Test Plan Artifact, NOT-in-scope, manual-only tags)

### Pass 1

Read whole: the plan (2149 lines), the spec, the verification checklist; cross-checked against `public-judgement.mjs`, `curation-quality.mjs`, `build-public-site.mjs` (arguments, search text), `site/app.js` (every removed card field), `site/diandian-text.mjs`, `site/styles.css` tokens, `scripts/serve-qa-fixture.mjs`, `package.json` test lists, `run-organization-tests.mjs`, the snapshot capture test, `test_bridge.py` and `test_final_build.py` snapshot-command cases, and the bridge method signatures Task 10 calls. Every autoplan accepted block (CEO, design, DX, eng) is present in the task text; every task traces to spec §3, §5.2, §6.3, §7, the frozen list or CARD-08/AC-PARA (D12); the Test Plan Artifact is on disk; NOT-in-scope sections exist. Vague-word scan: no undecided "consider/could/may/should" in any instruction; the one undecided phrase ("deleted or updated") is fixed below.

**Issues fixed (8)**
- **Medium** — The existing snapshot capture case in `test_organization_snapshot.mjs` (line ~266) writes a reply file with no damaged list, so Task 7's new rule would stop it with `DAMAGED_REPLY_LIST_MISSING`; it also mutates `report` and `baseline` (no longer captured), asserts the prompt version, and expects a default audit path to be read with no `audit_file` (D3 removes that). The disposition row only said these cases are "deleted or updated in Tasks 7 and 8".
  → New disposition row, owned by Task 7, listing exactly what is added, removed and kept in that case; the lumped row split into one row per file with its owning task.
  Completeness: 9/10  Confidence: 9/10
- **Medium** — `test_bridge.py::test_snapshot_command_delegates_complete_input_capture_to_the_coordinator` asserts `--diandian-report` and `--diandian-prompt-version` on the snapshot command, which Task 7 removes; no step changed it. Task 7 Step 1 pointed at `test_no_direct_rebuild.py`, which mocks the snapshot step and asserts nothing about its command.
  → Disposition row for that case (both flags become `assertNotIn`); Task 7 Step 1 targets `test_final_build.py` `SnapshotCommandTest` and the two rewritten cases; Step 2 also runs `test_bridge.py`; `test_no_direct_rebuild.py` dropped from Task 7's file list with the reason.
  Completeness: 9/10  Confidence: 9/10
- **Medium** — Task 6 edits `test_organization_contracts.mjs` (it imports functions Task 6 deletes), but that file runs only in `test:organization`, which Task 6 Step 7 never ran, so Task 6's commit could be red unnoticed until Task 7.
  → Task 6 Step 7 also runs `npm.cmd run test:organization`.
  Completeness: 10/10  Confidence: 9/10
- **Medium** — The verification checklist cites plan tests as evidence for assertions those tests did not make: V-P2-07 (filtered grid, PW 1), V-P0-05/V-P4-03 (`收起`, PW 3), V-P5-03 (extracted section `aria-label` and `h3`, PW 7), V-P4-02 (explanation on its own row on the phone, PW 12), V-P3-19 (stale config with a missing audit file, builder test 13). The live check would have had no evidence for five rows.
  → Playwright tests 1, 3, 7 and 12 and builder test 13 (a third build with `publish_only_accepted` and a missing audit file) now carry those assertions.
  Completeness: 9/10  Confidence: 8/10
- **Low** — Task 5's `.tool-unverified` rule used `var(--gold)`, which `styles.css` does not define, and then said "use the real token names", an open instruction.
  → Rule uses `var(--sun)` (the stylesheet's yellow) mixed with `--surface`; the sentence names the four defined tokens.
  Completeness: 10/10  Confidence: 9/10
- **Low** — The disposition row said `reviewed-evidence-only-rebuild.test.mjs` is in `test:knowledge`; it is in `test:curation` (`test_formal_outputs.mjs` is in `test:knowledge` and `test:organization`).
  → Row corrected; Task 6 Step 7 runs all three lists.
  Completeness: 10/10  Confidence: 10/10
- **Low** — Builder test 15 did not say the note has its own title; without one, the title (first line of the post) or the search link would carry the token first, so the error would name `title` or `sourceUrl`, not `mainText`.
  → Test 15 states the note has its own title.
  Completeness: 9/10  Confidence: 8/10
- **Low** — Task 5 Step 1 lifted card ①'s reply from the "currently committed" `site/data/knowledge.json` while the working copy carries an uncommitted local rebuild (build version and date changed).
  → Step reads it with `git show HEAD:site/data/knowledge.json`.
  Completeness: 9/10  Confidence: 9/10

**Auto-accept decisions (3)**
- Checklist V-P1-03 says Task 10 Step 5 used "only `build_organization_snapshot`"; the plan (pass 3 of Step 2) calls `run_curation_pipeline` first. Editing the checklist from this step is refused by the spec-authoring gate (the file is in `docs/specs/`).
  → Auto-accepted: leave the checklist unchanged and record the mismatch here; the plan is the source the checklist is derived from, and the evidence the row needs (no browser, no `trigger_local_rebuild`) is unchanged. The orchestrator corrects the row wording through the route that owns spec files.
  Completeness: 7/10  Confidence: 8/10
- V-P3-19 (stale config, missing audit) could get its own builder test or extend test 13.
  → Auto-accepted: a third build inside test 13 — same subject (no review state changes a card), no new helper.
  Completeness: 9/10  Confidence: 9/10
- The unverified-tool badge colour (the mockup's yellow tint has no matching token).
  → Auto-accepted: `--sun` mixed 30% into `--surface`; colour is only reinforcement and the existing contrast regression test covers it.
  Completeness: 8/10  Confidence: 8/10

Verdict: ISSUES_FOUND

### Pass 2

Read whole: the plan (2151 lines before this pass), the spec, the verification checklist, `build-organization-snapshot.mjs`, `build-public-site.mjs`, `public-judgement.mjs`, `curation-quality.mjs`; read the parts that the run steps call in `bridge-server.py` (`Bridge.__init__`, `require_plain_directory`, `local_rebuild_scope`, `trigger_local_rebuild`, `run_final_build`, `build_organization_snapshot`), the snapshot cases of `test_final_build.py`, `exact-file-identity.test.mjs`, the documentation contract fixture, and the document-reading cases of `test_public_site.mjs` and `test_organization_contracts.mjs`. A read-only script (session scratchpad, project modules imported, counts and ids only) applied the plan's card rules to the real catalog, replies, transcripts and audit: 377 cards, 79 damaged, 0 empty, 13 shown as a cut reply, 3 unreachable, 196 complete replies, 103 transcripts; the four mockup notes come out as Task 10 Step 5a expects; 0 safety-pattern or private-identifier hits over every shown text; 0 add-on entries the new `classify` call would throw on; the newest bundle covers 377 notes with 34 sealed candidates. Mockup lines 51, 62, 73 and 84 and card ①'s committed reply checked against Task 5. Vague-word scan: one "etc." in an instruction (fixed below).

**Issues fixed (10)**
- **Medium** — Task 10 Step 5 builds `module.Bridge(workspace, …)` without saying what `workspace` is. The Bridge refuses any workspace, skill folder or config path that passes through a link (`require_plain_directory`, `bridge-server.py:1304`), and the repository is also reachable as the `C:\Users\rowla\favsense` junction; from there the overnight run's main step would stop with "workspace is unavailable or redirected", and `workspace.parent / "SOP - 小红书"` would name a folder that does not exist (the real one is `C:\Users\rowla\Codex\SOP - 小红书`).
  → Step 5 sets `workspace = Path(os.path.realpath(<repository root>))` (the real folder on this machine), forbids the junction, and checks the catalog file and the SOP folder before the Bridge is built, stopping and reporting otherwise.
  Completeness: 9/10  Confidence: 9/10
- **Medium** — The documentation contract fixture also pins three `forbidden_phrases` that forbid saying what this plan makes true (`curation-standard.md` `raw 点点回复可以直接发布`, `README.md` `公开页面直接采用 raw 点点回复`, `docs/PUBLISHING.md` `captured/pending 证据可以公开`). Task 9 only replaced required phrases, so the contract would keep encoding the retired gate and the new documents would have to be worded around it, which spec §9 rules out.
  → Task 9 replaces each with the old gate's own claim (keys kept): `还必须通过 accepted/current/resource 门`, `公开页面不会直接采用 raw 点点回复`, `captured/pending 证据只留在本机 overlay`; every other forbidden phrase stays.
  Completeness: 9/10  Confidence: 8/10
- **Low** — Task 10 Step 4 ended "moving `issue86-local-rebuild.py` first is safe", contradicting the order note that Steps 3–4 run after Steps 5–7.
  → Sentence now says the move happens after Steps 5 and 7 and the Step 5 driver never runs that script.
  Completeness: 10/10  Confidence: 10/10
- **Low** — Task 10 Step 5a justified card ③'s expected kind `Tool` by "its sealed candidate says `Skill`"; in the newest bundle (`localrebuild20261014051436004066`) it says `Tool`.
  → Rationale corrected (sealed `Tool`; a `Skill` with no verified resource would fall back to the profile default, also `Tool`). The expected value is unchanged.
  Completeness: 9/10  Confidence: 9/10
- **Low** — Task 5 Step 5 said mockup ① omits the opener clause "because that reply has no opener"; card ①'s committed and saved reply both start with `根据你引用的笔记`, so the live sentence will carry the clause.
  → Note rewritten: the live #99 sentence is longer than the mockup's, the 805 count is the same, the mockup governs structure not this sentence, and Playwright test 3's substring check holds.
  Completeness: 9/10  Confidence: 9/10
- **Low** — Task 10 Step 7 compares the re-run with "the Step 5 result", but the re-run swaps `site/data/knowledge.json` in place, leaving nothing to compare with.
  → Step 7 copies the Step 5 data to the scratchpad first, re-runs with a new batch id, and compares title, main text and main source with that copy.
  Completeness: 10/10  Confidence: 9/10
- **Low** — Playwright test 2 said "`fixture-post-and-transcript` etc. likewise" (undecided set).
  → Every fixture card's detail title equals its fixture `title`.
  Completeness: 10/10  Confidence: 10/10
- **Low** — Task 9 moves the 2026-08-22 plan into the archive without touching the five documents that name its old path (one markdown link in the 2026-08-25 brief).
  → Task 9 rewrites the five inbound mentions in the same commit and greps that none is left.
  Completeness: 9/10  Confidence: 9/10
- **Low** — Task 9 Step 1 said "the six documents" without naming them.
  → Named; `ARCHITECTURE.md` and `PUBLISHING.md` are stated to be held by the contract fixture.
  Completeness: 10/10  Confidence: 10/10
- **Low** — Task 7 Step 3's `DAMAGED_REPLY_LIST_MISSING` rule said "no `damaged-replies` entry was captured", but an optional capture of a missing file still records an entry (state `missing`), so the check could read as satisfied with no list.
  → Rule names the entry state (`file`) for the list and for the reply files.
  Completeness: 10/10  Confidence: 9/10

**Auto-accept decisions (3)**
- Whether the three forbidden phrases that encode the old gate are deleted, kept and worded around, or replaced.
  → Auto-accepted: replaced by the retired gate's own claims, keys kept — the contract keeps its shape and now guards the new rule, and spec §9 forbids keeping a test of the old rule by working around it.
  Completeness: 9/10  Confidence: 8/10
- How the rebuild driver finds its workspace when the repository is reachable through a junction.
  → Auto-accepted: `os.path.realpath` of the repository root, plus a check of the catalog and SOP folder before the Bridge is built — the Bridge's own link refusal stays untouched.
  Completeness: 9/10  Confidence: 9/10
- Whether archiving the superseded plan should also edit the historical reports that cite its path.
  → Auto-accepted: yes, only the path string, in the same commit — file governance requires inbound references to move with the file, and one of them is a markdown link that would otherwise be dead.
  Completeness: 9/10  Confidence: 8/10

Verdict: ISSUES_FOUND

### Pass 3

Read whole: the plan (2154 lines before this pass), the spec, this audit log; `build-organization-snapshot.mjs`, `build-public-site.mjs`, `public-judgement.mjs`, `curation-quality.mjs`, `public-tree-policy.mjs`, `sensitive-data.mjs`, `content-revision.mjs`, `site/diandian-text.mjs`, `scripts/run-python-tests.mjs`, `run-organization-tests.mjs`, `check-syntax.mjs`, `check-test-script-paths.mjs`, `verify-release.mjs`, `diandian-summary-display.test.mjs`, `site-code-in-build-version.test.mjs`, `web-only-snapshot.test.mjs`, `private-output-short-path.test.mjs`; read the parts the plan touches of `site/app.js`, `organize.mjs` (lines 1–135, 145–239, 282–371 and 426–586), `prepare-curation-review.mjs` (lines 1–215), and the bridge's `build_organization_snapshot`, `run_curation_pipeline`, detail-import path and `parse_fetch_payload`/`valid_fetch_note`. Probes (read-only scratch scripts importing the project's own modules, counts and id tails only): the publish-time public-tree check over every post text, title, loadable reply and verified transcript of the 377 notes (0 hits; the builder's own scan also 0); the four sweeps of `diandian-summary-display.test.mjs` over all 275 loadable replies (0 failures); the Task 10 Step 3 archive rule against the curation file and the starting public data; the site-less build version at builder 7 and 8; every test that reads `card-summary-sources.json`, a 64-hex version literal, or the snapshot functions Task 7 changes. Vague-word scan of the plan: no undecided wording in an instruction.

**Issues fixed (7)**
- **Critical** — The post text is flattened twice on its way into the catalog, and the plan fixed only the first place. `organize.mjs` line 212 writes `description: cleanText(...)`, whose `cleanText` (line 149) collapses every whitespace run to one space, and the bridge pipes every fetched note through it (`bridge-server.py` ~6880–6946: fetcher → `parse_fetch_payload` → `node organize.mjs --input -`). With only the fetcher fixed, no real catalog description could ever carry a paragraph break, so CARD-08 and CAP-06's offline half could never hold even after the Slice B re-fetch, and risk (4) would have told the owner they would.
  → Task 1 now also changes `organize.mjs` (`cleanParagraphs`, the same rule as the fetcher's, for `description` only; the private daily report keeps its one-line bullet) with a new `organize-paragraphs.test.mjs` (paragraphs kept, spaces tidied, other fields one line, report bullet one line, `content_sha256` unchanged) added to `test:knowledge`; Steps 2, 4 and 5 run and commit it; D12, risk (4) (now also says a re-fetched note's public-text review hash changes), the file map, the coverage rows for CARD-08 and AC-PARA and the test-layer table updated.
  Completeness: 9/10  Confidence: 9/10
- **Medium** — `diandian-summary-display.test.mjs` (in `test:site`) reads `scripts/fixtures/card-summary-sources.json` at module load (line 15), and Task 5 `git rm`s that file; Task 5 Step 8 ran only `test_public_site.mjs`, so Task 5's commit would leave `test:site` failing until Task 6, whose disposition row covered only the `published` half.
  → Disposition row split by owner: Task 5 points `frozen` at `faithful-cards.json` and reads `example.mainText` (card ①'s reply is byte-identical in the old fixture and the committed data, checked), and fixes the two comments naming the deleted spec; Task 6 keeps the `published` change, with the 209-card count (≥ 200 holds) stated. Task 5 files list, Step 7, Step 8 (`npm.cmd run test:site`) and the commit updated.
  Completeness: 9/10  Confidence: 9/10
- **Medium** — `site-code-in-build-version.test.mjs` line 103 pins the exact build version of a site-less build, computed with `builders: { public_site: 7 }` (recomputed: `bfd4f8e6…ccbab353`); Task 7 sets the builder version to 8 and listed the file under "Modify" without saying what changes, so `test:knowledge` would fail and an unattended run would have to choose between loosening an assertion and reverting the version bump.
  → Task 7 Step 1 replaces the literal with the builder-8 value of the same preimage (`a42d5a8d…3fe4f0c0b`, computed), keeping an exact `equal`; a disposition row added.
  Completeness: 9/10  Confidence: 9/10
- **Medium** — Task 10 Step 3 archived "every curation-file entry whose note has no complete reply" and expected "about 105" (spec §7). On today's data that rule selects 171 of the 343 curation entries; the spec's 105 are the cards whose public text came from the curation file (the starting public data has 238 DianDian, 105 curation and 34 metadata cards).
  → Step 3 now archives `{id, title, summary: deepSummary, action}` of the `deepSummarySource === "curation"` cards in `git show 1a9ef29:site/data/knowledge.json`, expects exactly 105 and stops and reports otherwise.
  Completeness: 9/10  Confidence: 8/10
- **Medium** — Task 10 Step 6 said "build twice with `build-public-site.mjs`" without naming its arguments. Left to defaults, the builder writes to `site/data/knowledge.json` (overwriting the Step 5 data that Steps 5a and 7 rely on), reads no damaged list (so the contact-detail count would measure cut replies instead of post text), and reads the live private folder rather than the copies; which bundle the sealed candidates come from was also unstated.
  → Step 6 names every argument (copies, `--damaged-replies`, `--candidates` from the Step 5 bundle, `--effective-date`, a scratch `--output`) and forbids omitting `--output`, with the reason.
  Completeness: 9/10  Confidence: 9/10
- **Low** — Task 7 changes `captureBuilderInputs` and `materializeCapturedInputs`, which three `test:curation` files exercise (`exact-file-identity`, `reviewed-evidence-only-rebuild`, `organization-lock-handoff`), but Step 4 never ran `test:curation`; its files list named two tests that need no change and the disposition row said Task 7 "updates" a case without saying how.
  → Step 4 runs `npm.cmd run test:curation`; the files list separates "modify" from "run, not changed" with the reason for each; the row says the case stays unchanged and is proved by that run.
  Completeness: 9/10  Confidence: 9/10
- **Low** — Task 6 Step 8 listed "damaged list" among the builder defaults, contradicting Task 6 Step 5 (no default path) and the explicit argument two lines above.
  → Sentence corrected.
  Completeness: 10/10  Confidence: 10/10

**Auto-accept decisions (4)**
- Spec §1 names `fetch-xhs-details.py:144` as the cause of the lost paragraph breaks; `organize.mjs` is a second one it does not name.
  → Auto-accepted: fix both in Task 1 and record the second cause in D12; CAP-06's required behaviour is "post text is saved with its line breaks", which the named line alone cannot deliver. The approved spec text is not edited.
  Completeness: 9/10  Confidence: 9/10
- Whether the private daily report (`xhs-favorites/<date>.md`) should show the restored paragraphs.
  → Auto-accepted: no, its description bullet stays on one line, so the report's format and its note-id parsing are unchanged; only the catalog keeps the breaks.
  Completeness: 8/10  Confidence: 8/10
- How to repair the pinned build-version literal.
  → Auto-accepted: the builder-8 value of the same preimage, still an exact match, rather than a format check, so a silent revert of the builder version still fails.
  Completeness: 9/10  Confidence: 9/10
- Where the 105 archived card texts come from.
  → Auto-accepted: the starting public data at `1a9ef29` (the texts the cards actually showed), not the curation file, which stays in the repository anyway.
  Completeness: 9/10  Confidence: 8/10

Verdict: ISSUES_FOUND

Final verdict: AUDIT-INCOMPLETE — Step 3 — PLAN (reviewed plan audit), 3-pass cap exhausted

---

## Step 4 — CODE

- Stage A.3 HARD BLOCK: spec had no '## States' section for mockup tagging. Fixed by adding a States section that restates the spec's own §3.2 rows (no new behaviour); re-run below.
