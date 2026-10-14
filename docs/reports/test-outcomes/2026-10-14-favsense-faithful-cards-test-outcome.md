# FavSense faithful cards: test outcome (dev-pipeline Step 7, Stage A coverage fill)

- Branch `feat/faithful-cards`, audited from `0194c6b`, finished at `03aa3c9`.
- Governing sources: spec `docs/specs/2026-10-14-favsense-faithful-cards-spec.md`, plan `docs/plans/2026-10-14-favsense-faithful-cards-plan.md`, checklist `docs/specs/2026-10-14-favsense-faithful-cards-verification-checklist.md`, mockup `docs/designs/2026-10-14-card-design-rewrite.html` (six tagged states), QA report `docs/reports/qa/2026-10-14-favsense-faithful-cards-qa-report.md` (its two bugs were already anchored and were skipped).
- Scope: the feature area (Slice A), not the branch diff. Slice B items (CAP-01 to CAP-05, LINK-01 to LINK-03, COMP-01, spec 5.1, the curated-skip removal) are deferrals, not gaps.
- No Xiaohongshu contact. Nothing private read or committed. The fixture server ports 8766 to 8768 were only ever bound by the Playwright config's own server.

## Method

1. Read the spec, plan, checklist, QA report, TODOS and the full AUDIT-MODE rules.
2. Listed the existing tests per behaviour (about 100 browser cases, 18 builder cases, card/damage/extracted unit files, snapshot and bridge cases).
3. Measured line coverage of the new modules with Node's coverage run: `card-content` 100%, `damaged-replies` 100%, `extracted-text` 100%, `evidence-files` 96%, `public-judgement` 94%, `curation-quality` 95%, `build-public-site` 98%, `build-organization-snapshot` 95%. The uncovered lines were read one by one (see gaps).
4. Checked every checklist row whose evidence cell names a test, against that test's actual assertions.
5. Wrote the missing tests; where a new test failed, read the code, found the cause, fixed it at the cause and committed the fix separately.

## Behaviours audited

CARD-01 to CARD-09, AC-NOGATE, AC-ADDON, AC-PARA, the six mockup states, the spec 3.1 post button and source line, spec 7 (removal; curated-skip rule untouched, `git diff --stat 1a9ef29` over the seven files prints nothing), spec 8 boundaries, and the layers: component, interaction, E2E, mobile (390 px), accessibility (keyboard, focus ring, labels, contrast and size floor in both themes). i18n: the site is single-language Chinese with no translation layer, so the i18n layer does not apply.

## Gaps found

