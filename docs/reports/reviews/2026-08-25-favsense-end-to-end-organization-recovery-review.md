# FavSense end-to-end organization recovery — Step 5 Phase 1 review

Date: 2026-08-25  
Branch: `codex/favsense-organization-recovery`  
Reviewed head: `893a369`  
Review mode: dev-pipeline Step 5 Phase 1, branch-wide Fix-First

## Verdict

PASS. Every confirmed CRITICAL/HIGH finding was fixed atomically and independently re-reviewed. The approved Task 0–11 implementation is present, the trust and recovery boundaries remain fail-closed, and the current residual findings are five bounded LOW maintainability/contract-alignment items. No CRITICAL, HIGH, or MEDIUM issue remains.

## Scope and plan completion

The review covered the complete branch diff from `origin/main`, including the approved Spec, Plan, verification checklist, lifecycle gates, deterministic organization pipeline, point-summary persistence, curation/resource verification, dual formal-output transaction, local overlay, public UI, publisher, migration tooling, documentation, and tests.

Task 0–11 implementation evidence is recorded in `docs/reports/code/2026-08-23-favsense-end-to-end-organization-recovery-code.md`. This Phase 1 review checked the post-implementation branch rather than reopening the approved design. The resulting system preserves the required properties:

- core organization remains deterministic and independent of model services;
- captured, pending, accepted, failed, aborted, stale, built, and published states are not collapsed;
- public Skill output requires a current accepted review and one verified complete resource;
- official repository and ZIP actions use verified resource data rather than guessed links;
- formal knowledge and public output consume one frozen accepted snapshot;
- interrupted mutations, builds, summary batches, and publish claims recover or fail closed;
- migration remains synthetic-fixture/dry-run only in this pipeline;
- public output excludes private evidence, credentials, platform identifiers, and local recovery material.

The branch changes UI behavior, so Step 5 Phase 2 design review remains a separate pipeline phase. Phase 3 mockup parity is not applicable: the approved scope has no authored or tagged mockups to compare.

## Review army

Independent JavaScript, Python, and security reviewers re-read the affected production paths, their callers, and the regression tests after the final Fix-First commits. Their final verdicts were PASS with no remaining blocker:

| Reviewer | Final focus | Result |
|---|---|---|
| JavaScript | curation, snapshots, journals, migration, publisher, formal outputs, site behavior | PASS |
| Python | Bridge orchestration, summary batch persistence/recovery, local status projection, Windows behavior | PASS |
| Security | path containment, reparse/junction handling, journal/claim binding, public/private boundaries, credential minimization | PASS |

The Windows crash regression was included in the final review state. `_process_is_active()` uses `OpenProcess`/`GetExitCodeProcess`/`CloseHandle` on Windows and keeps `os.kill(pid, 0)` only on POSIX. The regression test asserts that the Windows branch never emits a console control event.

## Fix-First results

| Commit | Fixed blocker |
|---|---|
| `37900a7` | Made the PR lifecycle gate inspect real branch changes and fail closed. |
| `f240a87` | Rejected migration record IDs capable of escaping safe object/data boundaries. |
| `a61f470` | Bounded local OCR subprocess output and retained safe failure behavior. |
| `30e8477` | Exposed truthful organization, recovery, safety-stop, build, and publish states through Bridge and UI. |
| `b046b8f` | Froze the complete organization input set, exact scope, effective date, and target identities before dual-output publication. |
| `ba641d9` | Persisted final publish claims and receipts so restart/duplicate callbacks cannot publish twice or overwrite a terminal outcome. |
| `67c3198` | Serialized organization mutations across snapshot and migration paths. |
| `e1434c2` | Added durable interrupted point-summary batch recovery, including the safe Windows process probe. |
| `c1699b6` | Published only the frozen site claimed by the canonical build rather than mutable live bytes. |
| `1974a51` | Contained curation evidence paths beneath the authorized private evidence root. |
| `2746ef2` | Rejected point-summary lock reparse/junction escapes before mutation. |
| `412cc05` | Failed closed on corrupted, redirected, duplicate, or incomplete transaction journals. |
| `deaa0f1` | Closed the curation evidence validation/read race. |
| `76504b6` | Rejected Windows aliases and DOS-device IDs across summary and migration inputs. |
| `ca84d80` | Rejected foreign or mismatched point-summary journals instead of recovering another transaction. |
| `3371669` | Bound publish claims to the exact frozen manifest/bytes and expanded invalid/tampered claim coverage. |
| `601bad4` | Preserved a committed transaction generation when cleanup or recovery was interrupted. |
| `a6c0c86` | Contained publish-claim locks and rejected unsafe lock roots. |
| `893a369` | Bound journal reads to validated transaction storage and immutable participant identities. |

