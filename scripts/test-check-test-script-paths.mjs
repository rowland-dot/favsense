import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { findTestScriptProblems } from "./check-test-script-paths.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checker = join(root, "scripts", "check-test-script-paths.mjs");
const realScripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
const noOrganizationFiles = () => [];

// Return a copy of the real script map with the space between two adjacent
// file names removed, so the two names become one path.
function glueInScript(name) {
  const tokens = realScripts[name].split(" ");
  const at = tokens.findIndex((token, i) => /\.(?:mjs|cjs|js|py|ps1)$/.test(token) && /\.(?:mjs|cjs|js|py|ps1)$/.test(tokens[i + 1] || ""));
  assert.ok(at >= 0, `${name} has two adjacent file names to glue`);
  const joined = tokens[at] + tokens[at + 1];
  tokens.splice(at, 2, joined);
  return { scripts: { ...realScripts, [name]: tokens.join(" ") }, joined };
}

test("the current tree has no joined or missing test paths", () => {
  assert.deepEqual(findTestScriptProblems({ root, scripts: realScripts, organizationFiles: noOrganizationFiles }), []);
});

for (const name of ["test:site", "test:curation"]) {
  test(`gluing two neighbours in ${name} fails and names the script and the joined path`, () => {
    const { scripts, joined } = glueInScript(name);
    const problems = findTestScriptProblems({ root, scripts, organizationFiles: noOrganizationFiles });
    assert.ok(problems.some((problem) => problem.includes(name) && problem.includes(joined)), problems.join("\n"));
  });
}

test("a script pointing at a file that does not exist fails and names the path", () => {
  const scripts = { ...realScripts, "test:site": `${realScripts["test:site"]} scripts/no-such-test.mjs` };
  const problems = findTestScriptProblems({ root, scripts, organizationFiles: noOrganizationFiles });
  assert.ok(problems.some((problem) => problem.includes("test:site") && problem.includes("scripts/no-such-test.mjs")), problems.join("\n"));
});

test("a missing file in the organization runner's own list fails and names the path", () => {
  const problems = findTestScriptProblems({
    root,
    scripts: realScripts,
    organizationFiles: () => ["skills/xhs-favorites-organizer/tests/test_missing_organization.mjs"],
  });
  assert.ok(problems.some((problem) => problem.includes("test_missing_organization.mjs")), problems.join("\n"));
});

test("a joined name in the organization runner's list fails", () => {
  const problems = findTestScriptProblems({
    root,
    scripts: realScripts,
    organizationFiles: () => ["skills/xhs-favorites-organizer/tests/test_formal_outputs.mjsskills/xhs-favorites-organizer/tests/test_organization_contracts.mjs"],
  });
  assert.ok(problems.length > 0);
});

test("the command line exits non-zero on a glued script map and zero on the real tree", async () => {
  assert.equal(spawnSync(process.execPath, [checker], { cwd: root }).status, 0);
  const fixture = await mkdtemp(join(tmpdir(), "favsense-test-paths-"));
  try {
    const { scripts } = glueInScript("test:site");
    await writeFile(join(fixture, "package.json"), JSON.stringify({ scripts }), "utf8");
    const result = spawnSync(process.execPath, [checker, fixture], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /test:site/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("the checker runs first in npm test as a plain node call, so a glued entry cannot be skipped", () => {
  assert.match(realScripts["check:test-paths"], /^node scripts\/check-test-script-paths\.mjs$/);
  assert.match(realScripts.test, /^npm run check:test-paths && /);
  // Plain `node <missing file>` errors under every Node version, unlike one more argument to `node --test`.
  const glued = spawnSync(process.execPath, [`${checker}scripts/test-check-syntax.mjs`], { encoding: "utf8" });
  assert.notEqual(glued.status, 0);
});

test("the checker's own test file is listed in a test script", () => {
  assert.match(realScripts["test:release-contracts"], /(?:^|\s)scripts\/test-check-test-script-paths\.mjs(?:\s|$)/);
});