| # | Gap | Severity | Result |
|---|---|---|---|
| G1 | **Bug.** The 未核实 marker sat at the end of a nowrap, ellipsised chip; a tool name of about 30 characters pushed it past the chip edge and it was clipped (74 px outside the chip on desktop). Checklist V-P4-06 only covered the short fixture name. | High (hides the very signal spec 3.1 asks for) | Fixed in `5a4fd21` (marker is its own flex item); regression test in `site/e2e/faithful-cards-states-audit.spec.mjs` |
| G2 | **Bug.** The page builder's safety check refused four patterns; the publisher (`public-tree-policy.mjs`) also refuses `password:`/`secret=` values, bearer values, cookie values and direct `/explore/<id>` links. Post text and transcripts are now public in full, so a post containing one built cleanly and then blocked the run's one publish, naming no note. | Medium (fails closed, nothing leaks, but late and unlocated) | Fixed in `8eb644a` (builder uses the publisher's own exported list); 5 tests in `faithful-cards-public-safety.test.mjs` were RED before the fix |
| G3 | Checklist V-P0-11 (public footer opens with the search link) was never exercised: the app treats `127.0.0.1` and `localhost` as the local workbench, so both fixture origins never draw the link. The existing spec only asserted copy-link and bookmark on 8767. | Medium (untested live-site control) | Covered by opening the fixture under `public.localhost:8767` |
| G4 | Checklist V-P5-04 (keyboard order and focus ring inside a detail view) named existing specs that never open a detail view's new controls. | Medium | New test |
| G5 | Checklist V-P5-07 (contrast and size of the new elements): the legibility regression only scans the four default cards, which have no extracted section, no 未核实 badge and no fold button. | Medium | New test, light and dark, all 12 fixture cards |
| G6 | Public safety of the new public surfaces was tested only for a token in post text. Not tested: token or profile address in a transcript, picture text; the owner's profile id or folder id in any text (builder lines for the private-identifier check had no test). | Medium (spec 8) | 6 tests |
| G7 | No test that markup in card text is inert in the browser (title, reply, post, transcript, tool and topic chips), that a single line break stays a line break, or that a very long unbroken string never scrolls a card or the page sideways. | Medium | 4 browser tests |
| G8 | CAP-06 "existing notes regain paragraphs when fetched again" had only a fresh-note test. | Low | 1 test (passes: the behaviour holds and the content revision does not move) |
| G9 | Spec 8 "no network, no browser" for the card path had no mechanical check; shipped `site/data/knowledge.json` had no card-level invariant check (replacement characters, leftover topic tags, extracted section only beside post text, no complete reply with a damage sign, numbering, publisher check). The QA report's own learning says the replacement-character class can recur. | Low | 5 tests |
| G10 | Broken or BOM-prefixed evidence files, and a hand-edited damaged list (the owner's planned override path in TODOS) had no test. | Low | 4 tests |

Observed, not changed (no requirement to test against, or an owner decision):

- `validateKnowledgeData` does not check `meta.replyCount` and `meta.transcriptCount`. A data file with valid cards but without them would draw "undefined 条有完整点点总结". The builder always writes them, so it cannot happen from this repository. Left as is.
- Long post text and transcripts never fold (plan taste decision T-D1, owner-approved mockup).
- 14 cards (not the plan's 13) show only a saved cut reply, because BUG-001's fix removed a damaged transcript from one card. The data check counts no empty card.

## Tests written

| Commit | Files | Tests |
|---|---|---|
| `5a4fd21` fix | `site/app.js`, `site/styles.css` | (fix) |
| `8eb644a` fix | `scripts/build-public-site.mjs`, `scripts/public-tree-policy.mjs` (export) | (fix) |
| `275ff2f` test | `site/e2e/faithful-cards-states-audit.spec.mjs` | 9 cases x 2 projects = 18 |
| `851a2fc` test | `tests/faithful-cards-public-safety.test.mjs`, `tests/faithful-cards-boundaries.test.mjs`, `package.json` | 9 + 5 |
| `03aa3c9` test | `tests/organize-paragraphs.test.mjs`, `tests/extracted-text.test.mjs`, `tests/damaged-replies.test.mjs` | 1 + 2 + 2 |

(Test paths are under `skills/xhs-favorites-organizer/`.) Both new Node files are listed in `test:knowledge`; the browser spec is picked up by the Playwright folder.

## Final results

| Command | Result |
|---|---|
| `npm.cmd run check:syntax` | exit 0, 112 tracked modules |
| `npm.cmd run lint:a11y` | exit 0 |
| `npm.cmd test` | exit 0; node suites 149, 17 (1 skipped), 135, 224 (2 skipped), 12, 25, 25 passed, 0 failed |
| `npm.cmd run test:organization` | exit 0, 38 passed |
| `npm.cmd run test:python` | exit 0; 532 tests OK (1 skipped) and 56 tests OK (1 skipped); no traceback |
| `npx playwright test` | exit 0, 122 passed on desktop and phone (104 before, 18 new) |
| `npm.cmd run verify` | exit 0 |

Before the two fixes, 2 browser cases (x2 projects) and 7 builder cases were red.

## Deferred Stubs

None. No `.todo()`, `skip` or `fixme` exists in the browser specs. The Slice B items stay in `TODOS.md` as deferrals.

## Decisions for the owner

1. G2 makes the builder stop (naming the note and field) on credential-shaped or direct-post-link text in any card, as the publisher already would. If he would rather let such text through, the change is the publisher's list, which is his security boundary.
2. `site/app.js` and `site/styles.css` changed after the last data build, so the next production rebuild gives a new build version. Cards and data are unchanged.

<!-- pipeline:json
{
  "schema_version": 1,
  "skill": "full-stack-tdd",
  "step": 7,
  "severity": {"critical": 0, "high": 0, "medium": 0, "low": 0},
  "completeness": 9,
  "confidence": 9,
  "findings": [
    {"severity": "high", "summary": "G1 fixed: 未核实 marker clipped by a long tool name (5a4fd21)"},
    {"severity": "medium", "summary": "G2 fixed: builder safety check weaker than the publisher's (8eb644a)"},
    {"severity": "medium", "summary": "G3-G7 covered: public footer link, keyboard order, new-element contrast, public safety of full text, inert markup and long text"},
    {"severity": "low", "summary": "Observed, not changed: validator does not check meta.replyCount and transcriptCount"}
  ]
}
-->
