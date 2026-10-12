import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { verifyDevelopmentLifecycle, readGitHubIssue } from "./verify-development-lifecycle.mjs";

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

test("fails closed when GitHub reports only a changed-file count without diff SHAs", async () => {
  const { root, files } = await fixture();
  const event = completeEvent(files);
  event.pull_request.changed_files = 1;
  const result = await verifyDevelopmentLifecycle({ root, event });
  assert.deepEqual(result, {
    ok: false,
    governed: true,
    failures: [{ id: "LIFECYCLE_CHANGED_FILES_UNAVAILABLE" }],
  });
});

test("uses the checked-out base and head diff for a real GitHub PR payload", async () => {
  const { root, files } = await fixture();
  const event = completeEvent(files);
  event.pull_request.changed_files = 1;
  event.pull_request.base = { sha: "a".repeat(40) };
  event.pull_request.head = { sha: "b".repeat(40) };
  const result = await verifyDevelopmentLifecycle({
    root,
    event,
    diffFiles: async ({ base, head }) => {
      assert.equal(base, "a".repeat(40));
      assert.equal(head, "b".repeat(40));
      return ["site/app.js"];
    },
  });
  assert.deepEqual(result, { ok: true, governed: true, failures: [] });
});

test("includes governed file deletions when deriving the PR diff", async () => {
  const { root, files } = await fixture();
  const event = completeEvent(files);
  event.pull_request.changed_files = 2;
  event.pull_request.base = { sha: "a".repeat(40) };
  event.pull_request.head = { sha: "b".repeat(40) };
  const result = await verifyDevelopmentLifecycle({
    root,
    event,
    diffFiles: async ({ args }) => {
      assert.deepEqual(args, ["diff", "--name-only", `${"a".repeat(40)}...${"b".repeat(40)}`]);
      return ["site/deleted-app.js", "docs/notes.md"];
    },
  });
  assert.equal(result.governed, true);
  assert.equal(result.ok, true);
});

// --- Issue path: a PR that closes a ready-for-agent issue needs only test evidence and a rollback ---

const READY = ["enhancement", "ready-for-agent"];

function issuePathBody({
  closing = "Fixes #7",
  testPlan = "## Test plan\n- [x] npm run release:check",
  rollback = "## Rollback\nRollback: revert the commit.\n- [x] Rollback reviewed",
} = {}) {
  return ["## Summary", "Does the thing.", closing, "", testPlan, "", rollback].filter((line) => line !== null).join("\n");
}

function issuePathEvent(body) {
  return {
    repository: { full_name: "rowland-dot/favsense" },
    pull_request: { changed_files: ["scripts/example.mjs"], body },
  };
}

// A fake issue reader that records every call, so tests can also assert it was NOT used.
function fakeReader(issues) {
  const calls = [];
  const readIssue = async ({ number, repository }) => {
    calls.push({ number, repository });
    const issue = issues[number];
    if (issue instanceof Error) throw issue;
    if (!issue) throw new Error(`no fake issue ${number}`);
    return issue;
  };
  return { readIssue, calls };
}

test("accepts_a_pr_closing_a_ready_for_agent_issue_with_test_evidence_and_rollback", async () => {
  const { root } = await fixture();
  const { readIssue, calls } = fakeReader({ 7: { labels: READY, isPullRequest: false } });
  const result = await verifyDevelopmentLifecycle({ root, event: issuePathEvent(issuePathBody()), readIssue });
  assert.deepEqual(result, { ok: true, governed: true, failures: [] });
  assert.deepEqual(calls, [{ number: 7, repository: "rowland-dot/favsense" }]);
});

test("reads_a_closed_issue_and_flags_a_pull_request_through_the_github_issues_endpoint", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), auth: init?.headers?.Authorization });
    const number = Number(String(url).split("/").pop());
    const payload = number === 8
      ? { state: "closed", labels: [{ name: "ready-for-agent" }, { name: "bug" }] }
      : { state: "closed", labels: [{ name: "ready-for-agent" }], pull_request: { url: "x" } };
    return { ok: true, status: 200, json: async () => payload };
  };
  const issue = await readGitHubIssue({ number: 8, repository: "rowland-dot/favsense", token: "t0ken", fetchImpl });
  assert.deepEqual(issue, { labels: ["ready-for-agent", "bug"], isPullRequest: false });
  const pr = await readGitHubIssue({ number: 38, repository: "rowland-dot/favsense", token: "t0ken", fetchImpl });
  assert.equal(pr.isPullRequest, true);
  assert.deepEqual(seen.map((item) => item.url), [
    "https://api.github.com/repos/rowland-dot/favsense/issues/8",
    "https://api.github.com/repos/rowland-dot/favsense/issues/38",
  ]);
  assert.equal(seen[0].auth, "Bearer t0ken");
});

test("reading_an_issue_fails_loudly_on_a_non_2xx_answer_or_a_missing_repository", async () => {
  const notFound = async () => ({ ok: false, status: 404, json: async () => ({}) });
  await assert.rejects(readGitHubIssue({ number: 9, repository: "rowland-dot/favsense", token: "t", fetchImpl: notFound }), /404/);
  await assert.rejects(readGitHubIssue({ number: 9, repository: undefined, token: "t", fetchImpl: notFound }), /repository/i);
});

async function issuePathIds(body, issues = { 7: { labels: READY, isPullRequest: false } }) {
  const { root } = await fixture();
  const { readIssue } = fakeReader(issues);
  const result = await verifyDevelopmentLifecycle({ root, event: issuePathEvent(body), readIssue });
  return result.failures.map((item) => item.id);
}

