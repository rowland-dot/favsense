#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { executeJournaledTransaction, recoverJournaledTransaction } from "./journaled-transaction.mjs";
import { acquireOrganizationMutationLock } from "./organization-mutation-lock.mjs";

const HASH = /^[a-f0-9]{64}$/;
const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

function canonicalVersion({ sealedScopeDigest, curationInputDigest, configDigest, inputRevisionDigest, effectiveDate }) {
  for (const value of [sealedScopeDigest, curationInputDigest, configDigest, inputRevisionDigest]) if (!HASH.test(value)) throw new Error("SNAPSHOT_DIGEST_INVALID");
  if (!validDate(effectiveDate)) throw new Error("SNAPSHOT_EFFECTIVE_DATE_INVALID");
  const preimage = { schema_version: 2, sealed_scope_sha256: sealedScopeDigest, curation_input_sha256: curationInputDigest, public_config_sha256: configDigest, input_revision_sha256: inputRevisionDigest, effective_date: effectiveDate, builders: { knowledge_base: 2, public_site: 2 } };
  return createHash("sha256").update(JSON.stringify(preimage), "utf8").digest("hex");
}

async function exists(path) { try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }

async function validateStagedVersions(kbStaging, publicStaging, buildVersion) {
  const kb = JSON.parse(await readFile(join(kbStaging, "build.json"), "utf8"));
  const publicData = JSON.parse(await readFile(publicStaging, "utf8"));
  if (kb.build_version !== buildVersion || publicData?.meta?.buildVersion !== buildVersion) throw new Error("SNAPSHOT_BUILD_VERSION_MISMATCH");
}

