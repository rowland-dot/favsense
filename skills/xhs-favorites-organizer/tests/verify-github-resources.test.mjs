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

// Owner ruling 2026-10-13 (issue #57): Chinese support statements count, replacing the 2026-10-11 English-only ruling.
test("the HollandCut line is evidence for both hosts: Codex by its Chinese support phrase, Claude Code by 'a Claude Code skill'", async () => {
  const result = await verify({ skill: GOOD_SKILL, readme: HOLLANDCUT_LINE, hosts: BOTH });
  assert.equal(result.status, "verified");
  assert.deepEqual(result.compatibility_evidence, ["README.md"]);
});

for (const [label, line, hosts] of [
  ["a host followed by 也能用", "这个工具 Codex 也能用。", ["Codex"]],
  ["支持 followed by a host", "本项目支持 Codex。", ["Codex"]],
  ["支持 followed by a host list", "支持 Claude Code、Codex 等主流宿主。", BOTH],
  ["适用于 followed by a host list", "适用于 Claude Code 和 Codex。", BOTH],
  ["可用于 followed by a host", "可用于 Codex 与 Cursor。", ["Codex"]],
]) {
  test(`Chinese support phrase counts: ${label}`, async () => {
    const result = await verify({ skill: GOOD_SKILL, readme: line, hosts });
    assert.equal(result.status, "verified");
  });
}

for (const [label, line, host] of [
  ["a Chinese support phrase that names a different host", "支持 Cursor 和 OpenCode。", "Codex"],
  ["a Chinese support phrase that names no host", "支持所有主流的智能体工具。", "Codex"],
  ["a host and a support phrase in different clauses", "Codex 的用户很多，另一个项目支持 Cursor。", "Codex"],
  ["a negated Chinese support phrase", "这个项目暂不支持 Codex。", "Codex"],
]) {
  test(`Chinese phrasing is not evidence: ${label}`, async () => {
    await assert.rejects(verify({ skill: GOOD_SKILL, readme: line, hosts: [host] }), /RESOURCE_COMPATIBILITY_(?:UNCONFIRMED|CONFLICT)/);
  });
}

test("a Chinese denial of the host is a denial even beside positive evidence", async () => {
  for (const sentence of ["本项目不支持 Codex。", "Codex 暂不支持。", "不适用于 Codex。", "无法用于 Codex。"]) {
    await assert.rejects(
      verify({ skill: GOOD_SKILL, readme: `${ANYDOC_LINE}\n${sentence}`, hosts: ["Codex"] }),
      /RESOURCE_COMPATIBILITY_CONFLICT/,
      sentence,
    );
  }
});

// Owner ruling 2026-10-13: "a <host> skill" counts, narrowly - article or 一个, then the host, then singular "skill".
for (const [label, line] of Object.entries({
  "'a <host> skill'": "A Claude Code skill that turns raw footage into a video.",
  "'an <host> skill'": "An Claude Code skill for editing.",
  "'一个 <host> skill'": "一个 Claude Code skill，用来剪视频。",
  "'a <host> skill' with markdown emphasis": "一个 **Claude Code skill**",
})) {
  test(`positive evidence for Claude Code from ${label}`, async () => {
    const result = await verify({ skill: GOOD_SKILL, readme: line, hosts: ["Claude Code"] });
    assert.equal(result.status, "verified");
  });
}

for (const [label, line] of Object.entries({
  "the plural": "Claude Code skills are listed in the table below.",
  "the host after the word skill": "A skill for Claude Code that turns raw footage into a video.",
  "no article": "Claude Code skill list.",
  "a negated phrase": "This is not a Claude Code skill.",
  "a different host in the phrase": "A Cursor skill that turns raw footage into a video.",
})) {
  test(`'a <host> skill' is narrow: not evidence from ${label}`, async () => {
    await assert.rejects(verify({ skill: GOOD_SKILL, readme: line, hosts: ["Claude Code"] }), /RESOURCE_COMPATIBILITY_UNCONFIRMED/);
  });
}

// ---- the official text of the two projects the 2026-10-13 curation run could not verify ----
// Lines copied verbatim from the official repositories, read-only, on 2026-10-13 (file and line numbers in each comment).

// heloraai/hollandcut README.md lines 5, 7 and 49
const HOLLANDCUT_OFFICIAL_README = [
  "一个 **Claude Code skill**（Codex 也能用）：把连续录制的中文口播，剪成 16:9 金色包装成片。效果强度分三档：lite / pro / max。",
  "A Claude Code skill that turns raw Chinese talking-head footage into a polished 16:9 video — retake removal, pacing, burned-in subtitles and animated graphics in three intensity tiers (lite / pro / max) — built on FFmpeg, whisper.cpp and Remotion.",
  "| Claude Code 或 Codex | 能看图 | 读转写和缩略图，写提案 / 剪辑规则 / 画面结构，按 SKILL.md 调脚本 | — |",
].join("\n");

// virgiliojr94/book-to-skill README.md line 72
const BOOK_TO_SKILL_OFFICIAL_README = "Works with any host that supports the open [Agent Skills](https://github.com/agentskills/agentskills) standard — GitHub Copilot CLI, Amp, Claude Code, Codex, Hermes Agent, OpenCode, and OpenClaw all read the same `SKILL.md` format.";

