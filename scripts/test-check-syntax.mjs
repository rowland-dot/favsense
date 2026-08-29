import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkTrackedSyntax } from "./check-syntax.mjs";

test("checks every tracked JavaScript module and ignores private or untracked files", async () => {
  const root = await mkdtemp(join(tmpdir(), "favsense-syntax-"));
  for (const relative of ["site/a.js", "scripts/b.mjs", ".xhs-favorites/private.js", "untracked.js"]) {
    await mkdir(dirname(join(root, relative)), { recursive: true });
    await writeFile(join(root, relative), "export const ok = true;\n");
  }
  const calls = [];
  const result = await checkTrackedSyntax(root, {
    listTracked: () => ["site/a.js", "scripts/b.mjs", "README.md"],
    check(file) { calls.push(file); return { status: 0, stderr: "" }; },
  });
  assert.deepEqual(calls, ["scripts/b.mjs", "site/a.js"]);
  assert.deepEqual(result, { checked: 2, failures: [] });
});

test("returns the exact failing path and exit code", async () => {
  const result = await checkTrackedSyntax("unused", {
    listTracked: () => ["site/good.js", "site/bad.mjs"],
    check(file) {
      return file.endsWith("bad.mjs")
        ? { status: 7, stderr: "SyntaxError: fixture" }
        : { status: 0, stderr: "" };
    },
  });
  assert.deepEqual(result.failures, [{ path: "site/bad.mjs", exitCode: 7, message: "SyntaxError: fixture" }]);
});

