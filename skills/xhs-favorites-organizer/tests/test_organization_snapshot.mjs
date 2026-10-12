import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The web data is the only formal output (issue 39), so a snapshot has exactly one participant.

const COMMON = {
  sealedScopeDigest: "a".repeat(64),
  curationInputDigest: "b".repeat(64),
  configDigest: "c".repeat(64),
  inputRevisionDigest: "d".repeat(64),
  effectiveDate: "2026-08-25",
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "favsense-snapshot-"));
  const publicTarget = join(root, "knowledge.json");
  await writeFile(publicTarget, JSON.stringify({ meta: { buildVersion: "old" } }));
  return { root, publicTarget };
}

const builder = (calls, fail = false) => async ({ target, buildVersion }) => {
  calls.push("public");
  if (fail) throw new Error("public_failed");
  await writeFile(target, JSON.stringify({ meta: { buildVersion } }));
};

const liveVersion = async (path) => JSON.parse(await readFile(path, "utf8")).meta.buildVersion;

test("a web builder failure preserves the previous live web data", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture(); const calls = [];
  await assert.rejects(buildOrganizationSnapshot({ ...paths, ...COMMON, buildPublicSite: builder(calls, true) }), /public_failed/);
  assert.deepEqual(calls, ["public"]);
  assert.equal(await liveVersion(paths.publicTarget), "old");
});

test("failure at the web data swap restores the previous web data", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture(); const calls = [];
  await assert.rejects(buildOrganizationSnapshot({ ...paths, ...COMMON, buildPublicSite: builder(calls), failAt: "swap:public" }), /FAULT_INJECTION/);
  assert.equal(await liveVersion(paths.publicTarget), "old");
});

test("one canonical version is embedded in the web data and leftover input folders are removed", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture(); const calls = [];
  const staleInput = join(paths.root, ".xhs-tools", "organization-snapshots", "snapshot-input-stale");
  await mkdir(staleInput, { recursive: true });
  await writeFile(join(staleInput, "private.json"), "{}");
  const result = await buildOrganizationSnapshot({ ...paths, ...COMMON, buildPublicSite: builder(calls) });
  assert.match(result.build_version, /^[a-f0-9]{64}$/);
  assert.equal(await liveVersion(paths.publicTarget), result.build_version);
  assert.equal((await readdir(join(paths.root, ".xhs-tools", "organization-snapshots"))).includes("snapshot-input-stale"), false);
});

test("successful build freezes a publish site under its canonical version", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-publish-snapshot-"));
  const publishSite = join(root, "site");
  const publicTarget = join(publishSite, "data", "knowledge.json");
  await mkdir(join(publishSite, "data"), { recursive: true });
  await writeFile(join(publishSite, "index.html"), "site-A", "utf8");
  await writeFile(publicTarget, JSON.stringify({ meta: { buildVersion: "old" } }));
  const result = await buildOrganizationSnapshot({ root, publicTarget, publishSite, ...COMMON, buildPublicSite: builder([]) });
  const frozenSite = join(
    root,
    ".xhs-tools",
    "organization-snapshots",
    "publish",
    result.build_version,
    "site"
  );
  const frozenManifest = JSON.parse(await readFile(join(frozenSite, "..", "manifest.json"), "utf8"));

  await writeFile(join(publishSite, "index.html"), "site-B", "utf8");
  await writeFile(
    publicTarget,
    JSON.stringify({ meta: { buildVersion: "b".repeat(64) } }),
    "utf8"
  );

  assert.equal(await readFile(join(frozenSite, "index.html"), "utf8"), "site-A");
  assert.equal(result.site_manifest_sha256, frozenManifest.tree_sha256);
  assert.equal(
    JSON.parse(await readFile(join(frozenSite, "data", "knowledge.json"), "utf8"))
      .meta.buildVersion,
    result.build_version
  );
});

