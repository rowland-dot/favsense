import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { prepareReview } from "../scripts/prepare-curation-review.mjs";
import { loadFormalPointSummary } from "../scripts/curation-quality.mjs";

// On Windows, Node's ordinary file info turns the 64-bit NTFS file number into a JavaScript Number.
// Once the volume's sequence number is 0x20 or more the number passes 2^53 and two different files
// created next to each other can read back as the same number. The checks that decide "is this still
// the same file" then wave a swapped-in file through. These tests make every ordinary (Number) read
// report one fixed number so the failure is reproducible on any machine; reads that ask for exact
// (bigint) values are left alone, exactly like the real platform.
const ROUNDED_INO = 25895697859835476;

async function simulateRoundedFileIds() {
  const originals = [];
  const wrap = (owner, name, optionsIndex) => {
    const original = owner[name];
    owner[name] = function wrapped(...args) {
      const result = original.apply(this, args);
      const round = (stats) => {
        if (stats && !args[optionsIndex]?.bigint) stats.ino = ROUNDED_INO;
        return stats;
      };
      return result instanceof Promise ? result.then(round) : round(result);
    };
    originals.push([owner, name, original]);
  };
  wrap(fs, "lstatSync", 1);
  wrap(fs, "fstatSync", 1);
  wrap(fsPromises, "lstat", 1);
  const probe = await fsPromises.open(fileURLToPath(import.meta.url));
  const handlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  wrap(handlePrototype, "stat", 0);
  syncBuiltinESMExports();
  return () => {
    for (const [owner, name, original] of originals.reverse()) owner[name] = original;
    syncBuiltinESMExports();
  };
}

// Replaces `target` with a hard link to `outsideTarget` the first time the code under test resolves
// the real path of `target`, which is the gap between "validated" and "opened".
function swapDuringRealpathSync(target, outsideTarget) {
  const original = fs.realpathSync.native;
  let swapped = false;
  fs.realpathSync.native = (filename, ...rest) => {
    const result = original(filename, ...rest);
    if (!swapped && path.resolve(filename) === path.resolve(target)) {
      fs.renameSync(target, `${target}.parked`);
      fs.linkSync(outsideTarget, target);
      swapped = true;
    }
    return result;
  };
  return {
    didSwap: () => swapped,
    restore: () => { fs.realpathSync.native = original; },
  };
}

