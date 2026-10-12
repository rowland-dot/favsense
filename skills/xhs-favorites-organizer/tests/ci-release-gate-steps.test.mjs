import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ci = fs.readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8");

// Every platform runs the one release gate (`npm run release:check`). Windows runs it under the connection
// logger so the intermittent ERR_NO_BUFFER_SPACE browser failure leaves evidence; Ubuntu runs it directly.
test("CI runs the complete release gate once per platform, directly on Ubuntu and under the connection log on Windows", () => {
  assert.match(ci, /- name: Run the complete release gate\s+if: runner\.os != 'Windows'\s+run: npm run release:check/);
  assert.match(ci, /- name: Run the complete release gate with the connection log\s+if: runner\.os == 'Windows'\s+run: node scripts\/connection-log\.mjs --out ci-diagnostics -- npm run release:check/);
});
