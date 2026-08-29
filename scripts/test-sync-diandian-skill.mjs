import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { syncDiandianSkill } from "./sync-diandian-skill.mjs";

const source = resolve("skills/xhs-diandian-summarize-note");
const version = "1.1.0";
const activePath = `local-knowledge-base/skills/xhs-diandian-summarize-note-v${version}/xhs-diandian-summarize-note`;

async function fixture({ activeVersion = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "favsense-diandian-skill-"));
  const knowledgeRoot = join(root, "knowledge");
  const configPath = join(root, "workspace", "config", "xhs-favorites.json");
  const registryPath = join(
    knowledgeRoot,
    "local-knowledge-base",
    "data",
    "skill-registry",
    "xiaohongshu-skill-lineage.json",
  );
  await mkdir(dirname(configPath), { recursive: true });
  await mkdir(dirname(registryPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ version: 1, diandian: { enabled: true } }, null, 2)}\n`, "utf8");
  const active = activeVersion ? [{
    capability: "note_summary_with_diandian",
    package: "xhs-diandian-summarize-note",
    active_version: activeVersion,
    active_path: `local-knowledge-base/skills/xhs-diandian-summarize-note-v${activeVersion}/xhs-diandian-summarize-note`,
    status: "active",
  }] : [];
  await writeFile(registryPath, `${JSON.stringify({
    schema_version: "1.0",
    updated_at: "2026-08-05",
    active_local_skills: active,
    superseded_local_versions: [],
  }, null, 2)}\n`, "utf8");
  return { root, knowledgeRoot, configPath, registryPath };
}

async function sync(target, overrides = {}) {
  return syncDiandianSkill({
    source,
    knowledgeRoot: target.knowledgeRoot,
    configPath: target.configPath,
    version,
    verifiedAt: "2026-08-13",
    ...overrides,
  });
}

async function testSkillSource(root, overrides = {}) {
  const releaseVersion = overrides.releaseVersion ?? "1.2.0";
  const skillSource = join(root, `source-v${releaseVersion}`);
  const cdpTransport = overrides.cdpTransport ?? "scripts/cdp_transport.py";
  const includeCdpFile = overrides.includeCdpFile ?? true;
  const includeCdpKey = overrides.includeCdpKey ?? true;
  const files = [
    "release.json",
    "SKILL.md",
    "runtime/browser-contract.json",
    "scripts/save_diandian_summary.py",
  ];
  if (includeCdpFile) files.push(cdpTransport);
  const release = {
    schema_version: 1,
    package: "xhs-diandian-summarize-note",
    version: releaseVersion,
    release_directory: `xhs-diandian-summarize-note-v${releaseVersion}`,
    skill_directory: "xhs-diandian-summarize-note",
    runtime_contract: "runtime/browser-contract.json",
    saver: "scripts/save_diandian_summary.py",
    saver_api: 1,
    files,
  };
  if (includeCdpKey) release.cdp_transport = cdpTransport;
  if (overrides.extraField) release.unexpected = true;

  await mkdir(join(skillSource, "runtime"), { recursive: true });
  await mkdir(join(skillSource, "scripts"), { recursive: true });
  await writeFile(
    join(skillSource, "SKILL.md"),
    "---\nname: xhs-diandian-summarize-note\ndescription: Test fixture only.\n---\n",
    "utf8",
  );
  await writeFile(join(skillSource, "runtime", "browser-contract.json"), "{}\n", "utf8");
  await writeFile(join(skillSource, "scripts", "save_diandian_summary.py"), "# fixture\n", "utf8");
  if (includeCdpFile && cdpTransport === "scripts/cdp_transport.py") {
    await writeFile(join(skillSource, "scripts", "cdp_transport.py"), "def ask(session, note_url, spec=None, tries=60, sleep=None):\n    return 'fixture'\n", "utf8");
  }
  await writeFile(join(skillSource, "release.json"), `${JSON.stringify(release, null, 2)}\n`, "utf8");
  return skillSource;
}

test("publishes the manifest-bound Skill, updates lineage and repoints private runtime config", async () => {
  const target = await fixture({ activeVersion: "1.0.0" });

  const result = await sync(target);

  const config = JSON.parse(await readFile(target.configPath, "utf8"));
  const registry = JSON.parse(await readFile(target.registryPath, "utf8"));
  assert.equal(result.version, version);
  assert.equal(config.diandian.skill_path, result.skillPath);
  assert.equal(registry.active_local_skills[0].active_version, version);
  assert.equal(registry.active_local_skills[0].active_path, activePath);
  assert.deepEqual(
    registry.superseded_local_versions.map((item) => item.version),
    ["1.0.0"],
  );
  assert.match(await readFile(join(result.skillPath, "SKILL.md"), "utf8"), /name: xhs-diandian-summarize-note/);
  assert.equal(
    JSON.parse(await readFile(join(result.skillPath, "runtime", "browser-contract.json"), "utf8")).prompt,
    "总结",
  );
});

test("publishes a temporary v1.2 release with its manifest-bound CDP transport atomically", async () => {
  const target = await fixture({ activeVersion: "1.1.0" });
  const v12 = await testSkillSource(target.root);

  const result = await sync(target, { source: v12, version: "1.2.0" });

  const release = JSON.parse(await readFile(join(result.skillPath, "release.json"), "utf8"));
  const registry = JSON.parse(await readFile(target.registryPath, "utf8"));
  const config = JSON.parse(await readFile(target.configPath, "utf8"));
  assert.equal(result.version, "1.2.0");
  assert.equal(release.cdp_transport, "scripts/cdp_transport.py");
  assert.equal(
    await readFile(join(result.skillPath, "scripts", "cdp_transport.py"), "utf8"),
    "def ask(session, note_url, spec=None, tries=60, sleep=None):\n    return 'fixture'\n",
  );
  assert.equal(registry.active_local_skills[0].active_version, "1.2.0");
  assert.equal(config.diandian.skill_path, result.skillPath);
});

test("v1.2 validation requires one safe manifest-listed CDP transport before pointer writes", async () => {
  for (const releaseOverrides of [
    { includeCdpKey: false },
    { includeCdpFile: false },
    { cdpTransport: "../cdp_transport.py" },
    { extraField: true },
  ]) {
    const target = await fixture({ activeVersion: "1.1.0" });
    const beforeRegistry = await readFile(target.registryPath, "utf8");
    const beforeConfig = await readFile(target.configPath, "utf8");
    const invalidSource = await testSkillSource(target.root, releaseOverrides);

    await assert.rejects(
      sync(target, { source: invalidSource, version: "1.2.0" }),
      /unsupported schema|supported DianDian Skill release/,
    );

    assert.equal(await readFile(target.registryPath, "utf8"), beforeRegistry);
    assert.equal(await readFile(target.configPath, "utf8"), beforeConfig);
  }
});

test("v1.1 keeps the exact legacy schema and rejects the v1.2-only transport field", async () => {
  const target = await fixture();
  const invalidSource = await testSkillSource(target.root, { releaseVersion: "1.1.0" });

  await assert.rejects(
    sync(target, { source: invalidSource, version: "1.1.0" }),
    /unsupported schema/,
  );
});

test("rejects unrecognized release families instead of guessing their schema", async () => {
  const target = await fixture();
  const futureSource = await testSkillSource(target.root, { releaseVersion: "1.3.0" });

  await assert.rejects(
    sync(target, { source: futureSource, version: "1.3.0" }),
    /supported DianDian Skill release/,
  );
});

test("same-version reruns are idempotent and do not supersede the active version", async () => {
  const target = await fixture();
  const first = await sync(target);
  const second = await sync(target);
  const registry = JSON.parse(await readFile(target.registryPath, "utf8"));

  assert.equal(first.skillPath, second.skillPath);
  assert.equal(registry.active_local_skills.length, 1);
  assert.deepEqual(registry.superseded_local_versions, []);
});

test("recovers an interrupted partial release only when every present byte matches the manifest", async () => {
  const target = await fixture();
  const partialSkill = join(
    target.knowledgeRoot,
    "local-knowledge-base",
    "skills",
    `xhs-diandian-summarize-note-v${version}`,
    "xhs-diandian-summarize-note",
  );
  await mkdir(partialSkill, { recursive: true });
  await cp(join(source, "SKILL.md"), join(partialSkill, "SKILL.md"));

  const result = await sync(target);

  assert.equal(
    JSON.parse(await readFile(join(result.skillPath, "release.json"), "utf8")).version,
    version,
  );
  assert.equal(
    JSON.parse(await readFile(join(result.skillPath, "runtime", "browser-contract.json"), "utf8")).schema_version,
    1,
  );
});

test("rejects caller version drift and registry downgrades", async () => {
  const target = await fixture({ activeVersion: "1.2.0" });

  await assert.rejects(sync(target, { version: "9.9.9" }), /does not match release\.json/);
  await assert.rejects(sync(target), /older DianDian Skill release/);
});

test("rolls registry and config back together when the second atomic pointer write fails", async () => {
  const target = await fixture({ activeVersion: "1.0.0" });
  const beforeRegistry = await readFile(target.registryPath, "utf8");
  const beforeConfig = await readFile(target.configPath, "utf8");
  let writes = 0;
  const failingWrite = async (path, content) => {
    writes += 1;
    if (writes === 2) throw new Error("injected config write failure");
    await writeFile(path, content, "utf8");
  };

  await assert.rejects(sync(target, { writeAtomic: failingWrite }), /injected config write failure/);

  assert.equal(await readFile(target.registryPath, "utf8"), beforeRegistry);
  assert.equal(await readFile(target.configPath, "utf8"), beforeConfig);
});

test("refuses to write an absolute Skill path into a tracked configuration", async () => {
  const target = await fixture();
  const repository = join(target.root, "tracked-workspace");
  const trackedConfig = join(repository, "config", "xhs-favorites.json");
  await mkdir(dirname(trackedConfig), { recursive: true });
  await writeFile(trackedConfig, "{\"version\":1}\n", "utf8");
  assert.equal(spawnSync("git", ["init", repository], { windowsHide: true }).status, 0);
  assert.equal(spawnSync("git", ["-C", repository, "add", "config/xhs-favorites.json"], { windowsHide: true }).status, 0);

  await assert.rejects(
    sync(target, { configPath: trackedConfig }),
    /tracked configuration file/,
  );
});