test("review preparation rejects a swapped evidence file when file numbers are rounded", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-exact-id-review-"));
  const evidenceRoot = path.join(root, "evidence");
  const outside = path.join(root, "outside");
  const noteId = "swap-note";
  const target = path.join(evidenceRoot, noteId, "transcription.json");
  const outsideTarget = path.join(outside, "transcription.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(target, JSON.stringify({ text: "inside evidence" }), "utf8");
  fs.writeFileSync(outsideTarget, JSON.stringify({ text: "outside evidence must not be consumed" }), "utf8");
  const restoreIds = await simulateRoundedFileIds();
  const swap = swapDuringRealpathSync(target, outsideTarget);
  try {
    assert.throws(() => prepareReview({
      catalog: { notes: { [noteId]: { note_id: noteId, type: "视频" } } },
      scope: { note_ids: [noteId] },
      candidates: { [noteId]: {} },
      resources: { resources: [] },
      evidenceRoot,
      diandianRoot: path.join(root, "diandian"),
    }), /Curation evidence path is unsafe/);
    assert.equal(swap.didSwap(), true, "the swap must actually have happened");
  } finally {
    swap.restore();
    restoreIds();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Same swap for code that uses the promise-based file API.
function swapDuringRealpath(target, outsideTarget, afterSwap = async () => {}) {
  const original = fsPromises.realpath;
  let swapped = false;
  fsPromises.realpath = async (filename, ...rest) => {
    const result = await original(filename, ...rest);
    if (!swapped && path.resolve(filename) === path.resolve(target)) {
      swapped = true;
      await fsPromises.rename(target, `${target}.parked`);
      await fsPromises.link(outsideTarget, target);
      await afterSwap();
    }
    return result;
  };
  syncBuiltinESMExports();
  return {
    didSwap: () => swapped,
    restore: () => {
      fsPromises.realpath = original;
      syncBuiltinESMExports();
    },
  };
}

// The snapshot builder also compares size and modified time, so the swapped-in file is given the same
// size and time; only the file number tells the two files apart.
function writeTwinFiles(first, second, firstText, secondText) {
  assert.equal(Buffer.byteLength(firstText), Buffer.byteLength(secondText));
  fs.writeFileSync(first, firstText, "utf8");
  fs.writeFileSync(second, secondText, "utf8");
  const when = new Date("2026-10-01T00:00:00.000Z");
  fs.utimesSync(first, when, when);
  fs.utimesSync(second, when, when);
}

test("site tree scan rejects a swapped file when file numbers are rounded", async () => {
  const { siteTreeManifest } = await import("../scripts/build-organization-snapshot.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-exact-id-site-"));
  const site = path.join(root, "site");
  const outside = path.join(root, "outside");
  const target = path.join(site, "index.html");
  const outsideTarget = path.join(outside, "index.html");
  fs.mkdirSync(site);
  fs.mkdirSync(outside);
  writeTwinFiles(target, outsideTarget, "site-inside", "site-ghost!");
  // The scan also compares the folder's own modified time before and after. Pin it and put it back
  // after the swap, so that only the file number can give the swap away.
  const pinned = new Date("2026-10-01T00:00:00.000Z");
  fs.utimesSync(site, pinned, pinned);
  const restoreIds = await simulateRoundedFileIds();
  const swap = swapDuringRealpath(target, outsideTarget, async () => {
    await fsPromises.utimes(site, pinned, pinned);
  });
  try {
    await assert.rejects(siteTreeManifest(site, "a".repeat(64)), /SNAPSHOT_PUBLISH_SITE_CHANGED/);
    assert.equal(swap.didSwap(), true, "the swap must actually have happened");
  } finally {
    swap.restore();
    restoreIds();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A minimal set of builder inputs. The catalog has a same-sized twin outside the root, so a swap of
// the catalog is only visible through the file number.
function inputCaptureFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-exact-id-inputs-"));
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  const files = {
    catalog: path.join(root, "catalog.json"),
    config: path.join(root, "config.json"),
    curation: path.join(root, "curation.json"),
    bundle: path.join(root, "bundle.json"),
    profile: path.join(root, "profile.json"),
  };
  fs.writeFileSync(files.config, "{}", "utf8");
  fs.writeFileSync(files.curation, "{}", "utf8");
  fs.writeFileSync(files.profile, "{}", "utf8");
  fs.writeFileSync(files.bundle, JSON.stringify({
    schema_version: 1,
    outcome: "ready_for_safe_build",
    scope: { note_ids: [] },
    curation: {},
  }), "utf8");
  const outsideCatalog = path.join(outside, "catalog.json");
  writeTwinFiles(files.catalog, outsideCatalog, '{"notes":{}}', '{"note5":{}}');
  const options = {
    root,
    catalog: files.catalog,
    config: files.config,
    curation: files.curation,
    curationBundle: files.bundle,
    profile: files.profile,
    diandianDir: path.join(root, "points"),
    diandianReport: path.join(root, "report.json"),
    videoAnalysis: path.join(root, "video"),
  };
  return { root, options, catalog: files.catalog, outsideCatalog };
}

test("input capture rejects a swapped input file when file numbers are rounded", async () => {
  const { captureBuilderInputs } = await import("../scripts/build-organization-snapshot.mjs");
  const { root, options, catalog, outsideCatalog } = inputCaptureFixture();
  const restoreIds = await simulateRoundedFileIds();
  const swap = swapDuringRealpath(catalog, outsideCatalog);
  try {
    await assert.rejects(captureBuilderInputs(options, "2026-10-13"), /SNAPSHOT_INPUT_CHANGED/);
    assert.equal(swap.didSwap(), true, "the swap must actually have happened");
  } finally {
    swap.restore();
    restoreIds();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The inputs are read side by side. When one read fails, the others must finish and close their
// files before the failure is reported; otherwise the caller gets its error while files are still
// open, and on Windows the folder cannot be removed (ENOTEMPTY). Reads are slowed here so the
// others are certainly still running when the swapped catalog is rejected.
test("input capture has closed every file it opened by the time it reports a swapped input", async () => {
  const { captureBuilderInputs } = await import("../scripts/build-organization-snapshot.mjs");
  const { root, options, catalog, outsideCatalog } = inputCaptureFixture();
  const originalOpen = fsPromises.open;
  const probe = await originalOpen(fileURLToPath(import.meta.url));
  const handlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalReadFile = handlePrototype.readFile;
  const stillOpen = new Set();
  fsPromises.open = async (...args) => {
    const handle = await originalOpen(...args);
    stillOpen.add(handle);
    const close = handle.close.bind(handle);
    handle.close = async () => { stillOpen.delete(handle); return close(); };
    return handle;
  };
  handlePrototype.readFile = async function slowReadFile(...args) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return originalReadFile.apply(this, args);
  };
  syncBuiltinESMExports();
  const restoreIds = await simulateRoundedFileIds();
  const swap = swapDuringRealpath(catalog, outsideCatalog);
  try {
    await assert.rejects(captureBuilderInputs(options, "2026-10-13"), /SNAPSHOT_INPUT_CHANGED/);
    assert.equal(swap.didSwap(), true, "the swap must actually have happened");
    assert.equal(stillOpen.size, 0, "files opened by the capture are still open after it reported the failure");
  } finally {
    swap.restore();
    restoreIds();
    fsPromises.open = originalOpen;
    handlePrototype.readFile = originalReadFile;
    syncBuiltinESMExports();
    // If the capture leaked, let the leaked reads finish so cleanup cannot hide the assertion above.
    for (let waited = 0; stillOpen.size > 0 && waited < 50; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mutation lock rejects a swapped migration folder when file numbers are rounded", async () => {
  const { acquireOrganizationMutationLock } = await import("../scripts/organization-mutation-lock.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-exact-id-lock-"));
  const migration = path.join(root, ".xhs-favorites", "organization-migration");
  fs.mkdirSync(migration, { recursive: true });
  const restoreIds = await simulateRoundedFileIds();
  // Replace the migration folder with a different folder at the same path right after the lock's
  // candidate folder is created, which is the gap the lock's folder-identity check is there to catch.
  const originalMkdir = fsPromises.mkdir;
  let swapped = false;
  fsPromises.mkdir = async (target, ...rest) => {
    if (!swapped && path.basename(String(target)).startsWith(".apply-lock.candidate-")) {
      swapped = true;
      await fsPromises.rename(migration, `${migration}.parked`);
      await originalMkdir(migration);
    }
    return originalMkdir(target, ...rest);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(acquireOrganizationMutationLock(root), /ORGANIZATION_MUTATION_LOCK_INVALID/);
    assert.equal(swapped, true, "the swap must actually have happened");
  } finally {
    fsPromises.mkdir = originalMkdir;
    syncBuiltinESMExports();
    restoreIds();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const PROMPT_VERSION = "7".repeat(64);

function pointSummaryRecord(noteId, summary) {
  return {
    captured_at: "2026-10-13T00:00:00.000Z",
    content_sha256: "a".repeat(64),
    note_id: noteId,
    prompt: "总结",
    prompt_version: PROMPT_VERSION,
    provider: "xiaohongshu-diandian",
    request_sha256: "b".repeat(64),
    summary,
    summary_sha256: createHash("sha256").update(summary, "utf8").digest("hex"),
    title: "标题",
    version: 2,
  };
}

test("formal point summary reading refuses a swapped file when file numbers are rounded", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-exact-id-point-"));
  const points = path.join(root, "points");
  const outside = path.join(root, "outside");
  const noteId = "swap-note";
  const target = path.join(points, `${noteId}.json`);
  const outsideTarget = path.join(outside, `${noteId}.json`);
  fs.mkdirSync(points);
  fs.mkdirSync(outside);
  fs.writeFileSync(target, JSON.stringify(pointSummaryRecord(noteId, "inside summary")), "utf8");
  fs.writeFileSync(outsideTarget, JSON.stringify(pointSummaryRecord(noteId, "outside summary")), "utf8");
  const restoreIds = await simulateRoundedFileIds();
  try {
    // Control: the record parses and is returned when nothing is swapped.
    assert.equal(loadFormalPointSummary(points, noteId, PROMPT_VERSION)?.summary, "inside summary");
    const swap = swapDuringRealpathSync(target, outsideTarget);
    try {
      assert.equal(loadFormalPointSummary(points, noteId, PROMPT_VERSION), null);
      assert.equal(swap.didSwap(), true, "the swap must actually have happened");
    } finally {
      swap.restore();
    }
  } finally {
    restoreIds();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
