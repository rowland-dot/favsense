import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateLegacySafetyStop,
  validateLocalBridgeSyncStatus
} from "../../../site/local-bridge-utils.mjs";

// The workbench validates every status reply before showing it. A safety stop left by an earlier
// round arrives as one extra block on that reply; this file pins what that block may contain.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const contract = JSON.parse(await readFile(resolve(root, "site/organization-status-contract.json"), "utf8"));
const LEFTOVER = { date: "2026-08-29", phase: "media_or_detail", phase_label: "媒体或详情" };

const phase = (status, reason_code = "") => ({ status, reason_code, updated_at: "2026-10-12T00:00:00Z" });
const v2Status = (extra = {}) => ({
  ok: true,
  schema_version: 2,
  run_id: "fixture-run",
  state: "published",
  build_version: "",
  copy_key: "publish_unchanged",
  phases: {
    core: phase("completed"), summary: phase("completed"), evidence: phase("ready"),
    curation: phase("validated"), build: phase("succeeded"), publish: phase("unchanged")
  },
  counts: {
    scanned: 2, new: 0, summary_captured: 0, summary_failed: 0, summary_batch_aborted: 0,
    curation_accepted: 0, curation_pending: 0
  },
  ...extra
});

test("a leftover stop on an idle status reply is accepted and kept as the bridge sent it", () => {
  const status = validateLocalBridgeSyncStatus({ ok: true, state: "idle", legacy_safety_stop: LEFTOVER });
  assert.deepEqual(status.legacy_safety_stop, LEFTOVER);
  assert.equal(status.state, "idle");
});

test("a leftover stop with an unreadable date is accepted and keeps the date empty", () => {
  const leftover = { date: null, phase: "unknown", phase_label: "未知" };
  const status = validateLocalBridgeSyncStatus({ ok: true, state: "idle", legacy_safety_stop: leftover });
  assert.deepEqual(status.legacy_safety_stop, leftover);
});

test("a leftover stop rides next to a finished round in the organization status shape", () => {
  const status = validateLocalBridgeSyncStatus(v2Status({ legacy_safety_stop: LEFTOVER }), contract);
  assert.deepEqual(status.legacy_safety_stop, LEFTOVER);
  assert.equal(status.state, "published");
  assert.equal(validateLocalBridgeSyncStatus(v2Status(), contract).legacy_safety_stop, undefined);
});

test("a malformed leftover stop is refused, never half shown", () => {
  for (const malformed of [
    { ...LEFTOVER, extra: "field" },
    { date: "2026-08-29", phase: "media_or_detail" },
    { ...LEFTOVER, phase: "<img src=x onerror=1>" },
    { ...LEFTOVER, phase_label: 7 },
    { ...LEFTOVER, phase_label: "很长".repeat(30) },
    { ...LEFTOVER, date: "yesterday" },
    { ...LEFTOVER, date: undefined },
    "2026-08-29",
    null,
    []
  ]) {
    assert.throws(() => validateLegacySafetyStop(malformed), undefined, JSON.stringify(malformed));
    assert.throws(
      () => validateLocalBridgeSyncStatus({ ok: true, state: "idle", legacy_safety_stop: malformed }),
      undefined,
      JSON.stringify(malformed)
    );
    assert.throws(
      () => validateLocalBridgeSyncStatus(v2Status({ legacy_safety_stop: malformed }), contract),
      undefined,
      JSON.stringify(malformed)
    );
  }
});

test("an unknown new-note count is accepted as unknown and never turned into zero", () => {
  const unknown = v2Status();
  unknown.counts.new = null;
  assert.equal(validateLocalBridgeSyncStatus(unknown, contract).counts.new, null);
  assert.equal(validateLocalBridgeSyncStatus({ ok: true, state: "failed", new: null }).new, null);
  const negative = v2Status();
  negative.counts.new = -1;
  assert.throws(() => validateLocalBridgeSyncStatus(negative, contract));
  const scannedUnknown = v2Status();
  scannedUnknown.counts.scanned = null;
  assert.throws(() => validateLocalBridgeSyncStatus(scannedUnknown, contract));
});
