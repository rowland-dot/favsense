#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { executeJournaledTransaction, recoverJournaledTransaction } from "./journaled-transaction.mjs";
import { acquireOrganizationMutationLock, claimLockFolder, releaseLockFolder } from "./organization-mutation-lock.mjs";
import { writeDamagedReplies } from "./damaged-replies.mjs";

const HASH = /^[a-f0-9]{64}$/;
const validDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

// The published site's own code is part of the version (issue 43), so a front-end-only change cannot reuse
// an already-frozen version. A build with a publish site hashes its content into a version-4 preimage; a
// build without one keeps the version-3 preimage and therefore the version it always had.
export function canonicalVersion({ sealedScopeDigest, curationInputDigest, configDigest, inputRevisionDigest, effectiveDate, publishSiteDigest }) {
  const digests = [sealedScopeDigest, curationInputDigest, configDigest, inputRevisionDigest, ...(publishSiteDigest === undefined ? [] : [publishSiteDigest])];
  for (const value of digests) if (!HASH.test(value)) throw new Error("SNAPSHOT_DIGEST_INVALID");
  if (!validDate(effectiveDate)) throw new Error("SNAPSHOT_EFFECTIVE_DATE_INVALID");
  const preimage = {
    schema_version: publishSiteDigest === undefined ? 3 : 4,
    sealed_scope_sha256: sealedScopeDigest,
    curation_input_sha256: curationInputDigest,
    public_config_sha256: configDigest,
    input_revision_sha256: inputRevisionDigest,
    ...(publishSiteDigest === undefined ? {} : { publish_site_sha256: publishSiteDigest }),
    effective_date: effectiveDate,
    builders: { public_site: 13 },
  };
  return createHash("sha256").update(JSON.stringify(preimage), "utf8").digest("hex");
}

async function exists(path, options) { try { return await lstat(path, options); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }

// "Still the same file" is decided on exact (bigint) file info only. Ordinary Number values round the
// 64-bit Windows file number, so two different files can read back as the same one and a swapped-in
// file would pass. Both sides of every comparison must come from a call that passes EXACT: a Number
// never equals a BigInt, so a mixed pair would fail every comparison.
const EXACT = { bigint: true };

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs;
}

async function validateStagedVersion(publicStaging, buildVersion) {
  const publicData = JSON.parse(await readFile(publicStaging, "utf8"));
  if (publicData?.meta?.buildVersion !== buildVersion) throw new Error("SNAPSHOT_BUILD_VERSION_MISMATCH");
}

