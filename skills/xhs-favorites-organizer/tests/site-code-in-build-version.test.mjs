import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Issue 43: the published site's own code is part of the canonical build version, so a front-end-only
// change gets a new version and a new frozen folder instead of colliding with the old one.

const COMMON = {
  sealedScopeDigest: "a".repeat(64),
  curationInputDigest: "b".repeat(64),
  configDigest: "c".repeat(64),
  inputRevisionDigest: "d".repeat(64),
  effectiveDate: "2026-10-12",
};

const builder = (beforeWrite = async () => {}) => async ({ target, buildVersion }) => {
  await beforeWrite();
  await writeFile(target, JSON.stringify({ meta: { buildVersion } }));
};

async function siteFixture() {
  const root = await mkdtemp(join(tmpdir(), "favsense-site-version-"));
  const publishSite = join(root, "site");
  const publicTarget = join(publishSite, "data", "knowledge.json");
  await mkdir(join(publishSite, "data"), { recursive: true });
  await writeFile(join(publishSite, "index.html"), "<main>index</main>", "utf8");
  await writeFile(join(publishSite, "styles.css"), "body{font-size:16px}", "utf8");
  await writeFile(publicTarget, JSON.stringify({ meta: { buildVersion: "old" } }));
  const frozen = (version) => join(root, ".xhs-tools", "organization-snapshots", "publish", version, "site");
  const options = (extra = {}) => ({ root, publicTarget, publishSite, ...COMMON, buildPublicSite: builder(), ...extra });
  return { root, publishSite, publicTarget, frozen, options };
}

async function build(options) {
  const { buildOrganizationSnapshot } = await import("../scripts/build-organization-snapshot.mjs");
  return buildOrganizationSnapshot(options);
}

test("a front-end-only change with identical inputs builds under a new version and a new frozen folder", async () => {
  const site = await siteFixture();
  const first = await build(site.options());

  // The issue's own case: only the stylesheet changed, every pipeline input is the same.
  await writeFile(join(site.publishSite, "styles.css"), "body{font-size:18px}", "utf8");
  const second = await build(site.options());

  assert.match(second.build_version, /^[a-f0-9]{64}$/);
  assert.notEqual(second.build_version, first.build_version);
  assert.equal(await readFile(join(site.frozen(first.build_version), "styles.css"), "utf8"), "body{font-size:16px}");
  assert.equal(await readFile(join(site.frozen(second.build_version), "styles.css"), "utf8"), "body{font-size:18px}");
  assert.equal(
    JSON.parse(await readFile(site.publicTarget, "utf8")).meta.buildVersion,
    second.build_version,
  );
});

test("the web data file and the private .local folder do not move the version", async () => {
  const site = await siteFixture();
  const first = await build(site.options());

  // The first build rewrote the live web data, and a private folder appears: neither is site code.
  await writeFile(site.publicTarget, JSON.stringify({ meta: { buildVersion: "x".repeat(64) }, extra: "rewritten" }));
  await mkdir(join(site.publishSite, ".local"), { recursive: true });
  await writeFile(join(site.publishSite, ".local", "private.json"), "{\"secret\":1}");
  const second = await build(site.options());

  assert.equal(second.build_version, first.build_version);
  assert.equal(second.site_manifest_sha256, first.site_manifest_sha256);
});

test("an unchanged site and unchanged inputs give the same version on consecutive builds", async () => {
  const site = await siteFixture();
  const first = await build(site.options());
  const second = await build(site.options());
  assert.equal(second.build_version, first.build_version);
});

test("a site file changed after the version was fixed and before the freeze rejects the build", async () => {
  const site = await siteFixture();
  const before = await readFile(site.publicTarget, "utf8");
  await assert.rejects(
    build(site.options({
      buildPublicSite: builder(async () => {
        await writeFile(join(site.publishSite, "styles.css"), "body{font-size:99px}", "utf8");
      }),
    })),
    /SNAPSHOT_PUBLISH_SITE_CHANGED/,
  );
  assert.equal(await readFile(site.publicTarget, "utf8"), before);
});

test("a build with no publish site keeps its version", async () => {
  const { root, publicTarget } = await (async () => {
    const dir = await mkdtemp(join(tmpdir(), "favsense-no-site-version-"));
    const target = join(dir, "knowledge.json");
    await writeFile(target, JSON.stringify({ meta: { buildVersion: "old" } }));
    return { root: dir, publicTarget: target };
  })();
  const result = await build({ root, publicTarget, ...COMMON, buildPublicSite: builder() });
  // Literal for this exact case under builder version 10 (trailing hashtag runs stripped). It moves only when the builder
  // version or the shape of the version preimage moves, so a site-less build never changes by accident.
  assert.equal(result.build_version, "dac31a00ee4c5d3fbd17316cdbd2bfe592e7f3917938392b308916bb4d0482e9");
});