async function acquireSnapshotLock(storageRoot) {
  const lock = join(storageRoot, ".organization-snapshot-lock");
  const nonce = randomUUID();
  const candidate = `${lock}.candidate-${nonce}`;
  await mkdir(candidate);
  await writeFile(join(candidate, "owner.json"), `${JSON.stringify({ schema_version: 1, pid: process.pid, nonce })}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await rename(candidate, lock);
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY"].includes(error.code) && !(error.code === "EPERM" && await exists(lock))) throw error;
    const lockMetadata = await lstat(lock);
    if (!lockMetadata.isDirectory() || lockMetadata.isSymbolicLink()) throw new Error("SNAPSHOT_LOCK_INVALID");
    let owner = null;
    try { owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")); } catch { throw new Error("SNAPSHOT_LOCK_INVALID"); }
    let active = false;
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      try { process.kill(owner.pid, 0); active = true; } catch (probeError) { active = probeError.code === "EPERM"; }
    }
    if (active) throw new Error("SNAPSHOT_ALREADY_RUNNING");
    const stale = `${lock}.stale-${randomUUID()}`;
    try { await rename(lock, stale); } catch { throw new Error("SNAPSHOT_ALREADY_RUNNING"); }
    try { await rename(candidate, lock); } finally { await rm(stale, { recursive: true, force: true }); }
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
  return async () => {
    let owner = null;
    try { owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")); } catch { return; }
    if (owner.nonce === nonce) await rm(lock, { recursive: true, force: true });
  };
}

async function recoverPendingSnapshotTransactions(root, storageRoot, participants) {
  const rootNames = await readdir(storageRoot);
  const names = rootNames.filter((name) => name.startsWith(".organization-tx-snapshot-")).sort();
  for (const name of names) {
    const id = name.slice(".organization-tx-".length);
    if (!/^snapshot-[a-f0-9]{32}$/.test(id)) throw new Error("SNAPSHOT_RECOVERY_ID_INVALID");
    await recoverJournaledTransaction({ root, transactionRoot: storageRoot, id, participants });
  }
  for (const name of rootNames.filter((entry) => entry.startsWith(".organization-build-snapshot-")).sort()) {
    if (!/^\.organization-build-snapshot-[a-f0-9]{32}$/.test(name)) throw new Error("SNAPSHOT_STAGING_ID_INVALID");
    await rm(join(storageRoot, name), { recursive: true, force: true });
  }
  for (const name of rootNames.filter((entry) => entry.startsWith("snapshot-input-")).sort()) {
    if (!/^snapshot-input-[A-Za-z0-9_-]+$/.test(name)) throw new Error("SNAPSHOT_INPUT_STAGING_ID_INVALID");
    await rm(join(storageRoot, name), { recursive: true, force: true });
  }
}

async function assertNoPendingMigrationTransaction(root) {
  const pending = (await readdir(root)).filter((name) => name.startsWith(".organization-tx-migration-"));
  if (pending.length) throw new Error("SNAPSHOT_MIGRATION_RECOVERY_REQUIRED");
}

export async function buildOrganizationSnapshot(options) {
  const root = resolve(options.root);
  const storageRoot = join(root, ".xhs-tools", "organization-snapshots");
  const kbTarget = resolve(options.kbTarget);
  const publicTarget = resolve(options.publicTarget);
  if (!inside(root, kbTarget) || !inside(root, publicTarget)) throw new Error("SNAPSHOT_TARGET_INVALID");
  const releaseMutationLock = await acquireOrganizationMutationLock(root, {
    busyError: () => new Error("SNAPSHOT_ALREADY_RUNNING"),
    invalidError: () => new Error("SNAPSHOT_LOCK_INVALID"),
  });
  let releaseLock = null;
  const participants = [
    { name: "knowledge-base", target: kbTarget },
    { name: "public", target: publicTarget },
  ];
  let stagingRoot = null;
  try {
    await assertPlainPath(root, storageRoot);
    await mkdir(storageRoot, { recursive: true });
    await assertPlainPath(root, storageRoot);
    const storageMetadata = await lstat(storageRoot);
    if (!storageMetadata.isDirectory() || storageMetadata.isSymbolicLink()) throw new Error("SNAPSHOT_STORAGE_INVALID");
    releaseLock = await acquireSnapshotLock(storageRoot);
    await assertNoPendingMigrationTransaction(root);
    await recoverPendingSnapshotTransactions(root, storageRoot, participants);
    const prepared = typeof options.prepareSnapshot === "function" ? await options.prepareSnapshot() : {};
    const buildOptions = { ...options, ...prepared };
    const buildVersion = canonicalVersion(buildOptions);
    const transactionId = `snapshot-${buildVersion.slice(0, 32)}`;
    stagingRoot = join(storageRoot, `.organization-build-${transactionId}`);
    const kbStaging = join(stagingRoot, "knowledge-base");
    const publicStaging = join(stagingRoot, "knowledge.json");
    await rm(stagingRoot, { recursive: true, force: true });
    await mkdir(stagingRoot);
    await buildOptions.buildKnowledgeBase({ target: kbStaging, buildVersion });
    await buildOptions.buildPublicSite({ target: publicStaging, buildVersion });
    await buildOptions.verifyInputs?.();
    await validateStagedVersions(kbStaging, publicStaging, buildVersion);
    await executeJournaledTransaction({
      root,
      transactionRoot: storageRoot,
      id: transactionId,
      failAt: buildOptions.failAt,
      participants: participants.map((participant) => ({
        ...participant,
        staging: participant.name === "knowledge-base" ? kbStaging : publicStaging,
      })),
    });
    await rm(stagingRoot, { recursive: true, force: true });
    return { schema_version: 1, ok: true, outcome: "built", build_version: buildVersion, counts: buildOptions.counts || { notes: 0, categories: 0, resources: 0 } };
  } catch (error) {
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  } finally {
    await releaseLock?.();
    await releaseMutationLock();
  }
}

export function effectiveCuration(current, bundle) {
  if (
    !current || typeof current !== "object" || Array.isArray(current)
    || !bundle || typeof bundle !== "object" || Array.isArray(bundle)
    || bundle.schema_version !== 1
    || bundle.outcome !== "ready_for_safe_build"
    || !bundle.scope || typeof bundle.scope !== "object" || Array.isArray(bundle.scope)
    || !Array.isArray(bundle.scope.note_ids)
    || !bundle.curation || typeof bundle.curation !== "object" || Array.isArray(bundle.curation)
  ) throw new Error("SNAPSHOT_CURATION_BUNDLE_INVALID");
  const safeId = (value) => /^[A-Za-z0-9_-]{1,128}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
  const scopeIds = [...new Set(bundle.scope.note_ids)];
  const curationIds = Object.keys(bundle.curation);
  if (
    scopeIds.length !== bundle.scope.note_ids.length
    || scopeIds.some((id) => typeof id !== "string" || !safeId(id))
    || scopeIds.sort().join("\n") !== [...curationIds].sort().join("\n")
  ) throw new Error("SNAPSHOT_CURATION_BUNDLE_INVALID");
  const result = Object.fromEntries(Object.entries(current).filter(([id]) => safeId(id)));
  for (const [id, entry] of Object.entries(bundle.curation)) {
    if (!safeId(id) || !entry || typeof entry !== "object" || Array.isArray(entry) || !["accepted", "pending", "rejected"].includes(entry.review_status)) {
      throw new Error("SNAPSHOT_CURATION_BUNDLE_INVALID");
    }
    if (entry.review_status === "accepted") result[id] = entry;
    else delete result[id];
  }
  return result;
}

export function curationGenerationDigest(formalSource, bundleSource) {
  const preimage = {
    schema_version: 1,
    formal_curation_sha256: createHash("sha256").update(formalSource).digest("hex"),
    curation_bundle_sha256: createHash("sha256").update(bundleSource).digest("hex"),
  };
  return createHash("sha256").update(JSON.stringify(preimage), "utf8").digest("hex");
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function inside(root, target) {
  const child = relative(root, target);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..\\`) && !child.startsWith("../"));
}

