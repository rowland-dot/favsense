import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

// A small private workspace with every input a snapshot reads, for the capture tests below.
async function captureWorkspace({ withDamagedList = true, configuration } = {}) {
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
    damaged: join(state, "damaged-diandian-replies.json"),
    sourceCodes: join(state, "source-codes.json"),
    audit: join(state, "curation-audit.json"),
    point: join(points, `${noteId}.json`),
    analysis: join(noteVideo, "analysis.json"),
    transcript: join(noteVideo, "transcription.json"),
    pictureText: join(noteVideo, "visual-ocr.json"),
    image: join(noteVideo, "frame.png"),
  };
  const original = {
    catalog: JSON.stringify({ notes: { [noteId]: {} } }),
    config: configuration ?? JSON.stringify({ curation_quality: { audit_file: ".xhs-favorites/curation-audit.json" } }),
    curation: "{}",
    bundle: JSON.stringify({ schema_version: 1, outcome: "ready_for_safe_build", scope: { note_ids: [noteId] }, curation: { [noteId]: { review_status: "pending" } } }),
    profile: "{}", resources: "{}", damaged: JSON.stringify({ schema_version: 1, entries: [] }),
    sourceCodes: JSON.stringify({ schema_version: 1, notes: { [noteId]: { code: "FAKEcodeA1", source: "pc_collect", captured_at: "2026-10-09T08:00:00.000Z", batch: "batch-late" } } }),
    audit: "{}", point: "{}", analysis: "{}", transcript: "{\"text\":\"spoken\"}", pictureText: "{\"text\":\"on screen\"}", image: "{}",
  };
  for (const [label, path] of Object.entries(files)) {
    if (label === "damaged" && !withDamagedList) continue;
    await writeFile(path, original[label]);
  }
  const options = {
    root, catalog: files.catalog, config: files.config, curation: files.curation,
    curationBundle: files.bundle, profile: files.profile, resources: files.resources,
    diandianDir: points, videoAnalysis: video, damagedReplies: files.damaged, sourceCodes: files.sourceCodes,
  };
  return { root, noteId, state, video, noteVideo, points, files, original, options };
}

test("coordinator captures and freezes every builder input with the exact bundle scope", async () => {
  const { captureBuilderInputs, materializeCapturedInputs } = await import("../scripts/build-organization-snapshot.mjs");
  const { root, noteId, video, noteVideo, files, original, options } = await captureWorkspace();
  const baseline = await captureBuilderInputs(options, "2026-08-25");
  assert.equal(baseline.sealedScopeDigest, (await import("node:crypto")).createHash("sha256").update(JSON.stringify([noteId])).digest("hex"));
  const frozen = await materializeCapturedInputs(root, baseline, {});
  await writeFile(files.catalog, JSON.stringify({ changed: "after-capture" }));
  assert.equal(await readFile(frozen.catalog, "utf8"), original.catalog);
  await writeFile(files.catalog, original.catalog);
  await rm(frozen.root, { recursive: true, force: true });
  // Every input that reaches the build changes the version when it changes (the bundle is checked by its own digest).
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

  // A config that names no audit file reads none: the file may change without moving the version.
  await writeFile(files.config, JSON.stringify({ curation_quality: { publish_only_accepted: true } }));
  const noAudit = await captureBuilderInputs(options, "2026-08-25");
  await writeFile(files.audit, JSON.stringify({ changed: "unread-audit" }));
  assert.equal((await captureBuilderInputs(options, "2026-08-25")).inputRevisionDigest, noAudit.inputRevisionDigest);
  await writeFile(files.audit, original.audit);

  await rm(video, { recursive: true, force: true });
  const missingVideoRoot = await captureBuilderInputs(options, "2026-08-25");
  await mkdir(video);
  const emptyVideoRoot = await captureBuilderInputs(options, "2026-08-25");
  assert.notEqual(emptyVideoRoot.inputRevisionDigest, missingVideoRoot.inputRevisionDigest);
});

