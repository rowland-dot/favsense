#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pythonCandidates, selectPython } from "./run-python-tests.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");

export function organizationCommands(interpreter) {
  return [
    { command: interpreter.command, args: [...interpreter.prefixArgs, "-W", "error", "-m", "unittest", "discover", "-s", "skills/xhs-favorites-organizer/tests", "-p", "test_organization_pipeline.py"] },
    { command: process.execPath, args: ["--test", "skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs"] },
  ];
}

export function runOrganizationTests(interpreter, { root: workspace = root, spawn = spawnSync } = {}) {
  for (const item of organizationCommands(interpreter)) {
    const result = spawn(item.command, item.args, { cwd: workspace, stdio: "inherit", windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } });
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const interpreter = selectPython(pythonCandidates({ root }));
    process.exitCode = runOrganizationTests(interpreter);
  } catch (error) {
    console.error(String(error.message || error));
    process.exitCode = 1;
  }
}

