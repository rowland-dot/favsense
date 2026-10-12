import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue 39: the web data is the only formal output. The snapshot step builds, checks and swaps it alone.

const DIGESTS = {
  sealedScopeDigest: "a".repeat(64),
  curationInputDigest: "b".repeat(64),
  configDigest: "c".repeat(64),
  inputRevisionDigest: "d".repeat(64),
  effectiveDate: "2026-08-25",
};

const webBuilder = (calls = []) => async ({ target, buildVersion }) => {
  calls.push("public");
  await writeFile(target, JSON.stringify({ meta: { buildVersion } }));
};

async function treeBytes(directory) {
  const found = {};
  async function visit(current, prefix) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        found[`${prefix}${entry.name}/`] = "";
        await visit(path, `${prefix}${entry.name}/`);
      } else {
        found[`${prefix}${entry.name}`] = (await readFile(path)).toString("base64");
      }
    }
  }
  await visit(directory, "");
  return found;
}

const snapshotModule = () => import("../scripts/build-organization-snapshot.mjs");

test("a build exchanges only the web data and leaves an existing knowledge-base folder byte for byte alone", async () => {
  const { buildOrganizationSnapshot } = await snapshotModule();
  const root = await mkdtemp(join(tmpdir(), "favsense-web-only-"));
  const publicTarget = join(root, "site", "data", "knowledge.json");
  const oldKnowledgeBase = join(root, "knowledge-base");
  await mkdir(join(oldKnowledgeBase, "02-知识卡片"), { recursive: true });
  await writeFile(join(oldKnowledgeBase, "build.json"), JSON.stringify({ build_version: "from-an-older-version" }));
  await writeFile(join(oldKnowledgeBase, "02-知识卡片", "one.md"), "an old card the owner may still read\n");
  await mkdir(join(root, "site", "data"), { recursive: true });
  await writeFile(publicTarget, JSON.stringify({ meta: { buildVersion: "old" } }));
  const before = await treeBytes(oldKnowledgeBase);
  const calls = [];

  const result = await buildOrganizationSnapshot({ root, publicTarget, ...DIGESTS, buildPublicSite: webBuilder(calls) });

  assert.deepEqual(calls, ["public"]);
  assert.match(result.build_version, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(await readFile(publicTarget, "utf8")).meta.buildVersion, result.build_version);
  assert.deepEqual(await treeBytes(oldKnowledgeBase), before);
  const left = (await readdir(join(root, ".xhs-tools", "organization-snapshots"))).filter((name) => name.startsWith(".organization-"));
  assert.deepEqual(left, []);
});

test("the build version is bound to the web builder alone, so it differs from the one the two-builder version produced", async () => {
  const { buildOrganizationSnapshot } = await snapshotModule();
  const root = await mkdtemp(join(tmpdir(), "favsense-web-only-version-"));
  const publicTarget = join(root, "knowledge.json");
  await writeFile(publicTarget, "{}");

  const result = await buildOrganizationSnapshot({ root, publicTarget, ...DIGESTS, buildPublicSite: webBuilder() });

  // The version the previous two-builder code produced for these exact digests and date, taken from that code.
  assert.notEqual(result.build_version, "654b00e9741a40eff0618311baddbc2552726b787e5e6f01a889438d87b3d25d");
});

async function leftBehindByTheOlderVersion() {
  const { executeJournaledTransaction } = await import("../scripts/journaled-transaction.mjs");
  const root = await mkdtemp(join(tmpdir(), "favsense-legacy-journal-"));
  const kbTarget = join(root, "knowledge-base");
  const publicTarget = join(root, "knowledge.json");
  await mkdir(kbTarget);
  await writeFile(join(kbTarget, "build.json"), JSON.stringify({ build_version: "old" }));
  await writeFile(publicTarget, JSON.stringify({ meta: { buildVersion: "old" } }));
  const storage = join(root, ".xhs-tools", "organization-snapshots");
  const staging = join(storage, `.organization-build-snapshot-${"1".repeat(32)}`);
  await mkdir(join(staging, "knowledge-base"), { recursive: true });
  await writeFile(join(staging, "knowledge-base", "build.json"), JSON.stringify({ build_version: "half-built" }));
  await writeFile(join(staging, "knowledge.json"), JSON.stringify({ meta: { buildVersion: "half-built" } }));
  // The older version crashed right after swapping the knowledge base in: its journal names both participants.
  await assert.rejects(executeJournaledTransaction({
    root,
    transactionRoot: storage,
    id: `snapshot-${"1".repeat(32)}`,
    failAt: "crash-after-swap:knowledge-base",
    participants: [
      { name: "knowledge-base", target: kbTarget, staging: join(staging, "knowledge-base") },
      { name: "public", target: publicTarget, staging: join(staging, "knowledge.json") },
    ],
  }), /SIMULATED_CRASH/);
  return { root, kbTarget, publicTarget, storage };
}