async function acquireSnapshotLock(storageRoot) {
  const lock = join(storageRoot, ".organization-snapshot-lock");
  const nonce = randomUUID();
  const candidate = `${lock}.candidate-${nonce}`;
  await mkdir(candidate);
  await writeFile(join(candidate, "owner.json"), `${JSON.stringify({ schema_version: 1, pid: process.pid, nonce })}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await claimLockFolder(candidate, lock, {
      busyError: () => new Error("SNAPSHOT_ALREADY_RUNNING"),
      invalidError: () => new Error("SNAPSHOT_LOCK_INVALID"),
    });
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
  return () => releaseLockFolder(lock, nonce);
}

// Before issue 39 a snapshot swapped two outputs, so a crash of that version leaves a journal naming both.
// That journal is finished the way it was written: the knowledge-base target comes from the journal's own
// record (it must still sit inside the workspace and not be a link), the web data target from this build.
// Any other journal shape is held to the participants of this build alone.
function participantsForJournal(root, publicParticipant, record) {
  const entries = Array.isArray(record.participants) ? record.participants : [];
  const knowledgeBase = entries.find((entry) => entry?.name === "knowledge-base");
  if (entries.length !== 2 || !knowledgeBase || typeof knowledgeBase.target !== "string") return [publicParticipant];
  return [{ name: "knowledge-base", target: resolve(root, knowledgeBase.target) }, publicParticipant];
}

async function recoverPendingSnapshotTransactions(root, storageRoot, publicParticipant) {
  const rootNames = await readdir(storageRoot);
  const names = rootNames.filter((name) => name.startsWith(".organization-tx-snapshot-")).sort();
  for (const name of names) {
    const id = name.slice(".organization-tx-".length);
    if (!/^snapshot-[a-f0-9]{32}$/.test(id)) throw new Error("SNAPSHOT_RECOVERY_ID_INVALID");
    await recoverJournaledTransaction({
      root,
      transactionRoot: storageRoot,
      id,
      participants: (record) => participantsForJournal(root, publicParticipant, record),
    });
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
  const publicTarget = resolve(options.publicTarget);
  if (!inside(root, publicTarget)) throw new Error("SNAPSHOT_TARGET_INVALID");
  const releaseMutationLock = await acquireOrganizationMutationLock(root, {
    busyError: () => new Error("SNAPSHOT_ALREADY_RUNNING"),
    invalidError: () => new Error("SNAPSHOT_LOCK_INVALID"),
  });
  let releaseLock = null;
  const publicParticipant = { name: "public", target: publicTarget };
  let stagingRoot = null;
  try {
    await assertPlainPath(root, storageRoot);
    await mkdir(storageRoot, { recursive: true });
    await assertPlainPath(root, storageRoot);
    const storageMetadata = await lstat(storageRoot);
    if (!storageMetadata.isDirectory() || storageMetadata.isSymbolicLink()) throw new Error("SNAPSHOT_STORAGE_INVALID");
    releaseLock = await acquireSnapshotLock(storageRoot);
    await assertNoPendingMigrationTransaction(root);
    await recoverPendingSnapshotTransactions(root, storageRoot, publicParticipant);
    const prepared = typeof options.prepareSnapshot === "function" ? await options.prepareSnapshot() : {};
    const buildOptions = { ...options, ...prepared };
    const publishSiteDigest = buildOptions.publishSite
      ? await publishSiteContentDigest(root, buildOptions.publishSite)
      : undefined;
    const buildVersion = canonicalVersion({ ...buildOptions, publishSiteDigest });
    const transactionId = `snapshot-${buildVersion.slice(0, 32)}`;
    stagingRoot = join(storageRoot, `.organization-build-${transactionId}`);
    const publicStaging = join(stagingRoot, "knowledge.json");
    await rm(stagingRoot, { recursive: true, force: true });
    await mkdir(stagingRoot);
    await buildOptions.buildPublicSite({ target: publicStaging, buildVersion });
    await buildOptions.verifyInputs?.();
    await validateStagedVersion(publicStaging, buildVersion);
    let publishManifest = null;
    if (buildOptions.publishSite) {
      publishManifest = await freezePublishSite(
        root,
        storageRoot,
        buildOptions.publishSite,
        publicStaging,
        buildVersion,
        publishSiteDigest,
      );
    }
    await executeJournaledTransaction({
      root,
      transactionRoot: storageRoot,
      id: transactionId,
      failAt: buildOptions.failAt,
      participants: [{ ...publicParticipant, staging: publicStaging }],
    });
    await rm(stagingRoot, { recursive: true, force: true });
    return {
      schema_version: 1,
      ok: true,
      outcome: "built",
      build_version: buildVersion,
      ...(publishManifest ? { site_manifest_sha256: publishManifest.tree_sha256 } : {}),
      counts: buildOptions.counts || { notes: 0, categories: 0, resources: 0 },
    };
  } catch (error) {
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  } finally {
    // A snapshot lock that cannot be released must not keep the mutation lock too.
    try {
      await releaseLock?.();
    } finally {
      await releaseMutationLock();
    }
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
    if (!safeId(id) || !entry || typeof entry !== "object" || Array.isArray(entry) || !["accepted", "unavailable", "pending", "rejected"].includes(entry.review_status)) {
      throw new Error("SNAPSHOT_CURATION_BUNDLE_INVALID");
    }
    if (entry.review_status === "accepted") result[id] = entry;
    else delete result[id];
  }
  return result;
}

// The sealed candidate of every scoped note that is not accepted. The formal curation drops them, but
// the builders still need each one's sealed kind and revisions to say why the note is not accepted.
export function unacceptedCandidates(bundle) {
  return Object.fromEntries(Object.entries(bundle?.curation || {}).filter(([, entry]) => entry?.review_status !== "accepted"));
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

async function assertPlainTree(root) {
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("SNAPSHOT_PUBLISH_SITE_INVALID");
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("SNAPSHOT_PUBLISH_SITE_INVALID");
      if (entry.isDirectory()) await visit(join(directory, entry.name));
    }
  }
  await visit(root);
}

async function validatePublishSite(root, site, buildVersion) {
  await assertPlainPath(root, site);
  await assertPlainTree(site);
  let knowledge;
  try {
    knowledge = JSON.parse(await readFile(join(site, "data", "knowledge.json"), "utf8"));
  } catch {
    throw new Error("SNAPSHOT_PUBLISH_SITE_INVALID");
  }
  if (knowledge?.meta?.buildVersion !== buildVersion) throw new Error("SNAPSHOT_BUILD_VERSION_MISMATCH");
}

async function scanSiteTree(site, buildVersion, {
  captureFiles = false,
  excludedRootNames = [],
} = {}) {
  // A null version scans the tree before any version exists (the version is computed from this scan).
  if (buildVersion !== null && !HASH.test(buildVersion)) throw new Error("SNAPSHOT_DIGEST_INVALID");
  const treeRoot = resolve(site);
  const rootMetadata = await lstat(treeRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("SNAPSHOT_PUBLISH_SITE_INVALID");
  const canonicalRoot = await realpath(treeRoot);
  const excluded = new Set(excludedRootNames.map((name) => name.toLowerCase()));
  const entries = [];
  const files = [];
  let totalBytes = 0;
  async function visit(directory, prefix = "") {
    const directoryBefore = await lstat(directory, EXACT);
    const directoryRealBefore = await realpath(directory);
    if (
      !directoryBefore.isDirectory()
      || directoryBefore.isSymbolicLink()
      || !inside(canonicalRoot, directoryRealBefore)
    ) throw new Error("SNAPSHOT_PUBLISH_SITE_INVALID");
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (!prefix && excluded.has(child.name.toLowerCase())) continue;
      const target = join(directory, child.name);
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      const before = await lstat(target, EXACT);
      if (before.isSymbolicLink()) throw new Error("SNAPSHOT_PUBLISH_SITE_INVALID");
      if (before.isDirectory()) {
        entries.push({ kind: "directory", path: relativePath });
        await visit(target, relativePath);
      } else if (before.isFile()) {
        const resolvedBefore = await realpath(target);
        if (!inside(canonicalRoot, resolvedBefore)) throw new Error("SNAPSHOT_PUBLISH_SITE_INVALID");
        const handle = await open(
          target,
          fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
        );
        try {
          const opened = await handle.stat(EXACT);
          if (!opened.isFile() || !sameFileIdentity(before, opened)) {
            throw new Error("SNAPSHOT_PUBLISH_SITE_CHANGED");
          }
          const source = await handle.readFile();
          const openedAfter = await handle.stat(EXACT);
          const after = await lstat(target, EXACT);
          const resolvedAfter = await realpath(target);
          if (
            !sameFileIdentity(opened, openedAfter)
            || !sameFileIdentity(before, after)
            || resolvedAfter !== resolvedBefore
            || !inside(canonicalRoot, resolvedAfter)
          ) throw new Error("SNAPSHOT_PUBLISH_SITE_CHANGED");
          totalBytes += source.byteLength;
          if (totalBytes > 128 * 1024 * 1024) throw new Error("SNAPSHOT_PUBLISH_SITE_INVALID");
          entries.push({
            kind: "file",
            path: relativePath,
            size: source.byteLength,
            sha256: sha256(source),
          });
          if (captureFiles) files.push({ path: relativePath, source });
        } finally {
          await handle.close();
        }
      } else {
        throw new Error("SNAPSHOT_PUBLISH_SITE_INVALID");
      }
    }
    const directoryAfter = await lstat(directory, EXACT);
    const directoryRealAfter = await realpath(directory);
    if (
      !sameFileIdentity(directoryBefore, directoryAfter)
      || directoryRealAfter !== directoryRealBefore
      || !inside(canonicalRoot, directoryRealAfter)
    ) throw new Error("SNAPSHOT_PUBLISH_SITE_CHANGED");
  }
  await visit(treeRoot);
  const treeSha256 = sha256(JSON.stringify({ schema_version: 1, entries }));
  return {
    manifest: {
      schema_version: 1,
      build_version: buildVersion,
      tree_sha256: treeSha256,
      entries,
    },
    files,
  };
}

export async function siteTreeManifest(site, buildVersion) {
  return (await scanSiteTree(site, buildVersion)).manifest;
}

// Every build rewrites the live web data file (the snapshot's public target), so it cannot be part of the
// site's identity: the version would drift with the previous build's own output.
const SITE_DIGEST_EXCLUDED_PATHS = ["data/knowledge.json"];

function siteContentDigest(entries) {
  const kept = entries.filter((entry) => !SITE_DIGEST_EXCLUDED_PATHS.includes(entry.path));
  return sha256(JSON.stringify({ schema_version: 1, entries: kept }));
}

async function publishSiteContentDigest(root, site) {
  const source = resolve(site);
  await assertPlainPath(root, source);
  await assertPlainTree(source);
  const { manifest } = await scanSiteTree(source, null, { excludedRootNames: [".local"] });
  return siteContentDigest(manifest.entries);
}

function sameSiteManifest(left, right) {
  return left?.schema_version === 1
    && left?.build_version === right?.build_version
    && left?.tree_sha256 === right?.tree_sha256
    && JSON.stringify(left?.entries) === JSON.stringify(right?.entries);
}

export async function readFrozenSiteManifest(site, buildVersion) {
  try {
    const manifestPath = join(dirname(resolve(site)), "manifest.json");
    const metadata = await lstat(manifestPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024) {
      throw new Error("SNAPSHOT_PUBLISH_MANIFEST_MISMATCH");
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const current = await siteTreeManifest(site, buildVersion);
    if (!sameSiteManifest(manifest, current)) throw new Error("SNAPSHOT_PUBLISH_MANIFEST_MISMATCH");
    return current;
  } catch {
    throw new Error("SNAPSHOT_PUBLISH_MANIFEST_MISMATCH");
  }
}

async function freezePublishSite(root, storageRoot, site, publicStaging, buildVersion, expectedSiteDigest) {
  const source = resolve(site);
  await assertPlainPath(root, source);
  await assertPlainTree(source);
  const publishRoot = join(storageRoot, "publish");
  await assertPlainPath(root, publishRoot);
  await mkdir(publishRoot, { recursive: true });
  await assertPlainPath(root, publishRoot);
  const versionRoot = join(publishRoot, buildVersion);
  const frozenSite = join(versionRoot, "site");
  const staging = join(publishRoot, `.publish-${buildVersion}-${randomUUID()}`);
  try {
    await mkdir(staging);
    const stagedSite = join(staging, "site");
    const captured = await scanSiteTree(source, buildVersion, {
      captureFiles: true,
      excludedRootNames: [".local"],
    });
    // The version was fixed from an earlier scan; a site that changed since must not be frozen under it.
    if (siteContentDigest(captured.manifest.entries) !== expectedSiteDigest) throw new Error("SNAPSHOT_PUBLISH_SITE_CHANGED");
    await mkdir(stagedSite);
    for (const entry of captured.manifest.entries) {
      if (entry.kind === "directory") await mkdir(join(stagedSite, ...entry.path.split("/")));
    }
    for (const file of captured.files) {
      await writeFile(join(stagedSite, ...file.path.split("/")), file.source, { flag: "wx" });
    }
    await mkdir(join(stagedSite, "data"), { recursive: true });
    await writeFile(join(stagedSite, "data", "knowledge.json"), await readFile(publicStaging));
    await validatePublishSite(root, stagedSite, buildVersion);
    const candidateManifest = await siteTreeManifest(stagedSite, buildVersion);
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(candidateManifest)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    if (await exists(versionRoot)) {
      const existingManifest = await readFrozenSiteManifest(frozenSite, buildVersion);
      if (!sameSiteManifest(existingManifest, candidateManifest)) {
        throw new Error("SNAPSHOT_PUBLISH_MANIFEST_MISMATCH");
      }
      return existingManifest;
    }
    await rename(staging, versionRoot);
    return await readFrozenSiteManifest(frozenSite, buildVersion);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function boundedFile(root, target, label, { optional = false, maxBytes = 16 * 1024 * 1024 } = {}) {
  await assertPlainPath(root, target);
  const before = await exists(target, EXACT);
  if (!before) {
    if (optional) return { name: label, state: "missing", sha256: "" };
    throw new Error("SNAPSHOT_INPUT_UNAVAILABLE");
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maxBytes)) throw new Error("SNAPSHOT_INPUT_INVALID");
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("SNAPSHOT_INPUT_PATH_INVALID");
  const realRoot = await realpath(root);
  const realTarget = await realpath(target);
  if (!inside(realRoot, realTarget)) throw new Error("SNAPSHOT_INPUT_PATH_INVALID");
  const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(target, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat(EXACT);
    if (!opened.isFile() || !sameFileIdentity(before, opened) || opened.size > BigInt(maxBytes)) {
      throw new Error("SNAPSHOT_INPUT_CHANGED");
    }
    const source = await handle.readFile();
    if (source.byteLength > maxBytes) throw new Error("SNAPSHOT_INPUT_INVALID");
    const openedAfter = await handle.stat(EXACT);
    const after = await lstat(target, EXACT);
    const realTargetAfter = await realpath(target);
    if (
      !after.isFile()
      || after.isSymbolicLink()
      || !sameFileIdentity(opened, openedAfter)
      || !sameFileIdentity(before, after)
      || realTargetAfter !== realTarget
      || !inside(realRoot, realTargetAfter)
    ) throw new Error("SNAPSHOT_INPUT_CHANGED");
    return { name: label, state: "file", sha256: sha256(source), source };
  } finally {
    await handle.close();
  }
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
    video: resolve(options.videoAnalysis),
    ...(options.resources ? { resources: resolve(options.resources) } : {}),
    ...(options.damagedReplies ? { damaged: resolve(options.damagedReplies) } : {}),
    ...(options.sourceCodes ? { sourceCodes: resolve(options.sourceCodes) } : {}),
  };
  for (const target of Object.values(fixed)) await assertPlainPath(root, target);
  // Every read is awaited to the end before a failure is reported. Promise.all would report the first
  // failure at once and leave the other reads running with their files open, and on Windows an open
  // file keeps its folder from being removed.
  const settled = await Promise.allSettled([
    boundedFile(root, fixed.catalog, "catalog"),
    boundedFile(root, fixed.config, "config"),
    boundedFile(root, fixed.curation, "formal-curation"),
    boundedFile(root, fixed.bundle, "curation-bundle"),
    boundedFile(root, fixed.profile, "profile"),
    ...(fixed.resources ? [boundedFile(root, fixed.resources, "resources")] : []),
    // The frozen list of saved replies that lost text when they were captured; the card step reads it.
    ...(fixed.damaged ? [boundedFile(root, fixed.damaged, "damaged-replies", { optional: true, maxBytes: 1024 * 1024 })] : []),
    // The private store of post access codes: a card links to its post only through a code held here, so the
    // store is part of the build's identity. A store that is not there leaves every card on its search link.
    ...(fixed.sourceCodes ? [boundedFile(root, fixed.sourceCodes, "source-codes", { optional: true, maxBytes: 4 * 1024 * 1024 })] : []),
  ]);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  const core = settled.map((result) => result.value);
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
  // The review audit is read for one fact only: which posts can no longer be opened (the source-line label).
  if (typeof quality.audit_file === "string" && quality.audit_file) {
    inputs.push(await boundedFile(root, resolve(root, quality.audit_file), "audit_file", { optional: true }));
  }
  const videoRoot = await exists(fixed.video);
  if (videoRoot && (!videoRoot.isDirectory() || videoRoot.isSymbolicLink())) throw new Error("SNAPSHOT_INPUT_INVALID");
  inputs.push({ name: "video-analysis-root", state: videoRoot ? "directory" : "missing", sha256: "" });
  for (const noteId of noteIds) {
    inputs.push(await boundedFile(root, join(fixed.diandian, `${noteId}.json`), `point:${noteId}`, { optional: true, maxBytes: 512 * 1024 }));
    if (/^[a-f0-9]{24}$/.test(noteId)) {
      const noteDirectory = join(fixed.video, noteId);
      inputs.push(await boundedFile(root, join(noteDirectory, "analysis.json"), `analysis:${noteId}`, { optional: true, maxBytes: 1024 * 1024 }));
      // The text taken out of the post's media is shown on the card, so it is part of the build.
      inputs.push(await boundedFile(root, join(noteDirectory, "transcription.json"), `transcript:${noteId}`, { optional: true, maxBytes: 4 * 1024 * 1024 }));
      inputs.push(await boundedFile(root, join(noteDirectory, "visual-ocr.json"), `picture-text:${noteId}`, { optional: true, maxBytes: 4 * 1024 * 1024 }));
      inputs.push(...await imageInventory(root, noteDirectory, noteId));
    }
  }
  // Saved replies and no list of the cut ones: every cut reply would be published as complete. An empty
  // list is fine only when there is no saved reply at all.
  const hasDamagedList = core.some((entry) => entry.name === "damaged-replies" && entry.state === "file");
  if (!hasDamagedList && inputs.some((entry) => entry.name.startsWith("point:") && entry.state === "file")) {
    throw new Error("DAMAGED_REPLY_LIST_MISSING");
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
    video: join(inputRoot, "video-analysis"),
    candidates: join(inputRoot, "sealed-candidates.json"),
    audit: join(inputRoot, "curation-audit.json"),
    damaged: join(inputRoot, "damaged-replies.json"),
    sourceCodes: join(inputRoot, "source-codes.json"),
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
  const hasSourceCodes = await writeEntry("source-codes", paths.sourceCodes);
  // Always a frozen list, so the build never falls back to a live file: the captured one, else an empty one
  // (capture has already refused a missing list when there are saved replies).
  if (!await writeEntry("damaged-replies", paths.damaged)) {
    await writeFile(paths.damaged, `${JSON.stringify({ schema_version: 1, entries: [] })}\n`, { encoding: "utf8", flag: "wx" });
  }
  await mkdir(paths.diandian, { recursive: true });
  for (const [name, entry] of entries) {
    if (name.startsWith("point:") && entry.state === "file") await writeEntry(name, join(paths.diandian, `${name.slice(6)}.json`));
  }
  if (entries.get("video-analysis-root")?.state === "directory") await mkdir(paths.video, { recursive: true });
  for (const [name, entry] of entries) {
    if (name.startsWith("analysis:") && entry.state === "file") {
      await writeEntry(name, join(paths.video, name.slice(9), "analysis.json"));
    } else if (name.startsWith("transcript:") && entry.state === "file") {
      await writeEntry(name, join(paths.video, name.slice(11), "transcription.json"));
    } else if (name.startsWith("picture-text:") && entry.state === "file") {
      await writeEntry(name, join(paths.video, name.slice(13), "visual-ocr.json"));
    } else if (name.startsWith("image:") && entry.state === "present") {
      const [, noteId, ...relativeName] = name.split(":");
      const target = join(paths.video, noteId, ...relativeName.join(":").split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, "", { flag: "wx" });
    }
  }
  const config = structuredClone(captured.config);
  if (config?.curation_quality && typeof config.curation_quality === "object") {
    delete config.curation_quality.baseline_file;
    if (typeof config.curation_quality.audit_file === "string" && config.curation_quality.audit_file) {
      config.curation_quality.audit_file = paths.audit;
      await writeEntry("audit_file", paths.audit);
    }
  }
  await writeFile(paths.config, `${JSON.stringify(config)}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(paths.curation, `${JSON.stringify(effectiveCurationValue)}\n`, { encoding: "utf8", flag: "wx" });
  await writeFile(paths.candidates, `${JSON.stringify(unacceptedCandidates(JSON.parse(captured.bundleSource.toString("utf8"))))}\n`, { encoding: "utf8", flag: "wx" });
  return {
    ...paths,
    ...(hasResources ? {} : { resources: "" }),
    ...(hasSourceCodes ? {} : { sourceCodes: undefined }),
  };
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
  const required = ["root", "public-target", "catalog", "config", "curation", "curation-bundle", "profile", "sealed-scope-digest", "diandian-dir", "video-analysis", "effective-date"];
  const optional = ["resources", "damaged-replies", "source-codes"];
  if (
    Object.keys(result).some((key) => ![...required, ...optional].includes(key))
    || required.some((key) => !result[key])
  ) throw new Error("SNAPSHOT_ARGUMENT_INVALID");
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
    videoAnalysis: options["video-analysis"],
    ...(options["damaged-replies"] ? { damagedReplies: options["damaged-replies"] } : {}),
    ...(options["source-codes"] ? { sourceCodes: options["source-codes"] } : {}),
    ...(options.resources ? { resources: options.resources } : {}),
  };
  let frozen = null;
  try {
    const result = await buildOrganizationSnapshot({
      root, publicTarget: resolve(options["public-target"]),
      publishSite: join(root, "site"),
      effectiveDate,
      prepareSnapshot: async () => {
        // The list of cut replies is judged again from the catalog and reply folder as they are now, so it can
        // never be older than the replies it judges. A build that names no list keeps the old refusal.
        if (captureOptions.damagedReplies) {
          await assertPlainPath(root, resolve(captureOptions.damagedReplies));
          writeDamagedReplies({ catalog: resolve(captureOptions.catalog), diandianDir: resolve(captureOptions.diandianDir), output: resolve(captureOptions.damagedReplies) });
        }
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
      buildPublicSite: async ({ target, buildVersion }) => {
        const shared = ["--catalog", frozen.catalog, "--config", frozen.config, "--curation", frozen.curation, "--profile", frozen.profile, "--effective-date", effectiveDate];
        runBuilder(join(scriptDir, "build-public-site.mjs"), ["--candidates", frozen.candidates, ...shared, "--output", target, "--build-version", buildVersion, "--diandian-dir", frozen.diandian, "--video-analysis", frozen.video, "--damaged-replies", frozen.damaged, ...(frozen.sourceCodes ? ["--source-codes", frozen.sourceCodes] : []), ...(frozen.resources ? ["--resources", frozen.resources] : [])]);
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
