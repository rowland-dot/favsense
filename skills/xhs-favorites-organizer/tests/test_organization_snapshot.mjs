import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "favsense-snapshot-"));
  const kbTarget = join(root, "knowledge-base");
  const publicTarget = join(root, "knowledge.json");
  await mkdir(kbTarget);
  await writeFile(join(kbTarget, "build.json"), JSON.stringify({ build_version: "old" }));
  await writeFile(publicTarget, JSON.stringify({ meta: { buildVersion: "old" } }));
  return { root, kbTarget, publicTarget };
}

const builder = (kind, calls, fail = false) => async ({ target, buildVersion }) => {
  calls.push(kind);
  if (fail) throw new Error(`${kind}_failed`);
  if (kind === "kb") {
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "build.json"), JSON.stringify({ build_version: buildVersion }));
  } else {
    await writeFile(target, JSON.stringify({ meta: { buildVersion } }));
  }
};

test("second builder failure preserves both previous live outputs", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture(); const calls = [];
  await assert.rejects(buildOrganizationSnapshot({ ...paths, sealedScopeDigest: "a".repeat(64), curationInputDigest: "b".repeat(64), configDigest: "c".repeat(64), inputRevisionDigest: "d".repeat(64), effectiveDate: "2026-08-25", buildKnowledgeBase: builder("kb", calls), buildPublicSite: builder("public", calls, true) }), /public_failed/);
  assert.deepEqual(calls, ["kb", "public"]);
  assert.equal(JSON.parse(await readFile(join(paths.kbTarget, "build.json"), "utf8")).build_version, "old");
  assert.equal(JSON.parse(await readFile(paths.publicTarget, "utf8")).meta.buildVersion, "old");
});

test("failure after the first swap rolls both participants back", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture(); const calls = [];
  await assert.rejects(buildOrganizationSnapshot({ ...paths, sealedScopeDigest: "a".repeat(64), curationInputDigest: "b".repeat(64), configDigest: "c".repeat(64), inputRevisionDigest: "d".repeat(64), effectiveDate: "2026-08-25", buildKnowledgeBase: builder("kb", calls), buildPublicSite: builder("public", calls), failAt: "swap:public" }), /FAULT_INJECTION/);
  assert.equal(JSON.parse(await readFile(join(paths.kbTarget, "build.json"), "utf8")).build_version, "old");
  assert.equal(JSON.parse(await readFile(paths.publicTarget, "utf8")).meta.buildVersion, "old");
});

test("one canonical version is embedded in both outputs", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture(); const calls = [];
  const staleInput = join(paths.root, ".xhs-tools", "organization-snapshots", "snapshot-input-stale");
  await mkdir(staleInput, { recursive: true });
  await writeFile(join(staleInput, "private.json"), "{}");
  const result = await buildOrganizationSnapshot({ ...paths, sealedScopeDigest: "a".repeat(64), curationInputDigest: "b".repeat(64), configDigest: "c".repeat(64), inputRevisionDigest: "d".repeat(64), effectiveDate: "2026-08-25", buildKnowledgeBase: builder("kb", calls), buildPublicSite: builder("public", calls) });
  assert.match(result.build_version, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(await readFile(join(paths.kbTarget, "build.json"), "utf8")).build_version, result.build_version);
  assert.equal(JSON.parse(await readFile(paths.publicTarget, "utf8")).meta.buildVersion, result.build_version);
  assert.equal((await readdir(join(paths.root, ".xhs-tools", "organization-snapshots"))).includes("snapshot-input-stale"), false);
});