All fixes were kept as atomic `fix(review): ...` commits. No reset, revert, history rewrite, force-add, push, PR, merge, deploy, real platform mutation, or remote publication occurred.

## Verification matrix

Fresh post-Fix-First checks at `893a369`:

| Check | Result |
|---|---|
| `python -m unittest skills.xhs-diandian-summarize-note.tests.test_save_summary skills.xhs-diandian-summarize-note.tests.test_batch` | 29/29 PASS; Windows console-control regression included |
| `npm.cmd run test:organization` | 11/11 Python + 39/39 Node PASS |
| curation + publisher + organization snapshot/contracts Node suites | 99 PASS, 0 FAIL, 1 documented Git-for-Windows symlink-materialization skip |
| Final independent JavaScript review | PASS |
| Final independent Python review | PASS |
| Final independent security review | PASS |

The Step 4 code report also records the pre-review full release, Python discovery, desktop/mobile Playwright, privacy, syntax, accessibility, lifecycle, site, knowledge, publisher, and Windows contract baselines. Step 6 and Step 7 will run their own fresh full QA and coverage gates; this report does not substitute focused review evidence for those later stages.

All migration checks used synthetic temporary fixtures. No migration apply was run against real private data. Publisher checks used isolated local fixtures and did not publish remotely.

## Residual LOW findings

### LOW-001 — Evidence attachment performs repeated packet scans

`skills/xhs-favorites-organizer/scripts/normalize-evidence.mjs:27` and `:28` call `packets.find(...)` up to twice for every candidate. The result is O(C×P) work for large candidate/packet sets. Current dataset sizes make this informational; a keyed map is appropriate only when profiling shows this path matters.

### LOW-002 — Review merge performs a repeated decision scan

`skills/xhs-favorites-organizer/scripts/run-curation-pipeline.mjs:104` calls `review.find(...)` for every candidate, producing O(C×R) merge work. Exact-set validation protects correctness, so this is a bounded scalability concern rather than a data-integrity issue.

### LOW-003 — Missing personal-data detection is coupled to SDK error text

`site/hf-personal-sync.mjs:146` classifies an absent file using a broad `/404|not found|entry not found/i` match against SDK error text. An unrelated error containing those words could be treated as an empty personal dataset. This is LOW because it affects the optional personal-sync fallback and does not bypass formal-output trust gates; use a stable SDK status/code when the dependency exposes one.

### LOW-004 — Overlay transport verb differs from the approved Plan

The Plan specifies authenticated `GET /notes/organization-status?note_id=...` at `docs/plans/2026-08-22-favsense-end-to-end-organization-recovery-plan.md:576`, while `skills/xhs-favorites-organizer/scripts/bridge-server.py:5421` and `:5495` plus `site/app.js:1068` implement an authenticated POST body. Host/origin/token and payload validation still enforce the private boundary, so this is contract wording/implementation drift without a demonstrated security or user-result failure.

### LOW-005 — Authorized overlay failures are distinguishable

The Plan requests non-enumerating responses for invalid, unknown, and stale IDs at `docs/plans/2026-08-22-favsense-end-to-end-organization-recovery-plan.md:580`. `skills/xhs-favorites-organizer/scripts/bridge-server.py:4171`–`:4182` raises distinct messages and `:5505` returns the sanitized message. Exposure is limited to the authenticated loopback manager origin, so this is LOW defense-in-depth drift rather than an external enumeration vulnerability.

## Gate handoff

Phase 1 is ready for the Step 5 outer severity gate: residual CRITICAL and HIGH are zero. The five LOW items are informational and must remain visible in the final Brief unless resolved by a later authorized change.

CRITICAL=0 HIGH=0 MEDIUM=0 LOW=5
Completeness: 10/10  Confidence: 9/10
<!-- pipeline:json
{
  "schema_version": 1,
  "skill": "review",
  "step": 5,
  "phase": "phase-1",
  "severity": {
    "critical": 0,
    "high": 0,
    "medium": 0,
    "low": 5
  },
  "completeness": 10,
  "confidence": 9,
  "findings": [
    {
      "id": "LOW-001",
      "severity": "LOW",
      "summary": "Evidence attachment scans the packet list up to twice per candidate."
    },
    {
      "id": "LOW-002",
      "severity": "LOW",
      "summary": "Curation merge linearly scans review decisions for every candidate."
    },
    {
      "id": "LOW-003",
      "severity": "LOW",
      "summary": "Optional personal-data absence detection relies on broad SDK error-text matching."
    },
    {
      "id": "LOW-004",
      "severity": "LOW",
      "summary": "The authenticated local overlay uses POST although the approved Plan specifies GET."
    },
    {
      "id": "LOW-005",
      "severity": "LOW",
      "summary": "Authenticated loopback overlay failures distinguish invalid, unknown, and unavailable note IDs."
    }
  ]
}
-->