test("the damaged-reply list and each note's extracted text are frozen byte for byte", async () => {
  const { captureBuilderInputs, materializeCapturedInputs } = await import("../scripts/build-organization-snapshot.mjs");
  const { root, noteId, files, original, options } = await captureWorkspace();
  const damagedList = JSON.stringify({ schema_version: 1, entries: [{ note_id: noteId, summary_sha256: "e".repeat(64), signs: ["ends-on-comma-or-colon"] }] });
  await writeFile(files.damaged, damagedList);
  const frozen = await materializeCapturedInputs(root, await captureBuilderInputs(options, "2026-08-25"), {});
  try {
    assert.equal(await readFile(frozen.damaged, "utf8"), damagedList);
    assert.equal(await readFile(join(frozen.video, noteId, "transcription.json"), "utf8"), original.transcript);
    assert.equal(await readFile(join(frozen.video, noteId, "visual-ocr.json"), "utf8"), original.pictureText);
  } finally {
    await rm(frozen.root, { recursive: true, force: true });
  }
});

test("a different damaged list, or a different transcript, is a different build version", async () => {
  const { captureBuilderInputs } = await import("../scripts/build-organization-snapshot.mjs");
  const { files, original, options } = await captureWorkspace();
  const before = await captureBuilderInputs(options, "2026-08-25");
  await writeFile(files.damaged, JSON.stringify({ schema_version: 1, entries: [{ note_id: "a".repeat(24), summary_sha256: "e".repeat(64), signs: [] }] }));
  const withList = await captureBuilderInputs(options, "2026-08-25");
  assert.notEqual(withList.inputRevisionDigest, before.inputRevisionDigest);
  await writeFile(files.damaged, original.damaged);
  await writeFile(files.transcript, JSON.stringify({ text: "a different transcript" }));
  assert.notEqual((await captureBuilderInputs(options, "2026-08-25")).inputRevisionDigest, before.inputRevisionDigest);
});

test("a missing damaged list is an empty one only when there is no saved reply to mislabel", async () => {
  const { captureBuilderInputs, materializeCapturedInputs } = await import("../scripts/build-organization-snapshot.mjs");
  const noReplies = await captureWorkspace({ withDamagedList: false });
  await rm(noReplies.files.point);
  const captured = await captureBuilderInputs(noReplies.options, "2026-08-25");
  const frozen = await materializeCapturedInputs(noReplies.root, captured, {});
  try {
    assert.deepEqual(JSON.parse(await readFile(frozen.damaged, "utf8")), { schema_version: 1, entries: [] });
  } finally {
    await rm(frozen.root, { recursive: true, force: true });
  }

  // A saved reply and no list: every cut reply would be published as complete, so the build stops.
  const withReply = await captureWorkspace({ withDamagedList: false });
  await assert.rejects(captureBuilderInputs(withReply.options, "2026-08-25"), /DAMAGED_REPLY_LIST_MISSING/);
  await assert.rejects(captureBuilderInputs({ ...withReply.options, damagedReplies: undefined }, "2026-08-25"), /DAMAGED_REPLY_LIST_MISSING/);
});