test("successful build freezes a publish site under its canonical version", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-publish-snapshot-"));
  const kbTarget = join(root, "knowledge-base");
  const publishSite = join(root, "site");
  const publicTarget = join(publishSite, "data", "knowledge.json");
  await mkdir(kbTarget);
  await mkdir(join(publishSite, "data"), { recursive: true });
  await writeFile(join(kbTarget, "build.json"), JSON.stringify({ build_version: "old" }));
  await writeFile(join(publishSite, "index.html"), "site-A", "utf8");
  await writeFile(publicTarget, JSON.stringify({ meta: { buildVersion: "old" } }));
  const result = await buildOrganizationSnapshot({
    root,
    kbTarget,
    publicTarget,
    publishSite,
    sealedScopeDigest: "a".repeat(64),
    curationInputDigest: "b".repeat(64),
    configDigest: "c".repeat(64),
    inputRevisionDigest: "d".repeat(64),
    effectiveDate: "2026-08-25",
    buildKnowledgeBase: builder("kb", []),
    buildPublicSite: builder("public", []),
  });
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

test("publish freeze failure leaves both live outputs unchanged and writes nothing outside", async (context) => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-publish-freeze-failure-"));
  const outside = await mkdtemp(join(tmpdir(), "favsense-publish-freeze-outside-"));
  const kbTarget = join(root, "knowledge-base");
  const publishSite = join(root, "site");
  const publicTarget = join(publishSite, "data", "knowledge.json");
  await mkdir(kbTarget);
  await mkdir(join(publishSite, "data"), { recursive: true });
  await writeFile(join(kbTarget, "build.json"), JSON.stringify({ build_version: "old" }));
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
    await assert.rejects(buildOrganizationSnapshot({
      root,
      kbTarget,
      publicTarget,
      publishSite,
      sealedScopeDigest: "a".repeat(64),
      curationInputDigest: "b".repeat(64),
      configDigest: "c".repeat(64),
      inputRevisionDigest: "d".repeat(64),
      effectiveDate: "2026-08-25",
      buildKnowledgeBase: builder("kb", []),
      buildPublicSite: builder("public", []),
    }), /SNAPSHOT_PUBLISH_SITE_INVALID/);
    assert.equal(JSON.parse(await readFile(join(kbTarget, "build.json"), "utf8")).build_version, "old");
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

test("same build version rejects changed or tampered frozen site bytes", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-publish-manifest-"));
  const kbTarget = join(root, "knowledge-base");
  const publishSite = join(root, "site");
  const publicTarget = join(publishSite, "data", "knowledge.json");
  await mkdir(kbTarget);
  await mkdir(join(publishSite, "data"), { recursive: true });
  await writeFile(join(kbTarget, "build.json"), JSON.stringify({ build_version: "old" }));
  await writeFile(join(publishSite, "index.html"), "site-A", "utf8");
  await writeFile(publicTarget, JSON.stringify({ meta: { buildVersion: "old" } }));
  const options = {
    root,
    kbTarget,
    publicTarget,
    publishSite,
    sealedScopeDigest: "a".repeat(64),
    curationInputDigest: "b".repeat(64),
    configDigest: "c".repeat(64),
    inputRevisionDigest: "d".repeat(64),
    effectiveDate: "2026-08-25",
    buildKnowledgeBase: builder("kb", []),
    buildPublicSite: builder("public", []),
  };
  const first = await buildOrganizationSnapshot(options);
  const frozenSite = join(root, ".xhs-tools", "organization-snapshots", "publish", first.build_version, "site");

  await writeFile(join(publishSite, "index.html"), "site-B", "utf8");
  await assert.rejects(buildOrganizationSnapshot(options), /SNAPSHOT_PUBLISH_MANIFEST_MISMATCH/);
  assert.equal(await readFile(join(frozenSite, "index.html"), "utf8"), "site-A");

  await writeFile(join(publishSite, "index.html"), "site-A", "utf8");
  await writeFile(join(frozenSite, "index.html"), "tampered", "utf8");
  await assert.rejects(buildOrganizationSnapshot(options), /SNAPSHOT_PUBLISH_MANIFEST_MISMATCH/);
});

test("same build version recovers an interrupted deterministic transaction before rebuilding", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture();
  const options = {
    ...paths,
    sealedScopeDigest: "a".repeat(64),
    curationInputDigest: "b".repeat(64),
    configDigest: "c".repeat(64),
    inputRevisionDigest: "d".repeat(64),
    effectiveDate: "2026-08-25",
  };
  await assert.rejects(
    buildOrganizationSnapshot({
      ...options,
      buildKnowledgeBase: builder("kb", []),
      buildPublicSite: builder("public", []),
      failAt: "crash-after-swap:knowledge-base",
    }),
    /SIMULATED_CRASH/,
  );
  const recovered = await buildOrganizationSnapshot({
    ...options,
    buildKnowledgeBase: builder("kb", []),
    buildPublicSite: builder("public", []),
  });
  assert.equal(JSON.parse(await readFile(join(paths.kbTarget, "build.json"), "utf8")).build_version, recovered.build_version);
  assert.equal(JSON.parse(await readFile(paths.publicTarget, "utf8")).meta.buildVersion, recovered.build_version);
  assert.equal((await readdir(paths.root)).some((name) => name.startsWith(".organization-tx-snapshot-")), false);
});

