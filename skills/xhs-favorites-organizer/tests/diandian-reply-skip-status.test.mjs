import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import {
  syncCountsDetail,
  validateLocalBridgeSyncStatus
} from "../../../site/local-bridge-utils.mjs";

// A post whose DianDian reply was a refusal or came back incomplete costs only that post (issue 130).
// The workbench says how many of each, next to the scan count, so a round that carried on is not read as
// a round that found nothing wrong.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const contract = JSON.parse(await read("site/organization-status-contract.json"));
const app = await read("site/app.js");

const phase = (status, reason_code = "") => ({ status, reason_code, updated_at: "2026-10-16T00:00:00Z" });
const counts = (extra = {}) => ({
  scanned: 356, new: 4, summary_captured: 1, summary_failed: 0, summary_refused: 0, summary_incomplete: 0,
  summary_batch_aborted: 0, curation_accepted: 0, curation_pending: 0, ...extra
});
const statusWith = (countValues) => ({
  ok: true, schema_version: 2, run_id: "fixture-run", state: "organization_partial", build_version: "",
  copy_key: "summary_failed",
  phases: {
    core: phase("completed"), summary: phase("failed", "contract_invalid"), evidence: phase("missing", "evidence_missing"),
    curation: phase("pending_review", "audit_pending"), build: phase("succeeded"), publish: phase("not_enabled")
  },
  counts: countValues
});

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
    state, elements, status, syncCountsDetail, normalizeLocalBridgeDiagnostic: (value) => value,
    countText: (value) => (value === null ? "未知" : String(value))
  });
  return elements;
}

test("the status check accepts the two new counts and still rejects a counts block without them", () => {
  const accepted = validateLocalBridgeSyncStatus(statusWith(counts({ summary_failed: 3, summary_refused: 2, summary_incomplete: 1 })), contract);
  assert.equal(accepted.counts.summary_refused, 2);
  assert.equal(accepted.counts.summary_incomplete, 1);
  const { summary_refused, summary_incomplete, ...old } = counts();
  assert.throws(() => validateLocalBridgeSyncStatus(statusWith(old), contract));
  assert.throws(() => validateLocalBridgeSyncStatus(statusWith(counts({ summary_refused: -1 })), contract));
});

test("the detail line says how many posts DianDian refused and how many came back incomplete", () => {
  assert.equal(
    syncCountsDetail(counts({ summary_failed: 3, summary_refused: 2, summary_incomplete: 1 })),
    "已扫描 356 条，新增 4 条。点点拒答 2 篇，回复不完整 1 篇，下次整理会再试。"
  );
  assert.equal(
    syncCountsDetail(counts({ summary_failed: 1, summary_incomplete: 1 })),
    "已扫描 356 条，新增 4 条。回复不完整 1 篇，下次整理会再试。"
  );
  assert.equal(
    syncCountsDetail(counts({ summary_failed: 2, summary_refused: 2 })),
    "已扫描 356 条，新增 4 条。点点拒答 2 篇，下次整理会再试。"
  );
});

test("a round with neither keeps the detail line it always had, and an unknown new count stays unknown", () => {
  assert.equal(syncCountsDetail(counts()), "已扫描 356 条，新增 4 条。");
  assert.equal(syncCountsDetail(counts({ new: null })), "已扫描 356 条，新增 未知 条。");
});

test("the workbench shows that line for a staged status", () => {
  const elements = render(statusWith(counts({ summary_failed: 3, summary_refused: 2, summary_incomplete: 1 })));
  assert.equal(elements.manualSyncTitle.textContent, contract.copy.summary_failed);
  assert.match(elements.manualSyncDetail.textContent, /点点拒答 2 篇，回复不完整 1 篇/);
});
