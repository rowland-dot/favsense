import test from "node:test";
import assert from "node:assert/strict";

import {
  pythonCandidates,
  pythonTestSuites,
  runPythonTestSuites,
  selectPython,
} from "./run-python-tests.mjs";

test("an explicit Python runtime is tried before platform fallbacks", () => {
  const candidates = pythonCandidates({
    root: "C:\\fixture",
    platform: "win32",
    env: { FAVSENSE_PYTHON: "C:\\Python312\\python.exe" },
  });

  assert.deepEqual(candidates[0], {
    command: "C:\\Python312\\python.exe",
    prefixArgs: [],
    label: "FAVSENSE_PYTHON",
  });
  assert.ok(candidates.some((candidate) => candidate.command === "py"));
  assert.ok(candidates.some((candidate) => candidate.command === "python"));
});

test("Python selection rejects versions older than 3.11 and uses the next valid candidate", () => {
  const calls = [];
  const selected = selectPython([
    { command: "python-old", prefixArgs: [], label: "old" },
    { command: "python-new", prefixArgs: ["-3"], label: "new" },
  ], {
    spawn(command, args) {
      calls.push([command, args]);
      return command === "python-old"
        ? { status: 0, stdout: "3.10\n", stderr: "" }
        : { status: 0, stdout: "3.12\n", stderr: "" };
    },
  });

  assert.equal(selected.command, "python-new");
  assert.deepEqual(selected.prefixArgs, ["-3"]);
  assert.equal(calls.length, 2);
});

test("the release Python gate runs both unittest discovery suites", () => {
  assert.deepEqual(pythonTestSuites, [
    "skills/xhs-favorites-organizer/tests",
    "skills/xhs-diandian-summarize-note/tests",
  ]);
  const calls = [];
  runPythonTestSuites({ command: "python", prefixArgs: ["-3"], label: "fixture" }, {
    cwd: "C:\\fixture",
    spawn(command, args, options) {
      calls.push({ command, args, cwd: options.cwd });
      return { status: 0 };
    },
  });

  assert.deepEqual(calls, pythonTestSuites.map((suite) => ({
    command: "python",
    args: ["-3", "-W", "error", "-m", "unittest", "discover", "-s", suite, "-p", "test_*.py"],
    cwd: "C:\\fixture",
  })));
});
