#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");

function tracked(workspace) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: workspace, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("SYNTAX_TRACKED_LIST_FAILED");
  return String(result.stdout || "").split("\0").filter(Boolean);
}

function nodeCheck(workspace, file) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: workspace, encoding: "utf8", windowsHide: true });
  return { status: result.status ?? 1, stderr: String(result.stderr || "").trim() };
}

export async function checkTrackedSyntax(workspace, { listTracked = tracked, check = (file) => nodeCheck(workspace, file) } = {}) {
  const files = listTracked(workspace).map((file) => file.replaceAll("\\", "/"))
    .filter((file) => /\.(?:js|mjs)$/i.test(file)).sort();
  const failures = [];
  for (const file of files) {
    const result = check(file);
    if (result.status !== 0) failures.push({ path: file, exitCode: result.status, message: result.stderr || "syntax check failed" });
  }
  return { checked: files.length, failures };
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const result = await checkTrackedSyntax(root);
  if (result.failures.length) {
    for (const failure of result.failures) console.error(`${failure.path} exit=${failure.exitCode}: ${failure.message}`);
    process.exitCode = 1;
  } else console.log(`Syntax OK: ${result.checked} tracked JavaScript modules checked.`);
}

