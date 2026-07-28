#!/usr/bin/env node

import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const requiredFiles = [
  "README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "AGENTS.md", "CLAUDE.md",
  "CHANGELOG.md", "ROADMAP.md", "docs/ARCHITECTURE.md", "docs/PUBLISHING.md", "docs/RESOURCE_INDEX.md",
  ".github/workflows/ci.yml", ".github/PULL_REQUEST_TEMPLATE.md", ".github/REPOSITORY_METADATA.md",
  ".github/ISSUE_TEMPLATE/bug_report.yml", ".github/ISSUE_TEMPLATE/feature_request.yml",
  "config/domain-profiles/software.json", "config/domain-profiles/fitness.json", "config/domain-profiles/skincare.json",
  "config/xhs-favorites.example.json",
  "config/resource-registries/fitness.example.json", "config/resource-registries/skincare.example.json",
  "favsense.ps1", "site/index.html", "site/app.js", "site/resource-utils.mjs", "site/data/knowledge.json",
  "skills/xhs-favorites-organizer/scripts/build-public-site.mjs", "skills/xhs-favorites-organizer/scripts/evidence-stats.mjs",
  "skills/xhs-favorites-organizer/scripts/publish-huggingface.mjs"
];
const publicFiles = ["README.md", "site/index.html", "site/app.js", "site/site-config.js", "site/data/knowledge.json"];
const forbidden = [
  ["XHS temporary token", /xsec_token\s*=/i],
  ["profile URL", /xiaohongshu\.com\/user\/profile\//i],
  ["local Chrome profile", /ChromeUserData|AppData\\Local/i],
  ["embedded 64-character bearer token", /["'](?:token|api[_-]?key)["']\s*:\s*["'][a-f0-9]{64}["']/i]
];

const failures = [];
const warnings = [];
for (const file of requiredFiles) {
  try { await access(resolve(root, file)); }
  catch { failures.push(`缺少发布文件：${file}`); }
}
for (const file of publicFiles) {
  let content = "";
  try { content = await readFile(resolve(root, file), "utf8"); }
  catch { continue; }
  for (const [label, pattern] of forbidden) {
    if (pattern.test(content)) failures.push(`${file} 包含不应公开的 ${label}`);
  }
}

const gitignore = await readFile(resolve(root, ".gitignore"), "utf8");
for (const entry of [".xhs-favorites/", ".xhs-tools/", "knowledge-base/", "config/xhs-favorites.json", "site/.local/"]) {
  if (!gitignore.split(/\r?\n/).includes(entry)) failures.push(`.gitignore 缺少：${entry}`);
}
const ignored = spawnSync("git", ["check-ignore", "site/.local/bridge.json", "config/xhs-favorites.json"], { cwd: root, encoding: "utf8" });
if (ignored.status !== 0) failures.push("Git 未正确忽略本机运行时文件或私有配置");

try {
  const exampleConfig = JSON.parse(await readFile(resolve(root, "config/xhs-favorites.example.json"), "utf8"));
  if (exampleConfig.version !== 1 || !Array.isArray(exampleConfig.boards)) {
    failures.push("config/xhs-favorites.example.json has an unsupported structure");
  }
  if (Object.keys(exampleConfig.publish || {}).some((key) => /token|password|secret/i.test(key))) {
    failures.push("config/xhs-favorites.example.json must not contain publish credentials");
  }
} catch (error) {
  failures.push(`config/xhs-favorites.example.json is not valid JSON: ${error.message}`);
}

const siteConfig = await readFile(resolve(root, "site/site-config.js"), "utf8");
if (/repositoryUrl:\s*""/.test(siteConfig)) failures.push("site/site-config.js 缺少 repositoryUrl");
if (/creatorGitHubUrl:\s*""/.test(siteConfig)) failures.push("site/site-config.js 缺少 creatorGitHubUrl，作者空间入口无法启用");
if (!/rowland-dot\/favsense/.test(siteConfig)) failures.push("site/site-config.js 未指向 FavSense GitHub 仓库");
for (const file of ["README.md", "site/index.html", "site/app.js", "site/site-config.js", "package.json"]) {
  const content = await readFile(resolve(root, file), "utf8");
  if (/shiguangtai|SHIGUANG_CONFIG/i.test(content)) failures.push(`${file} 仍包含旧品牌标识`);
}
for (const file of ["CHANGELOG.md", ".github/ISSUE_TEMPLATE/config.yml"]) {
  const content = await readFile(resolve(root, file), "utf8");
  if (/YOUR_(?:USERNAME|REPOSITORY)/.test(content)) failures.push(`${file} 仍包含 GitHub 占位符`);
}

if (failures.length) {
  console.error("发布检查失败：");
  for (const item of failures) console.error(`- ${item}`);
  process.exitCode = 1;
} else {
  console.log("发布检查通过：必需文件、隐私边界和 Git 忽略规则均有效。");
}
for (const item of warnings) console.warn(`提示：${item}`);
