import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyGitHubResource } from "../scripts/verify-github-resources.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/verify-github-resources.mjs", import.meta.url));

const REPOSITORY = { full_name: "owner/repo", name: "repo", default_branch: "main", stargazers_count: 7, license: { spdx_id: "MIT" } };

function manifest(fields) {
  return `---\n${fields}\n---\n`;
}

function offlineFetch({ skill, readme }) {
  return async (url) => {
    const text = String(url);
    if (text.endsWith("/repos/owner/repo")) return new Response(JSON.stringify(REPOSITORY), { status: 200 });
    if (text.includes("/contents/SKILL.md?")) return new Response(skill, { status: 200 });
    if (text.includes("/contents/README.md?")) return new Response(readme, { status: 200 });
    return new Response("", { status: 404 });
  };
}

// The clock is fixed so these tests do not depend on the real UTC date of the machine running them.
const NOON_UTC_OCT_12 = () => Date.parse("2026-10-12T12:00:00Z");

function verify({ skill, readme, hosts, today = "2026-10-12", now = NOON_UTC_OCT_12 }) {
  return verifyGitHubResource(
    { canonical_repo: "owner/repo", manifest_path: "SKILL.md", compatibility: hosts, compatibility_evidence: ["README.md"] },
    { today, now, fetch: offlineFetch({ skill, readme }) },
  );
}

const GOOD_SKILL = manifest("name: demo\ndescription: Official synthetic Skill fixture");
const CODEX_README = "Compatibility: Codex";
const BOTH = ["Claude Code", "Codex"];

// ---- manifest: name and description are read as YAML ----

const ACCEPTED_VALUES = {
  "single line": (key) => `${key}: Official synthetic value`,
  "one character": (key) => `${key}: x`,
  "folded block": (key) => `${key}: >\n  Folded text\n  on two lines`,
  "literal block with strip": (key) => `${key}: |-\n  Literal text`,
  "double quoted": (key) => `${key}: "Quoted text"`,
};

const REJECTED_VALUES = {
  "empty double quotes": (key) => `${key}: ""`,
  "whitespace only in quotes": (key) => `${key}: "   "`,
  "folded block with no content": (key) => `${key}: >`,
  "literal block with no content": (key) => `${key}: |-`,
};

for (const key of ["name", "description"]) {
  const other = key === "name" ? "description: Official synthetic Skill fixture" : "name: demo";
  for (const [label, build] of Object.entries(ACCEPTED_VALUES)) {
    test(`manifest accepts ${key} as ${label}`, async () => {
      const result = await verify({ skill: manifest(`${other}\n${build(key)}`), readme: CODEX_README, hosts: ["Codex"] });
      assert.equal(result.status, "verified");
    });
  }
  for (const [label, build] of Object.entries(REJECTED_VALUES)) {
    test(`manifest rejects ${key} as ${label}`, async () => {
      await assert.rejects(
        verify({ skill: manifest(`${other}\n${build(key)}`), readme: CODEX_README, hosts: ["Codex"] }),
        /RESOURCE_MANIFEST_INVALID/,
      );
    });
  }
  test(`manifest rejects a missing ${key}`, async () => {
    await assert.rejects(verify({ skill: manifest(other), readme: CODEX_README, hosts: ["Codex"] }), /RESOURCE_MANIFEST_INVALID/);
  });
  test(`manifest rejects ${key} that exists only under a nested key`, async () => {
    await assert.rejects(
      verify({ skill: manifest(`${other}\nmetadata:\n  ${key}: Nested value`), readme: CODEX_README, hosts: ["Codex"] }),
      /RESOURCE_MANIFEST_INVALID/,
    );
  });
}

// ---- positive compatibility evidence from plain English ----

const ANYDOC_LINE = "Works with [Claude Code](https://claude.ai/code), [Codex](https://openai.com/codex/), [Cursor](https://cursor.com), [OpenCode](https://opencode.ai), and any other [compatible agent](https://agentskills.io/clients).";
const ADVISE_LINE = "Its portable SKILL.md can be loaded by Codex, Claude Code, pi, Hermes, and other Agent Skills-compatible harnesses.";
const ADVISE_LINE_WITH_CODE_SPAN = "Its portable `SKILL.md` can be loaded by Codex, Claude Code, pi, Hermes, and other Agent Skills-compatible harnesses.";
const PONYTAIL_LINE = "Commands need a skill-capable host (Claude Code, Codex, Devin CLI, OpenCode, Gemini, pi, Hermes Agent, Qoder, Grok Build).";
const HOLLANDCUT_LINE = "一个 **Claude Code skill**（Codex 也能用）";