test("issue_path_reports_only_missing_test_evidence_when_the_test_plan_is_absent_or_unchecked", async () => {
  // The rollback block sits under its own heading, so its checked box cannot count as test evidence.
  assert.deepEqual(await issuePathIds(issuePathBody({ testPlan: null })), ["LIFECYCLE_TEST_PLAN_MISSING"]);
  assert.deepEqual(
    await issuePathIds(issuePathBody({ testPlan: "## Test plan\n- [ ] npm run release:check" })),
    ["LIFECYCLE_TEST_PLAN_MISSING"],
  );
  assert.deepEqual(
    await issuePathIds(issuePathBody({ testPlan: "## Notes\n- [x] a checked box under another heading" })),
    ["LIFECYCLE_TEST_PLAN_MISSING"],
  );
  assert.deepEqual(
    await issuePathIds(issuePathBody({ testPlan: "## test PLAN\r\n- [x] checked, odd case and CRLF" })),
    [],
  );
});

test("issue_path_reports_only_the_rollback_failure_that_applies", async () => {
  assert.deepEqual(
    await issuePathIds(issuePathBody({ rollback: "## Rollback\n- [x] Rollback reviewed" })),
    ["LIFECYCLE_ROLLBACK_MISSING"],
  );
  assert.deepEqual(
    await issuePathIds(issuePathBody({ rollback: "## Rollback\nRollback: revert the commit.\n- [ ] Rollback reviewed" })),
    ["LIFECYCLE_ROLLBACK_UNCHECKED"],
  );
});

test("an_unlabelled_issue_or_a_pull_request_reference_keeps_the_file_evidence_rules_exactly", async () => {
  const { root, files } = await fixture();
  const base = `Spec: ${files.spec}\nRollback: safe\n- [x] Rollback reviewed`;
  const plain = await verifyDevelopmentLifecycle({ root, event: issuePathEvent(base) });
  assert.deepEqual(plain.failures.map((item) => item.id), [
    "LIFECYCLE_PLAN_MISSING", "LIFECYCLE_TEST_MISSING", "LIFECYCLE_REVIEW_MISSING",
    "LIFECYCLE_QA_MISSING", "LIFECYCLE_AUDIT_MISSING", "LIFECYCLE_BRIEF_MISSING",
  ]);
  for (const issue of [{ labels: ["bug"], isPullRequest: false }, { labels: READY, isPullRequest: true }]) {
    const { readIssue, calls } = fakeReader({ 7: issue });
    const result = await verifyDevelopmentLifecycle({ root, event: issuePathEvent(`${base}\nFixes #7`), readIssue });
    assert.deepEqual(result, plain);
    assert.equal(calls.length, 1);
  }
});

test("any_one_referenced_ready_for_agent_issue_selects_the_issue_path", async () => {
  const { root } = await fixture();
  const { readIssue } = fakeReader({
    5: { labels: ["bug"], isPullRequest: false },
    7: { labels: READY, isPullRequest: false },
  });
  const result = await verifyDevelopmentLifecycle({ root, event: issuePathEvent(issuePathBody({ closing: "closes #5, Resolves: #7" })), readIssue });
  assert.deepEqual(result, { ok: true, governed: true, failures: [] });
});

test("failing_to_read_an_issue_fails_closed_with_its_own_failure_id", async () => {
  const { root } = await fixture();
  const { readIssue } = fakeReader({ 7: new Error("network down") });
  const result = await verifyDevelopmentLifecycle({ root, event: issuePathEvent(issuePathBody()), readIssue });
  assert.deepEqual(result, { ok: false, governed: true, failures: [{ id: "LIFECYCLE_ISSUE_UNAVAILABLE" }] });
});

test("a_pr_that_touches_no_governed_path_never_reads_an_issue", async () => {
  const { root } = await fixture();
  const { readIssue, calls } = fakeReader({ 7: { labels: READY, isPullRequest: false } });
  const event = issuePathEvent("Fixes #7");
  event.pull_request.changed_files = ["docs/notes.md"];
  const result = await verifyDevelopmentLifecycle({ root, event, readIssue });
  assert.deepEqual(result, { ok: true, governed: false, failures: [] });
  assert.deepEqual(calls, []);
});

// --- The workflow and the two contributor documents must describe and enable the issue path ---

async function repoText(relative) {
  const { readFile } = await import("node:fs/promises");
  return (await readFile(new URL(`../${relative}`, import.meta.url), "utf8")).replaceAll("\r\n", "\n");
}

test("ci_workflow_lets_the_lifecycle_step_read_issues", async () => {
  const workflow = await repoText(".github/workflows/ci.yml");
  assert.match(workflow.split("\njobs:")[0], /^permissions:\n  contents: read\n  issues: read$/m);
  const step = workflow.split("- name: Verify PR development lifecycle")[1];
  assert.ok(step, "lifecycle step exists");
  assert.match(step, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
});

test("pr_template_and_contributing_describe_both_lifecycle_paths", async () => {
  const template = await repoText(".github/PULL_REQUEST_TEMPLATE.md");
  assert.match(template, /ready-for-agent/);
  assert.match(template, /Fixes #/);
  assert.match(template, /^## Test plan$/m);
  const contributing = await repoText("CONTRIBUTING.md");
  const sections = contributing.split(/^## /m);
  for (const heading of ["开始之前", "Pull Request"]) {
    const section = sections.find((text) => text.startsWith(heading));
    assert.ok(section, `${heading} section exists`);
    assert.match(section, /ready-for-agent/, `${heading} names the issue path`);
  }
});