// virgiliojr94/book-to-skill SKILL.md line 413 (an install rule, neither a denial nor evidence) and lines 755-756 (run-report templates)
const BOOK_TO_SKILL_OFFICIAL_RULE_LINE = "2. **Claude Code does not scan `~/.agents/skills`** — after generation completes, Step 10 links the skill in with `ln -sfn \"$HOME/.agents/skills/<skill_name>\" \"$HOME/.claude/skills/<skill_name>\"`.";
const BOOK_TO_SKILL_OFFICIAL_REPORT_LINES = [
  "- `skipped-realdir` → \"Copilot CLI, Amp, Codex (natively); **NOT** Claude Code — migrate the real directory at ~/.claude/skills/<skill_name> first\"",
  "- `copy` or `absent` → \"Copilot CLI, Amp, Codex (natively); **NOT** Claude Code — the host could not create the symlink (a plain copy drifts on the next Update/Fold-in). Enable Developer Mode / create the link manually, or run the skill from ~/.agents/skills\"",
].join("\n");
const BOOK_TO_SKILL_OFFICIAL_SKILL = `${GOOD_SKILL}\n${BOOK_TO_SKILL_OFFICIAL_RULE_LINE}\n${BOOK_TO_SKILL_OFFICIAL_REPORT_LINES}\n`;

test("HollandCut's official README verifies for Claude Code and Codex", async () => {
  const result = await verify({ skill: GOOD_SKILL, readme: HOLLANDCUT_OFFICIAL_README, hosts: BOTH });
  assert.equal(result.status, "verified");
  assert.deepEqual(result.compatibility, ["Claude Code", "Codex"]);
  assert.deepEqual(result.compatibility_evidence, ["README.md"]);
});

test("book-to-skill's official text verifies for Codex only", async () => {
  const result = await verify({ skill: BOOK_TO_SKILL_OFFICIAL_SKILL, readme: BOOK_TO_SKILL_OFFICIAL_README, hosts: ["Codex"] });
  assert.equal(result.status, "verified");
  assert.deepEqual(result.compatibility, ["Codex"]);
  assert.deepEqual(result.compatibility_evidence, ["README.md"]);
});

test("book-to-skill's own run-report line 'NOT Claude Code' stays a denial, so Claude Code is a conflict", async () => {
  await assert.rejects(
    verify({ skill: BOOK_TO_SKILL_OFFICIAL_SKILL, readme: BOOK_TO_SKILL_OFFICIAL_README, hosts: ["Claude Code"] }),
    /RESOURCE_COMPATIBILITY_CONFLICT/,
  );
  await assert.rejects(
    verify({ skill: BOOK_TO_SKILL_OFFICIAL_SKILL, readme: BOOK_TO_SKILL_OFFICIAL_README, hosts: BOTH }),
    /RESOURCE_COMPATIBILITY_CONFLICT/,
  );
});

test("book-to-skill's install rule 'Claude Code does not scan ~/.agents/skills' is neither a denial nor evidence", async () => {
  await assert.rejects(
    verify({ skill: `${GOOD_SKILL}\n${BOOK_TO_SKILL_OFFICIAL_RULE_LINE}\n`, readme: "", hosts: ["Claude Code"] }),
    /RESOURCE_COMPATIBILITY_UNCONFIRMED/,
  );
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

// Owner ruling 2026-10-13 (issue #57): the host list after the dash counts, but only for this exact shape.
const STANDARD_LIST_LINE = "Works with any host that supports the open [Agent Skills](https://example.com/standard) standard — GitHub Copilot CLI, Amp, Claude Code, Codex, Hermes Agent, OpenCode, and OpenClaw all read the same `SKILL.md` format.";

test("a works-with-any-host-that-supports sentence with the hosts after a dash is evidence for those hosts", async () => {
  const result = await verify({ skill: GOOD_SKILL, readme: STANDARD_LIST_LINE, hosts: ["Codex", "Claude Code"] });
  assert.equal(result.status, "verified");
});

test("the list after the dash is not evidence for a host it does not name", async () => {
  await assert.rejects(verify({ skill: GOOD_SKILL, readme: STANDARD_LIST_LINE, hosts: ["Cursor"] }), /RESOURCE_COMPATIBILITY_UNCONFIRMED/);
});

test("a host named after a dash in any other works-with sentence is still not evidence", async () => {
  for (const sentence of [
    "Works with Cursor — unlike Codex, which needs a plugin.",
    "Works with the open standard — Codex has its own format.",
  ]) {
    await assert.rejects(verify({ skill: GOOD_SKILL, readme: sentence, hosts: ["Codex"] }), /RESOURCE_COMPATIBILITY_UNCONFIRMED/, sentence);
  }
});

test("a denial inside the list after the dash still wins", async () => {
  const sentence = "Works with any host that supports the open Agent Skills standard — everything except Codex.";
  await assert.rejects(verify({ skill: GOOD_SKILL, readme: sentence, hosts: ["Codex"] }), /RESOURCE_COMPATIBILITY_CONFLICT/);
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
