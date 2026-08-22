#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");

export const pythonTestSuites = [
  "skills/xhs-favorites-organizer/tests",
  "skills/xhs-diandian-summarize-note/tests",
];

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate.command) return false;
    const key = JSON.stringify([candidate.command, candidate.prefixArgs]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function pythonCandidates({ root: workspaceRoot, platform = process.platform, env = process.env }) {
  const explicit = String(env.FAVSENSE_PYTHON || "").trim();
  const candidates = explicit
    ? [{ command: explicit, prefixArgs: [], label: "FAVSENSE_PYTHON" }]
    : [];
  if (platform === "win32") {
    candidates.push(
      { command: join(workspaceRoot, ".xhs-tools", "XHS-Downloader", ".venv", "Scripts", "python.exe"), prefixArgs: [], label: "XHS-Downloader runtime" },
      { command: join(workspaceRoot, ".venv", "Scripts", "python.exe"), prefixArgs: [], label: "workspace virtual environment" },
      { command: "py", prefixArgs: ["-3"], label: "Python launcher" },
      { command: "python", prefixArgs: [], label: "python" },
      { command: "python3", prefixArgs: [], label: "python3" },
    );
  } else {
    candidates.push(
      { command: join(workspaceRoot, ".xhs-tools", "XHS-Downloader", ".venv", "bin", "python"), prefixArgs: [], label: "XHS-Downloader runtime" },
      { command: join(workspaceRoot, ".venv", "bin", "python"), prefixArgs: [], label: "workspace virtual environment" },
      { command: "python3", prefixArgs: [], label: "python3" },
      { command: "python", prefixArgs: [], label: "python" },
    );
  }
  return uniqueCandidates(candidates);
}

export function selectPython(candidates, { spawn = spawnSync } = {}) {
  for (const candidate of candidates) {
    const probe = spawn(candidate.command, [
      ...candidate.prefixArgs,
      "-c",
      "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
    ], { encoding: "utf8", windowsHide: true });
    if (probe.status !== 0) continue;
    const match = String(probe.stdout || "").trim().match(/^(\d+)\.(\d+)$/);
    if (!match) continue;
    const major = Number.parseInt(match[1], 10);
    const minor = Number.parseInt(match[2], 10);
    if (major > 3 || (major === 3 && minor >= 11)) {
      return { ...candidate, version: `${major}.${minor}` };
    }
  }
  throw new Error("Python 3.11 or newer was not found. Set FAVSENSE_PYTHON to an exact interpreter path.");
}

export function runPythonTestSuites(interpreter, {
  cwd = root,
  spawn = spawnSync,
  env = process.env,
} = {}) {
  for (const suite of pythonTestSuites) {
    const result = spawn(interpreter.command, [
      ...interpreter.prefixArgs,
      "-W", "error", "-m", "unittest", "discover",
      "-s", suite,
      "-p", "test_*.py",
    ], {
      cwd,
      env: { ...env, PYTHONUTF8: "1" },
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error(`Python test suite failed: ${suite}`);
    }
  }
}

export function main() {
  const interpreter = selectPython(pythonCandidates({ root }));
  console.log(`Python ${interpreter.version} (${interpreter.label})`);
  runPythonTestSuites(interpreter);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
