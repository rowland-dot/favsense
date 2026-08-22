import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { verifyDevelopmentLifecycle } from "./verify-development-lifecycle.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "favsense-lifecycle-"));
  const files = {
    spec: "docs/specs/2026-08-23-feature-spec.md",
    plan: "docs/plans/2026-08-23-feature-plan.md",
    test: "docs/reports/code/2026-08-23-feature-code.md",
    review: "docs/reports/reviews/2026-08-23-feature-review.md",
    qa: "docs/reports/qa/2026-08-23-feature-qa-report.md",
    audit: "docs/reports/test-outcomes/2026-08-23-feature-test-outcome.md",
    brief: "docs/reports/briefs/2026-08-23-feature-brief.md",
  };
  for (const [kind, relative] of Object.entries(files)) {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    const content = kind === "spec"
      ? "# Feature Spec\n\nStatus: APPROVED\n"
      : kind === "plan"
        ? `# Feature Plan\n\nGoverning Spec: ${files.spec}\n`
        : kind === "brief"
          ? "# Brief\n\nRED/GREEN evidence: same assertion failed then passed.\n"
          : `# ${kind}\n`;
    await writeFile(join(root, relative), content);
  }
  return { root, files };
}

function completeEvent(files) {
  return {
    pull_request: {
      changed_files: ["site/app.js"],
      body: [
        `Spec: ${files.spec}`,
        `Plan: ${files.plan}`,
        `RED/GREEN evidence: ${files.test}`,
        `Review: ${files.review}`,
        `QA: ${files.qa}`,
        `Audit: ${files.audit}`,
        `Review brief: ${files.brief}`,
        "Rollback: revert the feature commit and keep the previous snapshot.",
        "- [x] Rollback reviewed",
      ].join("\n"),
    },
  };
}

test("rejects_behavior_change_without_approved_spec", async () => {
  const { root, files } = await fixture();
  await writeFile(join(root, files.spec), "# Draft\n\nStatus: DRAFT\n");
  const result = await verifyDevelopmentLifecycle({ root, event: completeEvent(files) });
  assert.deepEqual(result.failures.map((item) => item.id), ["LIFECYCLE_SPEC_NOT_APPROVED"]);
});

test("rejects_missing_plan_tdd_qa_or_brief_links", async () => {
  const { root, files } = await fixture();
  const event = completeEvent(files);
  event.pull_request.body = `Spec: ${files.spec}\nRollback: safe\n- [x] Rollback reviewed`;
  const result = await verifyDevelopmentLifecycle({ root, event });
  assert.deepEqual(result.failures.map((item) => item.id), [
    "LIFECYCLE_PLAN_MISSING", "LIFECYCLE_TEST_MISSING", "LIFECYCLE_REVIEW_MISSING",
    "LIFECYCLE_QA_MISSING", "LIFECYCLE_AUDIT_MISSING", "LIFECYCLE_BRIEF_MISSING",
  ]);
});

test("rejects_unchecked_rollback", async () => {
  const { root, files } = await fixture();
  const event = completeEvent(files);
  event.pull_request.body = event.pull_request.body.replace("- [x] Rollback reviewed", "- [ ] Rollback reviewed");
  const result = await verifyDevelopmentLifecycle({ root, event });
  assert.deepEqual(result.failures.map((item) => item.id), ["LIFECYCLE_ROLLBACK_UNCHECKED"]);
});

test("rejects_external_or_traversing_evidence_links", async () => {
  const { root, files } = await fixture();
  const event = completeEvent(files);
  event.pull_request.body = event.pull_request.body
    .replace(`QA: ${files.qa}`, "QA: https://example.invalid/report.md")
    .replace(`Review: ${files.review}`, "Review: ../review.md");
  const result = await verifyDevelopmentLifecycle({ root, event });
  assert.deepEqual(result.failures.map((item) => item.id), [
    "LIFECYCLE_REVIEW_INVALID", "LIFECYCLE_QA_INVALID",
  ]);
});

test("accepts_preexisting_approved_spec_and_plan", async () => {
  const { root, files } = await fixture();
  const result = await verifyDevelopmentLifecycle({ root, event: completeEvent(files) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
});

test("accepts_complete_pull_request_lifecycle", async () => {
  const { root, files } = await fixture();
  const result = await verifyDevelopmentLifecycle({ root, event: completeEvent(files) });
  assert.deepEqual(result, { ok: true, governed: true, failures: [] });
});

