import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import {
  normalizeLocalBridgeDiagnostic,
  validateLocalBridgeSyncStatus
} from "../../../site/local-bridge-utils.mjs";

// The workbench shows an out-of-date installed user script on load, the way it shows a leftover safety
// stop: one sentence from the status contract, no counts, and a start button that cannot be pressed.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const contract = JSON.parse(await read("site/organization-status-contract.json"));
const app = await read("site/app.js");
const SENTENCE = contract.copy.userscript_outdated;

function sourceBetween(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source between ${start} and ${end}`);
  return app.slice(from, to).trim();
}

function render(status) {
  const node = () => ({ textContent: "", disabled: false, hidden: false });
  const elements = {
    manualSyncControl: { classList: { toggle() {} } },
    manualSyncStart: node(), manualSyncClearStop: node(), manualSyncLocalRebuild: node(),
    manualSyncTitle: node(), manualSyncDetail: node(), dialogContent: { querySelector: () => null }
  };
  const state = {
    localBridge: { browserSession: { owner: "sop-cdp", ready: true } },
    manualSync: { state: "idle" }, boards: [], statusContract: contract
  };
  const source = [
    sourceBetween("function sopBrowserReady()", "\nfunction bookmarkIcon"),
    sourceBetween("function manualSyncRunning(", "function reportStartRefusal")
  ].join("\n");
  runInNewContext(`${source}\nrenderManualSync(status);`, {
    state, elements, status, normalizeLocalBridgeDiagnostic,
    countText: (value) => (value === null ? "未知" : String(value))
  });
  return elements;
}

const phase = (status, reason_code = "") => ({ status, reason_code, updated_at: "2026-10-12T00:00:00Z" });

test("the contract has a reinstall sentence and a reason code for it", () => {
  assert.match(SENTENCE, /用户脚本/);
  assert.match(SENTENCE, /重新安装/);
  assert.doesNotMatch(SENTENCE, /核心整理结果已保留/);
  assert.ok(contract.reason_codes.includes("userscript_outdated"));
});

test("an idle status reply that flags an outdated user script is accepted and kept", () => {
  const status = validateLocalBridgeSyncStatus({ ok: true, state: "idle", userscript_outdated: true }, contract);
  assert.equal(status.userscript_outdated, true);
  assert.throws(() => validateLocalBridgeSyncStatus({ ok: true, state: "idle", userscript_outdated: "yes" }, contract));
});

test("a finished round's status keeps the flag next to its own sentence", () => {
  const status = validateLocalBridgeSyncStatus({
    ok: true, schema_version: 2, run_id: "fixture-run", state: "published", build_version: "",
    copy_key: "publish_unchanged", userscript_outdated: true,
    phases: {
      core: phase("completed"), summary: phase("completed"), evidence: phase("ready"),
      curation: phase("validated"), build: phase("succeeded"), publish: phase("unchanged")
    },
    counts: { scanned: 2, new: 0, summary_captured: 0, summary_failed: 0, summary_batch_aborted: 0, curation_accepted: 0, curation_pending: 0 }
  }, contract);
  assert.equal(status.userscript_outdated, true);
});

test("the workbench shows the reinstall sentence with no counts and cannot start a round", () => {
  const elements = render({ state: "idle", userscript_outdated: true });
  assert.equal(elements.manualSyncTitle.textContent, SENTENCE);
  assert.equal(elements.manualSyncStart.disabled, true);
  assert.doesNotMatch(elements.manualSyncDetail.textContent, /\d+ 条|核心整理结果已保留/);
  assert.equal(elements.manualSyncLocalRebuild.disabled, false, "a local rebuild does not need the user script");
});

test("an up-to-date install leaves the start button alone", () => {
  const elements = render({ state: "idle" });
  assert.equal(elements.manualSyncStart.disabled, false);
  assert.notEqual(elements.manualSyncTitle.textContent, SENTENCE);
});

test("a refused start is shown as the reinstall sentence, not as a failed round", () => {
  const source = sourceBetween("function reportStartRefusal(", "async function refreshManualSyncStatus");
  const shown = [];
  const toasts = [];
  const handled = runInNewContext(`${source}\nreportStartRefusal(error);`, {
    error: Object.assign(new Error("x"), { payload: { ok: false, state: "userscript-outdated", userscript_outdated: true } }),
    renderManualSync: (status) => shown.push(status),
    showToast: (message) => toasts.push(message),
    validateLegacySafetyStop: () => { throw new Error("not a leftover stop"); }
  });
  assert.equal(handled, true);
  assert.equal(JSON.stringify(shown), JSON.stringify([{ state: "idle", userscript_outdated: true }]));
  assert.equal(toasts.length, 1);
});
