import test from "node:test";
import assert from "node:assert/strict";

import { organizationCommands, runOrganizationTests } from "./run-organization-tests.mjs";

test("runs the Python organization suite before Node contracts", () => {
  const calls = [];
  runOrganizationTests({ command: "python", prefixArgs: [], version: "3.12" }, {
    root: "fixture",
    spawn(command, args) { calls.push([command, args]); return { status: 0 }; },
  });
  assert.deepEqual(calls, organizationCommands({ command: "python", prefixArgs: [] }).map(({ command, args }) => [command, args]));
  assert.deepEqual(calls[1], [process.execPath, [
    "--test",
    "skills/xhs-favorites-organizer/tests/test_organization_contracts.mjs",
    "skills/xhs-favorites-organizer/tests/test_formal_outputs.mjs",
  ]]);
});

test("stops and propagates the first non-zero exit", () => {
  let calls = 0;
  const status = runOrganizationTests({ command: "python", prefixArgs: [], version: "3.12" }, {
    root: "fixture",
    spawn() { calls += 1; return { status: 9 }; },
  });
  assert.equal(status, 9);
  assert.equal(calls, 1);
});
