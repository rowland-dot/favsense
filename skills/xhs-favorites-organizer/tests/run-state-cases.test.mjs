import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import {
  normalizeLocalBridgeDiagnostic,
  syncCountsDetail,
  syncStatusCopy,
  validateLocalBridgeSyncStatus
} from "../../../site/local-bridge-utils.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const contract = JSON.parse(await read("site/organization-status-contract.json"));
const table = JSON.parse(await read("site/organization-status-cases.json"));
const app = await read("site/app.js");

// The status the bridge would answer for a case: the expected phases, counts and sentence key.
function statusFor(expectation) {
  const phase = ([status, reason]) => ({
    status,
    reason_code: reason,
    updated_at: "2026-10-12T00:00:00Z",
    ...(["build_failed", "publish_failed"].includes(reason) ? { artifact_status: "held_previous" } : {})
  });
  return {
    ok: true,
    schema_version: 2,
    run_id: "fixture-run",
    state: expectation.state,
    build_version: expectation.build_version,
    phases: Object.fromEntries(Object.entries(expectation.phases).map(([name, value]) => [name, phase(value)])),
    counts: { ...expectation.counts },
    copy_key: expectation.copy_key
  };
}

function sourceBetween(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source between ${start} and ${end}`);
  return app.slice(from, to).trim();
}

test("every case in the shared table is accepted and names the contract sentence it expects", () => {
  assert.ok(table.cases.length >= 12);
  for (const entry of table.cases) {
    const status = validateLocalBridgeSyncStatus(statusFor(entry.expect), contract);
    assert.equal(syncStatusCopy(status, contract), contract.copy[entry.expect.copy_key], entry.name);
  }
});

test("a status without a sentence key, or with a key the contract does not have, is refused", () => {
  const base = statusFor(table.cases[0].expect);
  const { copy_key: _dropped, ...withoutKey } = base;
  assert.throws(() => validateLocalBridgeSyncStatus(withoutKey, contract));
  assert.throws(() => validateLocalBridgeSyncStatus({ ...base, copy_key: "no_such_sentence" }, contract));
  assert.throws(() => validateLocalBridgeSyncStatus({ ...base, copy_key: 7 }, contract));
  assert.throws(() => validateLocalBridgeSyncStatus({ ...base, copy_key: "toString" }, contract));
});

test("the workbench title is the contract sentence the server chose, for every case", () => {
  const readySource = sourceBetween("function sopBrowserReady()", "\nfunction bookmarkIcon");
  // From the shared "is a round running" check, which the render function calls.
  const renderSource = sourceBetween("function manualSyncRunning(", "function reportStartRefusal");
  for (const entry of table.cases) {
    const textNode = () => ({ textContent: "", disabled: false });
    const elements = {
      manualSyncControl: { classList: { toggle() {} } },
      manualSyncStart: textNode(),
      manualSyncClearStop: textNode(),
      manualSyncLocalRebuild: textNode(),
      manualSyncTitle: textNode(),
      manualSyncDetail: textNode(),
      dialogContent: { querySelector: () => null }
    };
    const state = {
      localBridge: { browserSession: { owner: "sop-cdp", ready: true } },
      manualSync: { state: "idle" },
      boards: [],
      statusContract: contract
    };
    const status = validateLocalBridgeSyncStatus(statusFor(entry.expect), contract);
    runInNewContext(`${readySource}\n${renderSource}\nrenderManualSync(status);`, {
      state, elements, status, normalizeLocalBridgeDiagnostic, syncCountsDetail, countText: (value) => (value === null ? "未知" : String(value))
    });
    assert.equal(elements.manualSyncTitle.textContent, contract.copy[entry.expect.copy_key], entry.name);
  }
});

test("the page no longer picks a title or a bubble from the phase states", () => {
  const renderSource = sourceBetween("function renderManualSync(status = state.manualSync)", "function reportStartRefusal");
  assert.equal(/manualSyncTitle\.textContent = copy\.\w+/.test(renderSource), false);
  const refreshSource = sourceBetween("async function refreshManualSyncStatus()", "\nfunction watchManualSync");
  for (const retired of ["构建失败，已保留上一版", "发布失败，远端仍为上一版", "部分整理未完成", "phases.build.status", "phases.publish.status"]) {
    assert.equal(refreshSource.includes(retired), false, retired);
  }
});

test("the end-of-run bubble is the contract sentence the server chose", async () => {
  const refreshSource = sourceBetween("async function refreshManualSyncStatus()", "\nfunction watchManualSync");
  const runningCheck = sourceBetween("function manualSyncRunning(", "\nfunction renderManualSync");
  for (const entry of table.cases) {
    const terminal = validateLocalBridgeSyncStatus(statusFor(entry.expect), contract);
    const running = Object.values(terminal.phases).some((phase) => phase.status === "running");
    const corePreserved = ["completed", "not_required"].includes(terminal.phases.core.status);
    const events = JSON.parse(await runInNewContext(`
      const events = [];
      const state = { manualSync: { state: "starting" }, manualSyncStartedHere: true, manualSyncPoll: 42, statusContract: contract };
      const location = { reload() { events.push(["reload"]); } };
      const window = {
        clearInterval() {},
        setTimeout(callback) { callback(); }
      };
      async function localBridgeRequest() { return terminal; }
      function validateLocalBridgeSyncStatus(value) { return value; }
      function renderManualSync() {}
      function showToast(message) { events.push(["toast", message]); }
      ${runningCheck}
      ${refreshSource}
      (async () => { await refreshManualSyncStatus(); return JSON.stringify(events); })();
    `, { terminal, contract }));
    const toasts = events.filter(([kind]) => kind === "toast").map(([, message]) => message);
    if (running || !corePreserved) {
      assert.deepEqual(toasts, [], entry.name);
    } else {
      assert.deepEqual(toasts, [contract.copy[entry.expect.copy_key]], entry.name);
    }
  }
});