for (const [label, line] of Object.entries({
  "a works-with sentence with linked host names": ANYDOC_LINE,
  "a can-be-loaded-by sentence": ADVISE_LINE,
  "a can-be-loaded-by sentence with a code span": ADVISE_LINE_WITH_CODE_SPAN,
  "a needs-a-skill-capable-host sentence": PONYTAIL_LINE,
})) {
  test(`positive evidence for both hosts from ${label}`, async () => {
    const result = await verify({ skill: GOOD_SKILL, readme: line, hosts: BOTH });
    assert.equal(result.status, "verified");
    assert.deepEqual(result.compatibility_evidence, ["README.md"]);
  });
}

for (const sentence of [
  "This Skill supports Codex.",
  "Supported by Codex and Cursor.",
  "Supported in Codex.",
  "Supported on Codex.",
  "It is working with Codex today.",
  "Requires a host (Codex).",
]) {
  test(`positive evidence from the inflection "${sentence}"`, async () => {
    const result = await verify({ skill: GOOD_SKILL, readme: sentence, hosts: ["Codex"] });
    assert.equal(result.status, "verified");
  });
}

test("Chinese phrasing is not compatibility evidence for either host", async () => {
  await assert.rejects(verify({ skill: GOOD_SKILL, readme: HOLLANDCUT_LINE, hosts: BOTH }), /RESOURCE_COMPATIBILITY_UNCONFIRMED/);
});

test("a host named only in an install heading or a table row is not evidence", async () => {
  await assert.rejects(
    verify({ skill: GOOD_SKILL, readme: "**Codex:**\n| Codex | ~/.codex/skills/ |", hosts: ["Codex"] }),
    /RESOURCE_COMPATIBILITY_UNCONFIRMED/,
  );
});

test("support for one listed host is not evidence for a host that is not listed", async () => {
  await assert.rejects(
    verify({ skill: GOOD_SKILL, readme: "Works with Cursor and OpenCode.", hosts: ["Codex"] }),
    /RESOURCE_COMPATIBILITY_UNCONFIRMED/,
  );
});

// ---- a negation is a denial only when it is about the host ----

test("an unrelated 'without' in the same sentence is neither denial nor evidence", async () => {
  await assert.rejects(
    verify({ skill: GOOD_SKILL, readme: "Benchmarked in Claude Code, the same agent with and without the skill", hosts: ["Claude Code"] }),
    /RESOURCE_COMPATIBILITY_UNCONFIRMED/,
  );
});

test("an unrelated 'without' elsewhere does not veto a positive sentence about the same host", async () => {
  const readme = [
    "Benchmarked in Claude Code, the same agent with and without the skill",
    PONYTAIL_LINE,
    "The instruction-only adapters load the always-on ruleset without the commands.",
  ].join("\n");
  const result = await verify({ skill: GOOD_SKILL, readme, hosts: BOTH });
  assert.equal(result.status, "verified");
  assert.deepEqual(result.compatibility_evidence, ["README.md"]);
});

test("a 'without the commands' sentence in the same paragraph as the support sentence is not a denial", async () => {
  const readme = `${PONYTAIL_LINE} The instruction-only adapters load the always-on ruleset without the commands.`;
  const result = await verify({ skill: GOOD_SKILL, readme, hosts: BOTH });
  assert.equal(result.status, "verified");
});

test("a negation about a different agent in the same sentence is not a denial for Codex", async () => {
  const readme = "Copilot CLI, Amp, Codex, OpenCode, and OpenClaw discover one copy natively, while Hermes Agent partitions its personal skills by category and does not scan the cross-agent root.";
  await assert.rejects(verify({ skill: GOOD_SKILL, readme, hosts: ["Codex"] }), /RESOURCE_COMPATIBILITY_UNCONFIRMED/);
});

test("a negation that names the host directly is a denial", async () => {
  for (const sentence of [
    "NOT Claude Code — migrate the real directory instead.",
    "Works with Codex but not with Claude Code.",
    "Works with everything except Claude Code.",
  ]) {
    await assert.rejects(
      verify({ skill: GOOD_SKILL, readme: `${ANYDOC_LINE}\n${sentence}`, hosts: ["Claude Code"] }),
      /RESOURCE_COMPATIBILITY_CONFLICT/,
      sentence,
    );
  }
});