async function assertPlainPath(root, target) {
  if (!inside(root, target)) throw new Error("SNAPSHOT_INPUT_PATH_INVALID");
  const child = relative(root, target);
  let current = root;
  for (const part of child.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part);
    const metadata = await exists(current);
    if (!metadata) break;
    if (metadata.isSymbolicLink()) throw new Error("SNAPSHOT_INPUT_PATH_INVALID");
  }
}

async function boundedFile(root, target, label, { optional = false, maxBytes = 16 * 1024 * 1024 } = {}) {
  await assertPlainPath(root, target);
  const before = await exists(target);
  if (!before) {
    if (optional) return { name: label, state: "missing", sha256: "" };
    throw new Error("SNAPSHOT_INPUT_UNAVAILABLE");
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error("SNAPSHOT_INPUT_INVALID");
  const source = await readFile(target);
  const after = await lstat(target);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("SNAPSHOT_INPUT_CHANGED");
  return { name: label, state: "file", sha256: sha256(source), source };
}

async function imageInventory(root, directory, noteId) {
  await assertPlainPath(root, directory);
  const metadata = await exists(directory);
  if (!metadata) return [];
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("SNAPSHOT_INPUT_INVALID");
  const images = [];
  async function visit(current, prefix = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("SNAPSHOT_INPUT_PATH_INVALID");
      const entryPath = join(current, entry.name);
      const relativeName = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(entryPath, relativeName);
      else if (entry.isFile() && /\.(?:jpe?g|png|webp)$/iu.test(entry.name)) images.push(relativeName);
    }
  }
  await visit(directory);
  return images.sort().map((name) => ({ name: `image:${noteId}:${name}`, state: "present", sha256: "" }));
}

