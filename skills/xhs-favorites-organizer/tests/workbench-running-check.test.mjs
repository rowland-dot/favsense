import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const app = await readFile(resolve(root, "site/app.js"), "utf8");

function between(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source between ${start} and ${end}`);
  return app.slice(from, to).trim();
}

const phase = (status) => ({ status, reason_code: "", updated_at: "2026-10-13T00:00:00Z" });
const staged = (overall, phases) => ({
  ok: true,
  schema_version: 2,
  state: overall,
  phases: { core: phase("completed"), summary: phase("not_required"), evidence: phase("not_started"), curation: phase("not_started"), build: phase("not_started"), publish: phase("not_enabled"), ...phases }
});

// The workbench asks one question, "is a round still running", in every place that needs it.
const running = (status) => runInNewContext(`${between("function manualSyncRunning(", "\nfunction renderManualSync")}\nmanualSyncRunning(status);`, { status });

test("a round whose core import is still running counts as running whatever its overall state is called", () => {
  assert.equal(running(staged("core_running", { core: phase("running") })), true);
  assert.equal(running(staged("core_running", { core: phase("not_started") })), false);
});

test("a round past its core import with a later phase running counts as running", () => {
  assert.equal(running(staged("core_completed", { summary: phase("running") })), true);
  assert.equal(running(staged("core_completed", { build: phase("running") })), true);
});

test("a finished round does not count as running", () => {
  assert.equal(running(staged("published", { summary: phase("completed"), evidence: phase("ready"), curation: phase("validated"), build: phase("succeeded"), publish: phase("published") })), false);
  assert.equal(running(staged("failed", { core: phase("failed") })), false);
  assert.equal(running(staged("safety_stopped", { core: phase("safety_stopped") })), false);
});

test("a reply without phases keeps the old single-level words", () => {
  assert.equal(running({ state: "starting" }), true);
  assert.equal(running({ state: "running" }), true);
  assert.equal(running({ state: "idle" }), false);
  assert.equal(running({ state: "failed", error: "x" }), false);
});

test("the page-load check, both start guards and the note button all use that one question", () => {
  const sources = [
    between("async function startManualSync()", "\nasync function clearSafetyStopAndStart"),
    between("async function startSingleNoteSync(noteId)", "\nasync function initBoardManager"),
    between("async function initBoardManager()", "\nfunction filteredNotes"),
  ];
  for (const source of sources) {
    assert.equal(/\["starting", "running"\]\.includes/.test(source), false, source.split("\n")[0]);
    assert.ok(source.includes("manualSyncRunning("), source.split("\n")[0]);
  }
  assert.equal(app.match(/\["starting", "running"\]\.includes/g).length, 1, "only the helper may list the old words");
});