test("publish freeze failure leaves the live web data unchanged and writes nothing outside", async (context) => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-publish-freeze-failure-"));
  const outside = await mkdtemp(join(tmpdir(), "favsense-publish-freeze-outside-"));
  const publishSite = join(root, "site");
  const publicTarget = join(publishSite, "data", "knowledge.json");
  await mkdir(join(publishSite, "data"), { recursive: true });
  await writeFile(join(publishSite, "index.html"), "old-site", "utf8");
  await writeFile(publicTarget, JSON.stringify({ meta: { buildVersion: "old" }, marker: "old" }));
  try {
    try {
      await symlink(outside, join(publishSite, "unsafe"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
        context.skip(`directory link unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(buildOrganizationSnapshot({ root, publicTarget, publishSite, ...COMMON, buildPublicSite: builder([]) }), /SNAPSHOT_PUBLISH_SITE_INVALID/);
    assert.deepEqual(JSON.parse(await readFile(publicTarget, "utf8")), {
      meta: { buildVersion: "old" },
      marker: "old",
    });
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// A changed source site now gets its own version (site-code-in-build-version.test.mjs); what stays
// rejected here is a frozen folder whose bytes no longer match its own manifest.
test("same build version rejects tampered frozen site bytes", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-publish-manifest-"));
  const publishSite = join(root, "site");
  const publicTarget = join(publishSite, "data", "knowledge.json");
  await mkdir(join(publishSite, "data"), { recursive: true });
  await writeFile(join(publishSite, "index.html"), "site-A", "utf8");
  await writeFile(publicTarget, JSON.stringify({ meta: { buildVersion: "old" } }));
  const options = { root, publicTarget, publishSite, ...COMMON, buildPublicSite: builder([]) };
  const first = await buildOrganizationSnapshot(options);
  const frozenSite = join(root, ".xhs-tools", "organization-snapshots", "publish", first.build_version, "site");

  assert.equal(await readFile(join(frozenSite, "index.html"), "utf8"), "site-A");

  await writeFile(join(frozenSite, "index.html"), "tampered", "utf8");
  await assert.rejects(buildOrganizationSnapshot(options), /SNAPSHOT_PUBLISH_MANIFEST_MISMATCH/);
});

test("same build version recovers an interrupted deterministic transaction before rebuilding", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture();
  const options = { ...paths, ...COMMON };
  await assert.rejects(
    buildOrganizationSnapshot({ ...options, buildPublicSite: builder([]), failAt: "crash-after-swap:public" }),
    /SIMULATED_CRASH/,
  );
  const recovered = await buildOrganizationSnapshot({ ...options, buildPublicSite: builder([]) });
  assert.equal(await liveVersion(paths.publicTarget), recovered.build_version);
  assert.equal((await readdir(join(paths.root, ".xhs-tools", "organization-snapshots"))).some((name) => name.startsWith(".organization-tx-snapshot-")), false);
});

test("a changed build version recovers the previous interrupted target transaction first", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture();
  const common = { ...paths, ...COMMON };
  await assert.rejects(buildOrganizationSnapshot({
    ...common,
    inputRevisionDigest: "d".repeat(64),
    buildPublicSite: builder([]),
    failAt: "crash-after-swap:public",
  }), /SIMULATED_CRASH/);
  const recovered = await buildOrganizationSnapshot({
    ...common,
    inputRevisionDigest: "e".repeat(64),
    buildPublicSite: builder([]),
  });
  assert.equal(await liveVersion(paths.publicTarget), recovered.build_version);
});

test("pending recovery rejects a different target instead of moving old backups", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-target-identity-"));
  async function target(prefix) {
    const publicTarget = join(root, `${prefix}-knowledge.json`);
    await writeFile(publicTarget, JSON.stringify({ meta: { buildVersion: "old" } }));
    return { root, publicTarget };
  }
  const first = await target("first");
  const second = await target("second");
  const options = { ...COMMON, buildPublicSite: builder([]) };
  await assert.rejects(buildOrganizationSnapshot({
    ...first,
    ...options,
    failAt: "crash-after-swap:public",
  }), /SIMULATED_CRASH/);
  await assert.rejects(buildOrganizationSnapshot({ ...second, ...options }), /TRANSACTION_RECOVERY_PARTICIPANTS_INVALID/);
  assert.equal(await liveVersion(second.publicTarget), "old");
  await buildOrganizationSnapshot({ ...first, ...options });
});

test("target-global lock rejects a concurrent snapshot before either transaction overlaps", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture();
  let allowFirst;
  let markStarted;
  const started = new Promise((resolveStarted) => { markStarted = resolveStarted; });
  const blocked = new Promise((resolveBlocked) => { allowFirst = resolveBlocked; });
  const options = {
    ...paths,
    ...COMMON,
    prepareSnapshot: async () => {
      markStarted();
      await blocked;
      return {};
    },
    buildPublicSite: builder([]),
  };
  const first = buildOrganizationSnapshot(options);
  await started;
  let secondCaptured = false;
  await assert.rejects(buildOrganizationSnapshot({
    ...options,
    inputRevisionDigest: "e".repeat(64),
    prepareSnapshot: async () => { secondCaptured = true; return {}; },
  }), /SNAPSHOT_ALREADY_RUNNING/);
  assert.equal(secondCaptured, false);
  allowFirst();
  await first;
});

test("snapshot capture rejects an active migration mutation lock before reading inputs", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture();
  const lock = join(paths.root, ".xhs-favorites", "organization-migration", ".apply-lock");
  await mkdir(lock, { recursive: true });
  await writeFile(join(lock, "owner.json"), JSON.stringify({
    schema_version: 1,
    pid: process.pid,
    nonce: "synthetic-active-migration",
  }));
  const calls = [];
  await assert.rejects(buildOrganizationSnapshot({
    ...paths,
    ...COMMON,
    prepareSnapshot: async () => { calls.push("capture"); return {}; },
    buildPublicSite: builder(calls),
  }), /SNAPSHOT_ALREADY_RUNNING/);
  assert.deepEqual(calls, []);
});

test("complete input revision changes the canonical build version", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const firstPaths = await fixture();
  const secondPaths = await fixture();
  const first = await buildOrganizationSnapshot({
    ...firstPaths,
    ...COMMON,
    inputRevisionDigest: "d".repeat(64),
    buildPublicSite: builder([]),
  });
  const second = await buildOrganizationSnapshot({
    ...secondPaths,
    ...COMMON,
    inputRevisionDigest: "e".repeat(64),
    buildPublicSite: builder([]),
  });
  assert.notEqual(first.build_version, second.build_version);
});

test("coordinator captures and freezes every builder input with the exact bundle scope", async () => {
  const { captureBuilderInputs, materializeCapturedInputs } = await import("../scripts/build-organization-snapshot.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-inputs-"));
  const noteId = "a".repeat(24);
  const state = join(root, ".xhs-favorites");
  const video = join(state, "video-analysis");
  const noteVideo = join(video, noteId);
  const points = join(state, "diandian-summaries");
  await mkdir(noteVideo, { recursive: true });
  await mkdir(points, { recursive: true });
  const files = {
    catalog: join(state, "catalog.json"),
    config: join(root, "config.json"),
    curation: join(root, "curation.json"),
    bundle: join(state, "bundle.json"),
    profile: join(root, "profile.json"),
    resources: join(root, "resources.json"),
    report: join(state, "diandian-rerun-report.json"),
    audit: join(state, "curation-audit.json"),
    baseline: join(state, "baseline.json"),
    point: join(points, `${noteId}.json`),
    analysis: join(noteVideo, "analysis.json"),
    image: join(noteVideo, "frame.png"),
  };
  const original = {
    catalog: JSON.stringify({ notes: { [noteId]: {} } }),
    config: JSON.stringify({ curation_quality: { publish_only_accepted: true, audit_file: ".xhs-favorites/curation-audit.json", baseline_file: ".xhs-favorites/baseline.json" } }),
    curation: "{}",
    bundle: JSON.stringify({ schema_version: 1, outcome: "ready_for_safe_build", scope: { note_ids: [noteId] }, curation: { [noteId]: { review_status: "pending" } } }),
    profile: "{}", resources: "{}", report: "{}", audit: "{}", baseline: "{}", point: "{}", analysis: "{}", image: "{}",
  };
  for (const [label, path] of Object.entries(files)) await writeFile(path, original[label]);
  const options = {
    root, catalog: files.catalog, config: files.config, curation: files.curation,
    curationBundle: files.bundle, profile: files.profile, resources: files.resources,
    diandianDir: points, diandianReport: files.report, videoAnalysis: video,
    diandianPromptVersion: "9".repeat(64),
  };
  const baseline = await captureBuilderInputs(options, "2026-08-25");
  assert.equal(baseline.sealedScopeDigest, (await import("node:crypto")).createHash("sha256").update(JSON.stringify([noteId])).digest("hex"));
  const frozen = await materializeCapturedInputs(root, baseline, {});
  assert.equal(frozen.promptVersion, "9".repeat(64));
  await writeFile(files.catalog, JSON.stringify({ changed: "after-capture" }));
  assert.equal(await readFile(frozen.catalog, "utf8"), original.catalog);
  await writeFile(files.catalog, original.catalog);
  await rm(frozen.root, { recursive: true, force: true });
  for (const [label, path] of Object.entries(files).filter(([label]) => !["bundle"].includes(label))) {
    const mutatedPath = label === "image" ? join(noteVideo, "second-frame.webp") : path;
    await writeFile(mutatedPath, JSON.stringify({ changed: label }));
    const current = await captureBuilderInputs(options, "2026-08-25");
    assert.notEqual(current.inputRevisionDigest, baseline.inputRevisionDigest, label);
    if (label === "image") await rm(mutatedPath);
    else await writeFile(path, original[label]);
  }
  const nextDay = await captureBuilderInputs(options, "2026-08-26");
  assert.notEqual(nextDay.inputRevisionDigest, baseline.inputRevisionDigest);
  const changedPrompt = await captureBuilderInputs({
    ...options,
    diandianPromptVersion: "8".repeat(64),
  }, "2026-08-25");
  assert.notEqual(changedPrompt.inputRevisionDigest, baseline.inputRevisionDigest);

  await writeFile(files.config, JSON.stringify({ curation_quality: { publish_only_accepted: true } }));
  const defaultAudit = await captureBuilderInputs(options, "2026-08-25");
  await writeFile(files.audit, JSON.stringify({ changed: "default-audit" }));
  const changedDefaultAudit = await captureBuilderInputs(options, "2026-08-25");
  assert.notEqual(changedDefaultAudit.inputRevisionDigest, defaultAudit.inputRevisionDigest);
  await writeFile(files.audit, original.audit);

  await rm(video, { recursive: true, force: true });
  const missingVideoRoot = await captureBuilderInputs(options, "2026-08-25");
  await mkdir(video);
  const emptyVideoRoot = await captureBuilderInputs(options, "2026-08-25");
  assert.notEqual(emptyVideoRoot.inputRevisionDigest, missingVideoRoot.inputRevisionDigest);
});

test("input mutation after the web build aborts before the live web data swaps", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture();
  let revision = "old";
  await assert.rejects(buildOrganizationSnapshot({
    ...paths,
    ...COMMON,
    buildPublicSite: async (options) => {
      await builder([])(options);
      revision = "changed";
    },
    verifyInputs: async () => {
      if (revision !== "old") throw new Error("SNAPSHOT_INPUT_CHANGED");
    },
  }), /SNAPSHOT_INPUT_CHANGED/);
  assert.equal(await liveVersion(paths.publicTarget), "old");
});

test("snapshot rejects impossible effective dates", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture();
  await assert.rejects(buildOrganizationSnapshot({
    ...paths,
    ...COMMON,
    effectiveDate: "2026-99-99",
    buildPublicSite: builder([]),
  }));
});

test("unsafe private-root links are rejected before any outside directory is created", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-storage-link-"));
  const outside = await mkdtemp(join(tmpdir(), "favsense-storage-outside-"));
  const publicTarget = join(root, "knowledge.json");
  await writeFile(publicTarget, JSON.stringify({ meta: { buildVersion: "old" } }));
  await symlink(outside, join(root, ".xhs-tools"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(buildOrganizationSnapshot({ root, publicTarget, ...COMMON, buildPublicSite: builder([]) }), /SNAPSHOT_INPUT_PATH_INVALID/);
  assert.deepEqual(await readdir(outside), []);
});

test("snapshot rejects a junction root before creating private storage outside it", async (context) => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const parent = await mkdtemp(join(tmpdir(), "favsense-snapshot-root-link-"));
  const outside = join(parent, "outside");
  const linkedRoot = join(parent, "linked-root");
  await mkdir(outside);
  try {
    try {
      await symlink(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
        context.skip(`directory link unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(buildOrganizationSnapshot({
      root: linkedRoot,
      publicTarget: join(linkedRoot, "knowledge.json"),
      ...COMMON,
      buildPublicSite: builder([]),
    }), /SNAPSHOT_LOCK_INVALID/);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("effective snapshot curation removes pending scoped work and admits only explicit accepted entries", async () => {
  const { effectiveCuration } = await import("../scripts/build-organization-snapshot.mjs");
  assert.deepEqual(effectiveCuration(
    { scoped: { summary: "old" }, outside: { summary: "keep" } },
    {
      schema_version: 1,
      outcome: "ready_for_safe_build",
      scope: { note_ids: ["scoped", "accepted"] },
      curation: {
        scoped: { review_status: "pending", summary: "pending" },
        accepted: { review_status: "accepted", summary: "accepted" },
      },
    },
  ), {
    outside: { summary: "keep" },
    accepted: { review_status: "accepted", summary: "accepted" },
  });
});

test("effective snapshot curation rejects entries outside the sealed bundle scope", async () => {
  const { effectiveCuration } = await import("../scripts/build-organization-snapshot.mjs");
  assert.throws(() => effectiveCuration(
    {},
    {
      schema_version: 1,
      outcome: "ready_for_safe_build",
      scope: { note_ids: ["scoped"] },
      curation: {
        scoped: { review_status: "pending" },
        outside: { review_status: "accepted" },
      },
    },
  ), /SNAPSHOT_CURATION_BUNDLE_INVALID/);
});

test("durable finalizer compare-and-set runs one build for duplicate callbacks", async () => {
  const { compareAndSetFinalizer } = await import("../scripts/build-organization-snapshot.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-finalizer-"));
  let calls = 0;
  const action = async () => { calls += 1; return { ok: true }; };
  const first = await compareAndSetFinalizer({ statePath: join(root, "finalizer.json"), runId: "fixture-run", buildVersion: "a".repeat(64), action });
  const duplicate = await compareAndSetFinalizer({ statePath: join(root, "finalizer.json"), runId: "fixture-run", buildVersion: "a".repeat(64), action });
  assert.equal(first.outcome, "finalized");
  assert.equal(duplicate.outcome, "already_finalized");
  assert.equal(calls, 1);
});
