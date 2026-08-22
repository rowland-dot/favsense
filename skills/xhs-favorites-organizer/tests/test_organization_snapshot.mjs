import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
  await assert.rejects(buildOrganizationSnapshot({ ...paths, sealedScopeDigest: "a".repeat(64), curationInputDigest: "b".repeat(64), configDigest: "c".repeat(64), buildKnowledgeBase: builder("kb", calls), buildPublicSite: builder("public", calls, true) }), /public_failed/);
  assert.deepEqual(calls, ["kb", "public"]);
  assert.equal(JSON.parse(await readFile(join(paths.kbTarget, "build.json"), "utf8")).build_version, "old");
  assert.equal(JSON.parse(await readFile(paths.publicTarget, "utf8")).meta.buildVersion, "old");
});

test("failure after the first swap rolls both participants back", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture(); const calls = [];
  await assert.rejects(buildOrganizationSnapshot({ ...paths, sealedScopeDigest: "a".repeat(64), curationInputDigest: "b".repeat(64), configDigest: "c".repeat(64), buildKnowledgeBase: builder("kb", calls), buildPublicSite: builder("public", calls), failAt: "swap:public" }), /FAULT_INJECTION/);
  assert.equal(JSON.parse(await readFile(join(paths.kbTarget, "build.json"), "utf8")).build_version, "old");
  assert.equal(JSON.parse(await readFile(paths.publicTarget, "utf8")).meta.buildVersion, "old");
});

test("one canonical version is embedded in both outputs", async () => {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  const paths = await fixture(); const calls = [];
  const result = await buildOrganizationSnapshot({ ...paths, sealedScopeDigest: "a".repeat(64), curationInputDigest: "b".repeat(64), configDigest: "c".repeat(64), buildKnowledgeBase: builder("kb", calls), buildPublicSite: builder("public", calls) });
  assert.match(result.build_version, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(await readFile(join(paths.kbTarget, "build.json"), "utf8")).build_version, result.build_version);
  assert.equal(JSON.parse(await readFile(paths.publicTarget, "utf8")).meta.buildVersion, result.build_version);
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