test("a changed build version recovers the previous interrupted target transaction first", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture();
  const common = {
    ...paths,
    sealedScopeDigest: "a".repeat(64),
    curationInputDigest: "b".repeat(64),
    configDigest: "c".repeat(64),
    effectiveDate: "2026-08-25",
  };
  await assert.rejects(buildOrganizationSnapshot({
    ...common,
    inputRevisionDigest: "d".repeat(64),
    buildKnowledgeBase: builder("kb", []),
    buildPublicSite: builder("public", []),
    failAt: "crash-after-swap:knowledge-base",
  }), /SIMULATED_CRASH/);
  const recovered = await buildOrganizationSnapshot({
    ...common,
    inputRevisionDigest: "e".repeat(64),
    buildKnowledgeBase: builder("kb", []),
    buildPublicSite: builder("public", []),
  });
  assert.equal(JSON.parse(await readFile(join(paths.kbTarget, "build.json"), "utf8")).build_version, recovered.build_version);
  assert.equal(JSON.parse(await readFile(paths.publicTarget, "utf8")).meta.buildVersion, recovered.build_version);
});

test("pending recovery rejects a different target pair instead of moving old backups", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-target-identity-"));
  async function targets(prefix) {
    const kbTarget = join(root, `${prefix}-knowledge-base`);
    const publicTarget = join(root, `${prefix}-knowledge.json`);
    await mkdir(kbTarget);
    await writeFile(join(kbTarget, "build.json"), JSON.stringify({ build_version: "old" }));
    await writeFile(publicTarget, JSON.stringify({ meta: { buildVersion: "old" } }));
    return { root, kbTarget, publicTarget };
  }
  const first = await targets("first");
  const second = await targets("second");
  const options = {
    sealedScopeDigest: "a".repeat(64),
    curationInputDigest: "b".repeat(64),
    configDigest: "c".repeat(64),
    inputRevisionDigest: "d".repeat(64),
    effectiveDate: "2026-08-25",
    buildKnowledgeBase: builder("kb", []),
    buildPublicSite: builder("public", []),
  };
  await assert.rejects(buildOrganizationSnapshot({
    ...first,
    ...options,
    failAt: "crash-after-swap:knowledge-base",
  }), /SIMULATED_CRASH/);
  await assert.rejects(buildOrganizationSnapshot({ ...second, ...options }), /TRANSACTION_RECOVERY_PARTICIPANTS_INVALID/);
  assert.equal(JSON.parse(await readFile(join(second.kbTarget, "build.json"), "utf8")).build_version, "old");
  assert.equal(JSON.parse(await readFile(second.publicTarget, "utf8")).meta.buildVersion, "old");
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
    sealedScopeDigest: "a".repeat(64),
    curationInputDigest: "b".repeat(64),
    configDigest: "c".repeat(64),
    inputRevisionDigest: "d".repeat(64),
    effectiveDate: "2026-08-25",
    prepareSnapshot: async () => {
      markStarted();
      await blocked;
      return {};
    },
    buildKnowledgeBase: builder("kb", []),
    buildPublicSite: builder("public", []),
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
    sealedScopeDigest: "a".repeat(64),
    curationInputDigest: "b".repeat(64),
    configDigest: "c".repeat(64),
    inputRevisionDigest: "d".repeat(64),
    effectiveDate: "2026-08-25",
    prepareSnapshot: async () => { calls.push("capture"); return {}; },
    buildKnowledgeBase: builder("kb", calls),
    buildPublicSite: builder("public", calls),
  }), /SNAPSHOT_ALREADY_RUNNING/);
  assert.deepEqual(calls, []);
});