test("the private source code store is frozen byte for byte and reaches the builder, which gives that card its post link", async () => {
  const { captureBuilderInputs, materializeCapturedInputs } = await import("../scripts/build-organization-snapshot.mjs");
  const profile = await readFile(join(dirname(fileURLToPath(import.meta.url)), "../../../config/domain-profiles/software.json"), "utf8");
  const { root, noteId, files, original, options } = await captureWorkspace({
    configuration: JSON.stringify({ boards: [{ id: "private-board-id", name: "Synthetic", enabled: true }], public_stats: {} }),
  });
  await writeFile(files.profile, profile);
  await writeFile(files.resources, JSON.stringify({ verified_at: "2026-10-10", resources: [] }));
  await writeFile(files.catalog, JSON.stringify({ notes: { [noteId]: { title: "有码的帖子", description: "文字", source_boards: ["Synthetic"] } } }));
  const frozen = await materializeCapturedInputs(root, await captureBuilderInputs(options, "2026-10-10"), {});
  try {
    assert.equal(await readFile(frozen.sourceCodes, "utf8"), original.sourceCodes);
    // The live file changing after the capture does not reach the frozen copy.
    await writeFile(files.sourceCodes, "{}");
    assert.equal(await readFile(frozen.sourceCodes, "utf8"), original.sourceCodes);
    const built = join(frozen.root, "knowledge.json");
    const run = spawnSync(process.execPath, [
      fileURLToPath(new URL("../scripts/build-public-site.mjs", import.meta.url)),
      "--catalog", frozen.catalog, "--config", frozen.config, "--curation", frozen.curation, "--profile", frozen.profile,
      "--resources", frozen.resources, "--candidates", frozen.candidates, "--diandian-dir", frozen.diandian,
      "--video-analysis", frozen.video, "--damaged-replies", frozen.damaged, "--source-codes", frozen.sourceCodes,
      "--effective-date", "2026-10-10", "--output", built,
    ], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const card = JSON.parse(await readFile(built, "utf8")).notes[0];
    assert.equal(card.sourceUrl, `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=FAKEcodeA1&xsec_source=pc_collect`);
    assert.equal(card.linkKind, "post");
  } finally {
    await rm(frozen.root, { recursive: true, force: true });
  }
});

test("a different source code store is a different build version, and a store that is not there freezes nothing", async () => {
  const { captureBuilderInputs, materializeCapturedInputs } = await import("../scripts/build-organization-snapshot.mjs");
  const { root, noteId, files, original, options } = await captureWorkspace();
  const before = await captureBuilderInputs(options, "2026-08-25");
  await writeFile(files.sourceCodes, JSON.stringify({ schema_version: 1, notes: { [noteId]: { code: "FAKEcodeOTHER", source: "pc_collect", captured_at: "2026-10-09T08:00:00.000Z", batch: "batch-late" } } }));
  assert.notEqual((await captureBuilderInputs(options, "2026-08-25")).inputRevisionDigest, before.inputRevisionDigest);
  await rm(files.sourceCodes);
  const missing = await captureBuilderInputs(options, "2026-08-25");
  const frozen = await materializeCapturedInputs(root, missing, {});
  try {
    assert.equal(frozen.sourceCodes, undefined);
  } finally {
    await rm(frozen.root, { recursive: true, force: true });
  }
  // A build that names no store at all gives the same answer as one whose store file is absent.
  const unnamed = await captureBuilderInputs({ ...options, sourceCodes: undefined }, "2026-08-25");
  assert.equal(JSON.stringify(unnamed.inputs.filter((entry) => entry.name !== "source-codes")), JSON.stringify(missing.inputs.filter((entry) => entry.name !== "source-codes")));
  await writeFile(files.sourceCodes, original.sourceCodes);
});

test("the command line no longer takes the run report or the prompt version", async () => {
  const script = fileURLToPath(new URL("../scripts/build-organization-snapshot.mjs", import.meta.url));
  const required = {
    "--root": tmpdir(), "--public-target": join(tmpdir(), "knowledge.json"), "--catalog": "c", "--config": "c", "--curation": "c",
    "--curation-bundle": "c", "--profile": "c", "--sealed-scope-digest": "a".repeat(64), "--diandian-dir": "c",
    "--video-analysis": "c", "--effective-date": "2026-08-25",
  };
  const run = (extra) => spawnSync(process.execPath, [script, ...Object.entries({ ...required, ...extra }).flat()], { encoding: "utf8" });
  for (const flag of ["--diandian-report", "--diandian-prompt-version"]) {
    const refused = run({ [flag]: "x" });
    assert.notEqual(refused.status, 0, flag);
    assert.match(refused.stderr, /SNAPSHOT_ARGUMENT_INVALID/, flag);
  }
  // Without the removed flags the arguments are accepted (the run then fails later on the files it cannot find).
  assert.doesNotMatch(run({}).stderr, /SNAPSHOT_ARGUMENT_INVALID/);
  assert.doesNotMatch(run({ "--source-codes": "x" }).stderr, /SNAPSHOT_ARGUMENT_INVALID/);
});

test("the builder version is 9, so a silent revert changes the version", async () => {
  const { canonicalVersion } = await import("../scripts/build-organization-snapshot.mjs");
  const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
  const without = canonicalVersion({ ...COMMON });
  assert.equal(without, sha(JSON.stringify({
    schema_version: 3, sealed_scope_sha256: COMMON.sealedScopeDigest, curation_input_sha256: COMMON.curationInputDigest,
    public_config_sha256: COMMON.configDigest, input_revision_sha256: COMMON.inputRevisionDigest,
    effective_date: COMMON.effectiveDate, builders: { public_site: 9 },
  })));
  const withSite = canonicalVersion({ ...COMMON, publishSiteDigest: "f".repeat(64) });
  assert.equal(withSite, sha(JSON.stringify({
    schema_version: 4, sealed_scope_sha256: COMMON.sealedScopeDigest, curation_input_sha256: COMMON.curationInputDigest,
    public_config_sha256: COMMON.configDigest, input_revision_sha256: COMMON.inputRevisionDigest,
    publish_site_sha256: "f".repeat(64), effective_date: COMMON.effectiveDate, builders: { public_site: 9 },
  })));
});

test("the audit file named in the config is frozen for the unreachable label, is optional, and a baseline file is ignored", async () => {
  const { captureBuilderInputs, materializeCapturedInputs } = await import("../scripts/build-organization-snapshot.mjs");
  const profile = await readFile(join(dirname(fileURLToPath(import.meta.url)), "../../../config/domain-profiles/software.json"), "utf8");
  const workspace = await captureWorkspace({
    configuration: JSON.stringify({ boards: [{ id: "private-board-id", name: "Synthetic", enabled: true }], public_stats: {}, curation_quality: { audit_file: ".xhs-favorites/curation-audit.json", baseline_file: ".xhs-favorites/baseline.json" } }),
  });
  const { root, noteId, files, options } = workspace;
  await writeFile(files.profile, profile);
  await writeFile(files.resources, JSON.stringify({ verified_at: "2026-08-25", resources: [] }));
  await writeFile(files.catalog, JSON.stringify({ notes: { [noteId]: { title: "不可访问的帖子", description: "文字", source_boards: ["Synthetic"] } } }));
  await writeFile(files.audit, JSON.stringify({ version: 2, notes: { [noteId]: { status: "unavailable" } } }));
  // A baseline file that does not exist is not an input at all.
  const first = await captureBuilderInputs(options, "2026-08-25");
  assert.equal(first.inputs.some((entry) => entry.name === "baseline_file"), false);
  const frozen = await materializeCapturedInputs(root, first, {});
  try {
    const frozenConfig = JSON.parse(await readFile(frozen.config, "utf8"));
    assert.equal(frozenConfig.curation_quality.audit_file, frozen.audit);
    assert.equal(Object.hasOwn(frozenConfig.curation_quality, "baseline_file"), false);
    assert.equal(JSON.parse(await readFile(frozen.audit, "utf8")).notes[noteId].status, "unavailable");
    const built = join(frozen.root, "knowledge.json");
    const run = spawnSync(process.execPath, [
      fileURLToPath(new URL("../scripts/build-public-site.mjs", import.meta.url)),
      "--catalog", frozen.catalog, "--config", frozen.config, "--curation", frozen.curation, "--profile", frozen.profile,
      "--resources", frozen.resources, "--candidates", frozen.candidates, "--diandian-dir", frozen.diandian,
      "--video-analysis", frozen.video, "--damaged-replies", frozen.damaged, "--effective-date", "2026-08-25", "--output", built,
    ], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(await readFile(built, "utf8")).notes[0].postUnreachable, true);
  } finally {
    await rm(frozen.root, { recursive: true, force: true });
  }

  // Changing the audit changes the version; a missing audit file is allowed.
  await writeFile(files.audit, JSON.stringify({ version: 2, notes: {} }));
  assert.notEqual((await captureBuilderInputs(options, "2026-08-25")).inputRevisionDigest, first.inputRevisionDigest);
  await rm(files.audit);
  const missing = await captureBuilderInputs(options, "2026-08-25");
  const frozenMissing = await materializeCapturedInputs(root, missing, {});
  await rm(frozenMissing.root, { recursive: true, force: true });
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