export async function captureBuilderInputs(options, effectiveDate) {
  const root = resolve(options.root);
  const fixed = {
    catalog: resolve(options.catalog),
    config: resolve(options.config),
    curation: resolve(options.curation),
    bundle: resolve(options.curationBundle),
    profile: resolve(options.profile),
    diandian: resolve(options.diandianDir),
    report: resolve(options.diandianReport),
    video: resolve(options.videoAnalysis),
    ...(options.resources ? { resources: resolve(options.resources) } : {}),
  };
  for (const target of Object.values(fixed)) await assertPlainPath(root, target);
  const core = await Promise.all([
    boundedFile(root, fixed.catalog, "catalog"),
    boundedFile(root, fixed.config, "config"),
    boundedFile(root, fixed.curation, "formal-curation"),
    boundedFile(root, fixed.bundle, "curation-bundle"),
    boundedFile(root, fixed.profile, "profile"),
    ...(fixed.resources ? [boundedFile(root, fixed.resources, "resources")] : []),
    boundedFile(root, fixed.report, "diandian-report", { optional: true }),
  ]);
  const byName = new Map(core.map((entry) => [entry.name, entry]));
  let catalog;
  let config;
  let bundle;
  let profile;
  try {
    catalog = JSON.parse(byName.get("catalog").source.toString("utf8").replace(/^\uFEFF/u, ""));
    config = JSON.parse(byName.get("config").source.toString("utf8").replace(/^\uFEFF/u, ""));
    bundle = JSON.parse(byName.get("curation-bundle").source.toString("utf8").replace(/^\uFEFF/u, ""));
    profile = JSON.parse(byName.get("profile").source.toString("utf8").replace(/^\uFEFF/u, ""));
  } catch {
    throw new Error("SNAPSHOT_INPUT_INVALID");
  }
  if (!bundle?.scope || !Array.isArray(bundle.scope.note_ids)) throw new Error("SNAPSHOT_INPUT_INVALID");
  if (profile?.features?.resource_index === true && !byName.has("resources")) throw new Error("SNAPSHOT_INPUT_UNAVAILABLE");
  const noteIds = Object.keys(catalog?.notes || {}).filter((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id)).sort();
  const quality = config?.curation_quality && typeof config.curation_quality === "object" ? config.curation_quality : {};
  const inputs = [...core];
  if (quality.publish_only_accepted === true) {
    inputs.push(await boundedFile(root, resolve(root, quality.audit_file || ".xhs-favorites/curation-audit.json"), "audit_file"));
    if (typeof quality.baseline_file === "string" && quality.baseline_file) {
      inputs.push(await boundedFile(root, resolve(root, quality.baseline_file), "baseline_file"));
    }
  }
  const videoRoot = await exists(fixed.video);
  if (videoRoot && (!videoRoot.isDirectory() || videoRoot.isSymbolicLink())) throw new Error("SNAPSHOT_INPUT_INVALID");
  inputs.push({ name: "video-analysis-root", state: videoRoot ? "directory" : "missing", sha256: "" });
  for (const noteId of noteIds) {
    inputs.push(await boundedFile(root, join(fixed.diandian, `${noteId}.json`), `point:${noteId}`, { optional: true, maxBytes: 512 * 1024 }));
    if (/^[a-f0-9]{24}$/.test(noteId)) {
      const noteDirectory = join(fixed.video, noteId);
      inputs.push(await boundedFile(root, join(noteDirectory, "analysis.json"), `analysis:${noteId}`, { optional: true, maxBytes: 1024 * 1024 }));
      inputs.push(...await imageInventory(root, noteDirectory, noteId));
    }
  }
  const manifest = {
    schema_version: 1,
    effective_date: effectiveDate,
    inputs: inputs.map(({ name, state, sha256: digest }) => ({ name, state, sha256: digest })).sort((left, right) => left.name.localeCompare(right.name)),
  };
  const formalSource = byName.get("formal-curation").source;
  const bundleSource = byName.get("curation-bundle").source;
  const resourceHash = byName.get("resources")?.sha256 || sha256(Buffer.alloc(0));
  return {
    inputs,
    config,
    formalSource,
    bundleSource,
    sealedScopeDigest: sha256(JSON.stringify(bundle.scope.note_ids.slice().sort())),
    curationInputDigest: curationGenerationDigest(formalSource, bundleSource),
    configDigest: sha256(JSON.stringify({
      schema_version: 1,
      config_sha256: byName.get("config").sha256,
      profile_sha256: byName.get("profile").sha256,
      resources_sha256: resourceHash,
    })),
    inputRevisionDigest: sha256(JSON.stringify(manifest)),
  };
}