test("markdown emphasis around the negation does not hide the denial (book-to-skill run-report line)", async () => {
  const readme = "- `skipped-realdir` → \"Copilot CLI, Amp, Codex (natively); **NOT** Claude Code — migrate the real directory at ~/.claude/skills/<skill_name> first\"";
  await assert.rejects(
    verify({ skill: GOOD_SKILL, readme: `${ANYDOC_LINE}\n${readme}`, hosts: ["Claude Code"] }),
    /RESOURCE_COMPATIBILITY_CONFLICT/,
  );
  await assert.rejects(verify({ skill: GOOD_SKILL, readme, hosts: ["Codex"] }), /RESOURCE_COMPATIBILITY_UNCONFIRMED/);
});

test("a works-with sentence that only names a standard, with the hosts after a dash, is not evidence for those hosts", async () => {
  const readme = "Works with any host that supports the open [Agent Skills](https://example.com/standard) standard — GitHub Copilot CLI, Amp, Claude Code, Codex, Hermes Agent, OpenCode, and OpenClaw all read the same `SKILL.md` format.";
  await assert.rejects(verify({ skill: GOOD_SKILL, readme, hosts: ["Codex"] }), /RESOURCE_COMPATIBILITY_UNCONFIRMED/);
});

test("a negated support statement that names the host is a denial even beside a positive one", async () => {
  for (const sentence of [
    "This project does not support Codex.",
    "This project isn’t compatible with Codex.",
    "This project cannot support Codex.",
    "Codex is not supported.",
  ]) {
    await assert.rejects(
      verify({ skill: GOOD_SKILL, readme: `${ANYDOC_LINE}\n${sentence}`, hosts: ["Codex"] }),
      /RESOURCE_COMPATIBILITY_CONFLICT/,
      sentence,
    );
  }
});

test("explicit compatibility declarations keep their strict parsing", async () => {
  for (const declaration of [
    "Compatibility: incompatible with Codex",
    "Compatibility: all except Codex",
    "Compatibility: works with Codex",
  ]) {
    await assert.rejects(
      verify({ skill: GOOD_SKILL, readme: declaration, hosts: ["Codex"] }),
      /RESOURCE_COMPATIBILITY_(?:CONFLICT|UNCONFIRMED)/,
      declaration,
    );
  }
});

test("a declaration line still wins over an unrelated sentence in the same file", async () => {
  const result = await verify({ skill: GOOD_SKILL, readme: "Compatibility: Codex\nBenchmarked with and without the skill in Codex.", hosts: ["Codex"] });
  assert.equal(result.status, "verified");
});

// ---- the verification date never runs ahead of the UTC calendar day the build uses ----

// 2026-10-11 15:05 UTC is 2026-10-12 02:05 in Sydney: the evening run that wrote a date the build still saw as the future.
const SYDNEY_MORNING_STILL_OCT_11_UTC = () => Date.parse("2026-10-11T15:05:00Z");

test("a date later than the current UTC day is refused", async () => {
  await assert.rejects(
    verify({ skill: GOOD_SKILL, readme: CODEX_README, hosts: ["Codex"], today: "2026-10-12", now: SYDNEY_MORNING_STILL_OCT_11_UTC }),
    /RESOURCE_VERIFIER_DATE_AHEAD_OF_UTC/,
  );
});

test("the current UTC day is accepted and written as the verification date", async () => {
  const result = await verify({ skill: GOOD_SKILL, readme: CODEX_README, hosts: ["Codex"], today: "2026-10-11", now: SYDNEY_MORNING_STILL_OCT_11_UTC });
  assert.equal(result.verified_at, "2026-10-11");
});

test("the command line refuses a date later than the current UTC day and writes no output file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "verifier-utc-"));
  try {
    const input = join(dir, "candidates.json");
    const output = join(dir, "resources.json");
    await writeFile(input, JSON.stringify([{ canonical_repo: "owner/repo", manifest_path: "SKILL.md", compatibility: ["Codex"], compatibility_evidence: ["README.md"] }]));
    const run = spawnSync(process.execPath, [SCRIPT, "--input", input, "--output", output, "--today", "2999-01-01"], { encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /RESOURCE_VERIFIER_DATE_AHEAD_OF_UTC/);
    assert.equal(existsSync(output), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
