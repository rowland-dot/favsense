// Issue 117: a resource card's description says what the tool does, in one Chinese sentence taken
// from the repository's own introduction. It is not a licence line, an install note or a "use the
// main repository" note. The registry feeds the card's description from its `usage_note` field
// (config/domain-profiles/software.json, resource_index.mapping.description).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const registryUrl = new URL("../references/software-resources.json", import.meta.url);
const profileUrl = new URL("../../../config/domain-profiles/software.json", import.meta.url);

const LICENCE_NAME = /(?:^|[^A-Za-z])(?:MIT|Apache(?:-?2(?:\.0)?)?|AGPL(?:-?3(?:\.0)?)?|L?GPL(?:-?[23](?:\.\d)?)?|BSD(?:-\d-Clause)?|MPL|CC-BY(?:-\d(?:\.\d)?)?|ISC)(?![A-Za-z])|许可证|开源协议/;
// Case matters: the command `pip` is lower case, while "PIP" is a performance-improvement plan.
const INSTALL_WORDING = /安装|下载|[Ii]nstall|\bnpm\b|\bnpx\b|\bpip\b|\bbrew\b|git clone|主仓库|旧仓库|使用前|不要默认/;
const MAX_LENGTH = 90;

// Returns the reasons a description is not "one sentence saying what the tool does".
export function introProblems(description) {
  const text = String(description ?? "");
  const problems = [];
  if (!text.trim()) return ["empty"];
  if (/[\r\n]/.test(text)) problems.push("more than one line");
  if (!/[一-鿿]/.test(text)) problems.push("not Chinese");
  if (!/[。！？]$/.test(text)) problems.push("does not end like a sentence");
  if ((text.match(/[。！？；]/g) || []).length !== 1) problems.push("not exactly one sentence");
  if ([...text].length > MAX_LENGTH) problems.push("too long");
  if (LICENCE_NAME.test(text)) problems.push("names a licence");
  if (INSTALL_WORDING.test(text)) problems.push("install or main-repository wording");
  return problems;
}

test("the card description comes from the registry field this test checks", () => {
  const profile = JSON.parse(readFileSync(profileUrl, "utf8"));
  assert.equal(profile.resource_index.mapping.description, "usage_note");
});

// The three descriptions the issue quotes as wrong, copied from the issue text.
for (const wrong of [
  "Apache-2.0；视频中的旧仓库已迁移到这里，安装时使用当前主仓库。",
  "MIT；按角色选择单项 Skill，并用产品事实、品牌语气、合规与人工发布统一验收。",
  "按具体产品阶段选择单项 Skill，不要默认安装全部工作流。",
]) {
  test(`the check refuses the issue's own example: ${wrong.slice(0, 18)}`, () => {
    assert.notDeepEqual(introProblems(wrong), []);
  });
}

test("the check accepts a plain one-sentence introduction", () => {
  assert.deepEqual(introProblems("面向 AI 编码助手的市场营销技能合集，覆盖文案、增长与转化优化。"), []);
});

test("the check refuses a licence line, two sentences, and an English-only line", () => {
  assert.ok(introProblems("MIT 协议的搜索工具。").includes("names a licence"));
  assert.ok(introProblems("一个搜索工具。它很快。").includes("not exactly one sentence"));
  assert.ok(introProblems("A search tool.").includes("not Chinese"));
});

test("every resource with a GitHub repository has a one-sentence introduction", () => {
  const { resources } = JSON.parse(readFileSync(registryUrl, "utf8"));
  // Entries without a GitHub repository (hosted products, documentation pages) have no repository
  // introduction to take, so they are outside this issue.
  const fromGitHub = resources.filter((resource) => /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(resource.repo || ""));
  assert.ok(fromGitHub.length > 100, `expected the GitHub-backed resources, found ${fromGitHub.length}`);
  const failures = fromGitHub
    .map((resource) => ({ name: resource.name, problems: introProblems(resource.usage_note), text: resource.usage_note }))
    .filter((entry) => entry.problems.length);
  assert.deepEqual(failures, []);
});