export async function materializeCapturedInputs(root, captured, effectiveCurationValue) {
  const storageRoot = join(root, ".xhs-tools", "organization-snapshots");
  await assertPlainPath(root, storageRoot);
  await mkdir(storageRoot, { recursive: true });
  await assertPlainPath(root, storageRoot);
  const inputRoot = await mkdtemp(join(storageRoot, "snapshot-input-"));
  const paths = {
    root: inputRoot,
    catalog: join(inputRoot, "catalog.json"),
    config: join(inputRoot, "config.json"),
    curation: join(inputRoot, "curation.json"),
    profile: join(inputRoot, "profile.json"),
    resources: join(inputRoot, "resources.json"),
    diandian: join(inputRoot, "diandian-summaries"),
    report: join(inputRoot, "diandian-rerun-report.json"),
    video: join(inputRoot, "video-analysis"),
    audit: join(inputRoot, "curation-audit.json"),
    baseline: join(inputRoot, "curation-baseline.json"),
  };
  const entries = new Map(captured.inputs.map((entry) => [entry.name, entry]));
  const writeEntry = async (name, target) => {
    const entry = entries.get(name);
    if (entry?.state !== "file") return false;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, entry.source, { flag: "wx" });
    return true;
  };
  await writeEntry("catalog", paths.catalog);
  await writeEntry("profile", paths.profile);
  const hasResources = await writeEntry("resources", paths.resources);
  await writeEntry("diandian-report", paths.report);
  await mkdir(paths.diandian, { recursive: true });
  for (const [name, entry] of entries) {
    if (name.startsWith("point:") && entry.state === "file") await writeEntry(name, join(paths.diandian, `${name.slice(6)}.json`));
  }
  if (entries.get("video-analysis-root")?.state === "directory") await mkdir(paths.video, { recursive: true });
  for (const [name, entry] of entries) {
    if (name.startsWith("analysis:") && entry.state === "file") {
      await writeEntry(name, join(paths.video, name.slice(9), "analysis.json"));
    } else if (name.startsWith("image:") && entry.state === "present") {
      const [, noteId, ...relativeName] = name.split(":");
      const target = join(paths.video, noteId, ...relativeName.join(":").split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "", { flag: "wx" });
    }
  }
  const config = structuredClone(captured.config);
  if (config?.curation_quality?.publish_only_accepted === true) {
    config.curation_quality.audit_file = paths.audit;
    await writeEntry("audit_file", paths.audit);
    if (entries.has("baseline_file")) {
      config.curation_quality.baseline_file = paths.baseline;
      await writeEntry("baseline_file", paths.baseline);
    }
  }
  await writeFile(paths.config, `${JSON.stringify(config)}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(paths.curation, `${JSON.stringify(effectiveCurationValue)}\n`, { encoding: "utf8", flag: "wx" });
  return { ...paths, ...(hasResources ? {} : { resources: "" }) };
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

export async function compareAndSetFinalizer({ statePath: sourceStatePath, runId, buildVersion, action }) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(runId) || !HASH.test(buildVersion) || typeof action !== "function") throw new Error("FINALIZER_INPUT_INVALID");
  const statePath = resolve(sourceStatePath);
  let current = null;
  try { current = JSON.parse(await readFile(statePath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (current?.run_id === runId && current?.build_version === buildVersion && current?.state === "finalized") return { outcome: "already_finalized", result: current.result };
  if (current?.state === "running") throw new Error("FINALIZER_ALREADY_RUNNING");
  await atomicJson(statePath, { schema_version: 1, run_id: runId, build_version: buildVersion, state: "running" });
  try {
    const result = await action();
    await atomicJson(statePath, { schema_version: 1, run_id: runId, build_version: buildVersion, state: "finalized", result });
    return { outcome: "finalized", result };
  } catch (error) {
    await atomicJson(statePath, { schema_version: 1, run_id: runId, build_version: buildVersion, state: "failed" });
    throw error;
  }
}

function cliArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("SNAPSHOT_ARGUMENT_INVALID");
    result[key.slice(2)] = value;
  }
  const required = ["root", "kb-target", "public-target", "catalog", "config", "curation", "curation-bundle", "profile", "sealed-scope-digest", "diandian-dir", "diandian-report", "video-analysis", "effective-date"];
  if (Object.keys(result).some((key) => ![...required, "resources"].includes(key)) || required.some((key) => !result[key])) throw new Error("SNAPSHOT_ARGUMENT_INVALID");
  return result;
}

function runBuilder(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("SNAPSHOT_BUILDER_FAILED");
}

async function runCli() {
  const options = cliArgs(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(options.root);
  const effectiveDate = options["effective-date"];
  if (!validDate(effectiveDate)) throw new Error("SNAPSHOT_EFFECTIVE_DATE_INVALID");
  const captureOptions = {
    root,
    catalog: options.catalog,
    config: options.config,
    curation: options.curation,
    curationBundle: options["curation-bundle"],
    profile: options.profile,
    diandianDir: options["diandian-dir"],
    diandianReport: options["diandian-report"],
    videoAnalysis: options["video-analysis"],
    ...(options.resources ? { resources: options.resources } : {}),
  };
  let frozen = null;
  try {
    const result = await buildOrganizationSnapshot({
      root, kbTarget: resolve(options["kb-target"]), publicTarget: resolve(options["public-target"]),
      effectiveDate,
      prepareSnapshot: async () => {
        const captured = await captureBuilderInputs(captureOptions, effectiveDate);
        if (captured.sealedScopeDigest !== options["sealed-scope-digest"]) throw new Error("SNAPSHOT_SCOPE_DIGEST_MISMATCH");
        const effective = effectiveCuration(
          JSON.parse(captured.formalSource.toString("utf8")),
          JSON.parse(captured.bundleSource.toString("utf8")),
        );
        frozen = await materializeCapturedInputs(root, captured, effective);
        return {
          sealedScopeDigest: captured.sealedScopeDigest,
          curationInputDigest: captured.curationInputDigest,
          configDigest: captured.configDigest,
          inputRevisionDigest: captured.inputRevisionDigest,
        };
      },
      buildKnowledgeBase: async ({ target, buildVersion }) => {
        const shared = ["--catalog", frozen.catalog, "--config", frozen.config, "--curation", frozen.curation, "--profile", frozen.profile, "--effective-date", effectiveDate];
        runBuilder(join(scriptDir, "build-knowledge-base.mjs"), [...shared, "--output", target, "--diandian-dir", frozen.diandian, ...(frozen.resources ? ["--resources", frozen.resources] : [])]);
        await writeFile(join(target, "build.json"), `${JSON.stringify({ schema_version: 1, build_version: buildVersion })}\n`, "utf8");
      },
      buildPublicSite: async ({ target, buildVersion }) => {
        const shared = ["--catalog", frozen.catalog, "--config", frozen.config, "--curation", frozen.curation, "--profile", frozen.profile, "--effective-date", effectiveDate];
        runBuilder(join(scriptDir, "build-public-site.mjs"), [...shared, "--output", target, "--build-version", buildVersion, "--diandian-dir", frozen.diandian, "--diandian-report", frozen.report, "--video-analysis", frozen.video, ...(frozen.resources ? ["--resources", frozen.resources] : [])]);
      },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    if (frozen) await rm(frozen.root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCli().catch((error) => { process.stderr.write(`organization-snapshot: ${String(error.message || "failed").replace(/[\r\n]+/g, " ")}\n`); process.exitCode = 1; });
}
