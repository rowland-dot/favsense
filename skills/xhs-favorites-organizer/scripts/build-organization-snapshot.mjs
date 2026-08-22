#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { executeJournaledTransaction } from "./journaled-transaction.mjs";

const HASH = /^[a-f0-9]{64}$/;

function canonicalVersion({ sealedScopeDigest, curationInputDigest, configDigest }) {
  for (const value of [sealedScopeDigest, curationInputDigest, configDigest]) if (!HASH.test(value)) throw new Error("SNAPSHOT_DIGEST_INVALID");
  const preimage = { schema_version: 1, sealed_scope_sha256: sealedScopeDigest, curation_input_sha256: curationInputDigest, public_config_sha256: configDigest, builders: { knowledge_base: 1, public_site: 1 } };
  return createHash("sha256").update(JSON.stringify(preimage), "utf8").digest("hex");
}

async function exists(path) { try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }

async function validateStagedVersions(kbStaging, publicStaging, buildVersion) {
  const kb = JSON.parse(await readFile(join(kbStaging, "build.json"), "utf8"));
  const publicData = JSON.parse(await readFile(publicStaging, "utf8"));
  if (kb.build_version !== buildVersion || publicData?.meta?.buildVersion !== buildVersion) throw new Error("SNAPSHOT_BUILD_VERSION_MISMATCH");
}

export async function buildOrganizationSnapshot(options) {
  const root = resolve(options.root);
  const kbTarget = resolve(options.kbTarget);
  const publicTarget = resolve(options.publicTarget);
  const buildVersion = canonicalVersion(options);
  const transactionId = `snapshot-${buildVersion.slice(0, 16)}-${randomUUID().slice(0, 8)}`;
  const stagingRoot = join(root, `.organization-build-${transactionId}`);
  const kbStaging = join(stagingRoot, "knowledge-base");
  const publicStaging = join(stagingRoot, "knowledge.json");
  await mkdir(stagingRoot);
  try {
    await options.buildKnowledgeBase({ target: kbStaging, buildVersion });
    await options.buildPublicSite({ target: publicStaging, buildVersion });
    await validateStagedVersions(kbStaging, publicStaging, buildVersion);
    await executeJournaledTransaction({ root, id: transactionId, failAt: options.failAt, participants: [
      { name: "knowledge-base", target: kbTarget, staging: kbStaging },
      { name: "public", target: publicTarget, staging: publicStaging },
    ] });
    await rm(stagingRoot, { recursive: true, force: true });
    return { schema_version: 1, ok: true, outcome: "built", build_version: buildVersion, counts: options.counts || { notes: 0, categories: 0, resources: 0 } };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
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
  const required = ["root", "kb-target", "public-target", "catalog", "config", "curation", "profile", "sealed-scope-digest", "curation-input-digest", "config-digest"];
  if (Object.keys(result).some((key) => ![...required, "resources", "diandian-dir"].includes(key)) || required.some((key) => !result[key])) throw new Error("SNAPSHOT_ARGUMENT_INVALID");
  return result;
}

function runBuilder(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("SNAPSHOT_BUILDER_FAILED");
}

async function runCli() {
  const options = cliArgs(process.argv.slice(2));
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const shared = ["--catalog", resolve(options.catalog), "--config", resolve(options.config), "--curation", resolve(options.curation), "--profile", resolve(options.profile)];
  const result = await buildOrganizationSnapshot({
    root: resolve(options.root), kbTarget: resolve(options["kb-target"]), publicTarget: resolve(options["public-target"]),
    sealedScopeDigest: options["sealed-scope-digest"], curationInputDigest: options["curation-input-digest"], configDigest: options["config-digest"],
    buildKnowledgeBase: async ({ target, buildVersion }) => {
      runBuilder(join(scriptDir, "build-knowledge-base.mjs"), [...shared, "--output", target, ...(options["diandian-dir"] ? ["--diandian-dir", resolve(options["diandian-dir"])] : [])]);
      await writeFile(join(target, "build.json"), `${JSON.stringify({ schema_version: 1, build_version: buildVersion })}\n`, "utf8");
    },
    buildPublicSite: async ({ target, buildVersion }) => {
      runBuilder(join(scriptDir, "build-public-site.mjs"), [...shared, "--output", target, "--build-version", buildVersion, ...(options.resources ? ["--resources", resolve(options.resources)] : []), ...(options["diandian-dir"] ? ["--diandian-dir", resolve(options["diandian-dir"])] : [])]);
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runCli().catch((error) => { process.stderr.write(`organization-snapshot: ${String(error.message || "failed").replace(/[\r\n]+/g, " ")}\n`); process.exitCode = 1; });
}
