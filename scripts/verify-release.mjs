#!/usr/bin/env node

import { readFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertPublicTextSafe, validatePublicTree } from "../skills/xhs-favorites-organizer/scripts/public-tree-policy.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const requiredFiles = [
  "README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "AGENTS.md", "CLAUDE.md",
  "CHANGELOG.md", "ROADMAP.md", "docs/ARCHITECTURE.md", "docs/PUBLISHING.md", "docs/RESOURCE_INDEX.md",
  ".github/workflows/ci.yml", ".github/PULL_REQUEST_TEMPLATE.md", ".github/REPOSITORY_METADATA.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml", ".github/ISSUE_TEMPLATE/feature_request.yml",
  "config/domain-profiles/software.json", "config/domain-profiles/fitness.json", "config/domain-profiles/skincare.json",
  "config/xhs-favorites.example.json",
  "config/resource-registries/fitness.example.json", "config/resource-registries/skincare.example.json",
  "skills/xhs-diandian-summarize-note/SKILL.md",
  "skills/xhs-diandian-summarize-note/scripts/save_diandian_summary.py",
  "skills/xhs-diandian-summarize-note/scripts/save_diandian_batch.py",
  "favsense.ps1", "scripts/run-python-tests.mjs", "scripts/run-organization-tests.mjs", "scripts/check-syntax.mjs", "scripts/verify-development-lifecycle.mjs", "site/index.html", "site/app.js", "site/resource-utils.mjs", "site/personal-store.mjs", "site/hf-personal-sync.mjs", "site/hf-sync-guard.mjs", "site/data/knowledge.json",
  "skills/xhs-favorites-organizer/scripts/build-public-site.mjs", "skills/xhs-favorites-organizer/scripts/evidence-stats.mjs",
  "skills/xhs-favorites-organizer/scripts/curation-quality.mjs",
  "skills/xhs-favorites-organizer/scripts/public-tree-policy.mjs",
  "skills/xhs-favorites-organizer/scripts/prepare-curation-scope.mjs",
  "skills/xhs-favorites-organizer/scripts/prepare-curation-review.mjs",
  "skills/xhs-favorites-organizer/scripts/merge-curation-results.mjs",
  "skills/xhs-favorites-organizer/scripts/initialize-curation-audit.mjs",
  "skills/xhs-favorites-organizer/scripts/publish-huggingface.mjs", "skills/xhs-favorites-organizer/scripts/setup-xhs-downloader.ps1", "skills/xhs-favorites-organizer/scripts/validate-curation.mjs",
  "skills/xhs-favorites-organizer/references/curation-standard.md"
];

const privatePathPatterns = [
  /^\.xhs-favorites(?:\/|$)/i,
  /^\.xhs-tools(?:\/|$)/i,
  /^config\/xhs-favorites\.json$/i,
  /^knowledge-base(?:\/|$)/i,
  /^site\/\.local(?:\/|$)/i,
];
const obsoleteFiles = [
  "skills/xhs-favorites-organizer/references/redbook-adapter.md",
  "skills/xhs-favorites-organizer/scripts/fetch-and-organize.ps1",
  "skills/xhs-favorites-organizer/scripts/import-from-clipboard.ps1",
  "skills/xhs-favorites-organizer/scripts/install-windows-task.ps1",
  "skills/xhs-favorites-organizer/scripts/patch-redbook-cdp.mjs",
];
const privateIgnoreProbes = [
  ".xhs-favorites/release-boundary.probe",
  ".xhs-tools/release-boundary.probe",
  "knowledge-base/release-boundary.probe",
  "config/xhs-favorites.json",
  "site/.local/bridge.json",
];