test("complete input revision changes the canonical build version", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const firstPaths = await fixture();
  const secondPaths = await fixture();
  const common = {
    sealedScopeDigest: "a".repeat(64),
    curationInputDigest: "b".repeat(64),
    configDigest: "c".repeat(64),
    effectiveDate: "2026-08-25",
  };
  const first = await buildOrganizationSnapshot({
    ...firstPaths,
    ...common,
    inputRevisionDigest: "d".repeat(64),
    buildKnowledgeBase: builder("kb", []),
    buildPublicSite: builder("public", []),
  });
  const second = await buildOrganizationSnapshot({
    ...secondPaths,
    ...common,
    inputRevisionDigest: "e".repeat(64),
    buildKnowledgeBase: builder("kb", []),
    buildPublicSite: builder("public", []),
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

test("input mutation between builders aborts before either live output swaps", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture();
  let revision = "old";
  await assert.rejects(buildOrganizationSnapshot({
    ...paths,
    sealedScopeDigest: "a".repeat(64),
    curationInputDigest: "b".repeat(64),
    configDigest: "c".repeat(64),
    inputRevisionDigest: "d".repeat(64),
    effectiveDate: "2026-08-25",
    buildKnowledgeBase: builder("kb", []),
    buildPublicSite: async (options) => {
      await builder("public", [])(options);
      revision = "changed";
    },
    verifyInputs: async () => {
      if (revision !== "old") throw new Error("SNAPSHOT_INPUT_CHANGED");
    },
  }), /SNAPSHOT_INPUT_CHANGED/);
  assert.equal(JSON.parse(await readFile(join(paths.kbTarget, "build.json"), "utf8")).build_version, "old");
  assert.equal(JSON.parse(await readFile(paths.publicTarget, "utf8")).meta.buildVersion, "old");
});

test("snapshot rejects impossible effective dates", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture();
  await assert.rejects(buildOrganizationSnapshot({
    ...paths,
    sealedScopeDigest: "a".repeat(64),
    curationInputDigest: "b".repeat(64),
    configDigest: "c".repeat(64),
    inputRevisionDigest: "d".repeat(64),
    effectiveDate: "2026-99-99",
    buildKnowledgeBase: builder("kb", []),
    buildPublicSite: builder("public", []),
  }));
});

test("unsafe private-root links are rejected before any outside directory is created", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-storage-link-"));
  const outside = await mkdtemp(join(tmpdir(), "favsense-storage-outside-"));
  const kbTarget = join(root, "knowledge-base");
  const publicTarget = join(root, "knowledge.json");
  await mkdir(kbTarget);
  await writeFile(join(kbTarget, "build.json"), JSON.stringify({ build_version: "old" }));
  await writeFile(publicTarget, JSON.stringify({ meta: { buildVersion: "old" } }));
  await symlink(outside, join(root, ".xhs-tools"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(buildOrganizationSnapshot({
    root,
    kbTarget,
    publicTarget,
    sealedScopeDigest: "a".repeat(64),
    curationInputDigest: "b".repeat(64),
    configDigest: "c".repeat(64),
    inputRevisionDigest: "d".repeat(64),
    effectiveDate: "2026-08-25",
    buildKnowledgeBase: builder("kb", []),
    buildPublicSite: builder("public", []),
  }), /SNAPSHOT_INPUT_PATH_INVALID/);
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
      kbTarget: join(linkedRoot, "knowledge-base"),
      publicTarget: join(linkedRoot, "knowledge.json"),
      sealedScopeDigest: "a".repeat(64),
      curationInputDigest: "b".repeat(64),
      configDigest: "c".repeat(64),
      inputRevisionDigest: "d".repeat(64),
      effectiveDate: "2026-08-25",
      buildKnowledgeBase: builder("kb", []),
      buildPublicSite: builder("public", []),
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