test("an unfinished two-participant snapshot left by the older version is rolled back, then the web-only build succeeds", async () => {
  const { buildOrganizationSnapshot } = await snapshotModule();
  const { root, kbTarget, publicTarget, storage } = await leftBehindByTheOlderVersion();
  assert.equal(JSON.parse(await readFile(join(kbTarget, "build.json"), "utf8")).build_version, "half-built");

  const result = await buildOrganizationSnapshot({ root, publicTarget, ...DIGESTS, buildPublicSite: webBuilder() });

  assert.equal(JSON.parse(await readFile(join(kbTarget, "build.json"), "utf8")).build_version, "old");
  assert.equal(JSON.parse(await readFile(publicTarget, "utf8")).meta.buildVersion, result.build_version);
  assert.deepEqual((await readdir(storage)).filter((name) => name.startsWith(".organization-")), []);
});

test("the older version's leftover journal is refused, and nothing is moved, when the build asks for a different web data target than it recorded", async () => {
  const { buildOrganizationSnapshot } = await snapshotModule();
  const { root, kbTarget, publicTarget } = await leftBehindByTheOlderVersion();
  const elsewhere = join(root, "elsewhere.json");
  await writeFile(elsewhere, JSON.stringify({ meta: { buildVersion: "old" } }));

  await assert.rejects(buildOrganizationSnapshot({ root, publicTarget: elsewhere, ...DIGESTS, buildPublicSite: webBuilder() }), /TRANSACTION_RECOVERY_PARTICIPANTS_INVALID/);

  assert.equal(JSON.parse(await readFile(join(kbTarget, "build.json"), "utf8")).build_version, "half-built");
  assert.equal(JSON.parse(await readFile(elsewhere, "utf8")).meta.buildVersion, "old");
});

test("a leftover two-participant journal whose knowledge-base path leaves the workspace is refused, not followed", async () => {
  const { buildOrganizationSnapshot } = await snapshotModule();
  const root = await mkdtemp(join(tmpdir(), "favsense-legacy-journal-escape-"));
  const publicTarget = join(root, "knowledge.json");
  await writeFile(publicTarget, JSON.stringify({ meta: { buildVersion: "old" } }));
  const id = `snapshot-${"2".repeat(32)}`;
  const transaction = join(root, ".xhs-tools", "organization-snapshots", `.organization-tx-${id}`);
  await mkdir(transaction, { recursive: true });
  const participants = [
    { name: "knowledge-base", target: "../outside-knowledge-base", had_live: false, swapped: false },
    { name: "public", target: "knowledge.json", had_live: true, swapped: false },
  ];
  const immutable = createHash("sha256")
    .update(JSON.stringify({ transaction_id: id, participants: participants.map(({ name, target, had_live }) => ({ name, target, had_live })) }))
    .digest("hex");
  await writeFile(join(transaction, "journal.json"), JSON.stringify({
    schema_version: 1, transaction_id: id, phase: "prepared", immutable_state_sha256: immutable, participants,
  }));

  await assert.rejects(buildOrganizationSnapshot({ root, publicTarget, ...DIGESTS, buildPublicSite: webBuilder() }), /TRANSACTION_TARGET_ESCAPE/);

  assert.equal(JSON.parse(await readFile(publicTarget, "utf8")).meta.buildVersion, "old");
});