export function findTrackedPrivatePaths(workspaceRoot, { spawn = spawnSync } = {}) {
  const result = spawn("git", ["ls-files", "-z"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("git ls-files could not inspect the release boundary");
  return String(result.stdout || "")
    .split("\0")
    .filter(Boolean)
    .map((file) => ({ file: file.replaceAll("\\", "/"), comparable: file.replaceAll("\\", "/").toLowerCase() }))
    .filter(({ file, comparable }) => (
      /[^\x20-\x7e]/.test(file)
      || privatePathPatterns.some((pattern) => pattern.test(comparable))
    ))
    .map(({ file }) => file)
    .sort();
}

export function findUnignoredPrivateProbes(workspaceRoot, { spawn = spawnSync } = {}) {
  return privateIgnoreProbes.filter((file) => {
    const result = spawn(
      "git",
      ["check-ignore", "--quiet", "--no-index", "--", file],
      { cwd: workspaceRoot, encoding: "utf8", windowsHide: true },
    );
    return result.status !== 0;
  });
}

export async function runReleaseVerification(workspaceRoot = root) {
  const failures = [];
  const warnings = [];
  for (const file of requiredFiles) {
    try { await access(resolve(workspaceRoot, file)); }
    catch { failures.push(`缺少发布文件：${file}`); }
  }
  for (const file of obsoleteFiles) {
    try {
      await access(resolve(workspaceRoot, file));
      failures.push(`仍存在废弃入口：${file}`);
    } catch {
      // Absence is the release contract for superseded Cookie/clipboard/task entry points.
    }
  }
  try {
    await validatePublicTree(resolve(workspaceRoot, "site"));
    assertPublicTextSafe(await readFile(resolve(workspaceRoot, "README.md"), "utf8"), "README.md");
  } catch (error) {
    failures.push(`公开文件安全检查失败：${error.message}`);
  }

  const gitignore = await readFile(resolve(workspaceRoot, ".gitignore"), "utf8");
  for (const entry of [".xhs-favorites/", ".xhs-tools/", "knowledge-base/", "config/xhs-favorites.json", "site/.local/"]) {
    if (!gitignore.split(/\r?\n/).includes(entry)) failures.push(`.gitignore 缺少：${entry}`);
  }
  for (const file of findUnignoredPrivateProbes(workspaceRoot)) {
    failures.push(`Git 未正确忽略私有路径：${file}`);
  }
  try {
    for (const file of findTrackedPrivatePaths(workspaceRoot)) failures.push(`Git 跟踪路径违反私有发布边界：${file}`);
  } catch (error) {
    failures.push(`无法检查 Git 跟踪边界：${error.message}`);
  }

  try {
    const exampleConfig = JSON.parse(await readFile(resolve(workspaceRoot, "config/xhs-favorites.example.json"), "utf8"));
    if (exampleConfig.version !== 1 || !Array.isArray(exampleConfig.boards)) {
      failures.push("config/xhs-favorites.example.json has an unsupported structure");
    }
    if (Object.keys(exampleConfig.publish || {}).some((key) => /token|password|secret/i.test(key))) {
      failures.push("config/xhs-favorites.example.json must not contain publish credentials");
    }
  } catch (error) {
    failures.push(`config/xhs-favorites.example.json is not valid JSON: ${error.message}`);
  }

  const siteConfig = await readFile(resolve(workspaceRoot, "site/site-config.js"), "utf8");
  if (/repositoryUrl:\s*""/.test(siteConfig)) failures.push("site/site-config.js 缺少 repositoryUrl");
  if (/creatorGitHubUrl:\s*""/.test(siteConfig)) failures.push("site/site-config.js 缺少 creatorGitHubUrl，作者空间入口无法启用");
  if (!/rowland-dot\/favsense/.test(siteConfig)) failures.push("site/site-config.js 未指向 FavSense GitHub 仓库");
  for (const file of ["README.md", "site/index.html", "site/app.js", "site/site-config.js", "package.json"]) {
    const content = await readFile(resolve(workspaceRoot, file), "utf8");
    if (/shiguangtai|SHIGUANG_CONFIG/i.test(content)) failures.push(`${file} 仍包含旧品牌标识`);
  }
  for (const file of ["CHANGELOG.md", ".github/ISSUE_TEMPLATE/config.yml"]) {
    const content = await readFile(resolve(workspaceRoot, file), "utf8");
    if (/YOUR_(?:USERNAME|REPOSITORY)/.test(content)) failures.push(`${file} 仍包含 GitHub 占位符`);
  }

  if (failures.length) {
    console.error("发布检查失败：");
    for (const item of failures) console.error(`- ${item}`);
  } else {
    console.log("发布检查通过：必需文件、隐私边界、Git 忽略与跟踪边界均有效。");
  }
  for (const item of warnings) console.warn(`提示：${item}`);
  return failures;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const failures = await runReleaseVerification();
  if (failures.length) process.exitCode = 1;
}
