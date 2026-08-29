#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = "xhs-diandian-summarize-note";
const REGISTRY_RELATIVE = join(
  "local-knowledge-base",
  "data",
  "skill-registry",
  "xiaohongshu-skill-lineage.json",
);

function publicPath(value) {
  return value.split(sep).join("/");
}

function semverParts(value) {
  const match = String(value || "").match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error("release version must use semantic x.y.z format");
  return match.slice(1).map(Number);
}

function compareSemver(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function safeReleaseFile(value) {
  if (typeof value !== "string" || !value || isAbsolute(value)) return false;
  const normalized = publicPath(value);
  return normalized === value
    && !normalized.startsWith("/")
    && !normalized.split("/").some((part) => !part || part === "." || part === "..");
}

async function loadRelease(source) {
  let release;
  try {
    release = JSON.parse(await readFile(join(source, "release.json"), "utf8"));
  } catch (error) {
    throw new Error("source is missing a valid release.json", { cause: error });
  }
  if (!release || typeof release !== "object" || Array.isArray(release)) {
    throw new Error("release.json has an unsupported schema");
  }
  const [major, minor] = semverParts(release.version);
  if (major !== 1 || (minor !== 1 && minor !== 2)) {
    throw new Error("release.json does not describe a supported DianDian Skill release");
  }
  const cdpRelease = minor === 2;
  const expectedKeys = [
    "schema_version", "package", "version", "release_directory", "skill_directory",
    "runtime_contract", "saver", "saver_api", "files",
  ];
  if (cdpRelease) expectedKeys.push("cdp_transport");
  if (JSON.stringify(Object.keys(release).sort()) !== JSON.stringify(expectedKeys.sort())) {
    throw new Error("release.json has an unsupported schema");
  }
  if (
    release.schema_version !== 1
    || release.package !== PACKAGE
    || release.release_directory !== `${PACKAGE}-v${release.version}`
    || release.skill_directory !== PACKAGE
    || release.runtime_contract !== "runtime/browser-contract.json"
    || release.saver !== "scripts/save_diandian_summary.py"
    || release.saver_api !== 1
    || !Array.isArray(release.files)
    || release.files.length === 0
    || new Set(release.files).size !== release.files.length
    || !release.files.every(safeReleaseFile)
    || !release.files.includes("release.json")
    || !release.files.includes("SKILL.md")
    || !release.files.includes(release.runtime_contract)
    || !release.files.includes(release.saver)
    || (cdpRelease && (
      release.cdp_transport !== "scripts/cdp_transport.py"
      || !safeReleaseFile(release.cdp_transport)
      || !release.files.includes(release.cdp_transport)
    ))
  ) {
    throw new Error("release.json does not describe a supported DianDian Skill release");
  }
  return release;
}

async function listedFilesBelow(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
    if (entry.isSymbolicLink()) throw new Error(`Skill release must not contain symlinks: ${absolute}`);
    if (entry.isDirectory()) files.push(...await listedFilesBelow(root, absolute));
    else if (entry.isFile()) files.push(publicPath(relative(root, absolute)));
    else throw new Error(`Skill release contains an unsupported entry: ${absolute}`);
  }
  return files.sort();
}

async function validateSource(source, release) {
  const actualFiles = await listedFilesBelow(source);
  const expectedFiles = [...release.files].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("source files do not exactly match the positive release manifest");
  }
  const manifest = await readFile(join(source, "SKILL.md"), "utf8");
  if (!/^---[\s\S]*?^name:\s*xhs-diandian-summarize-note\s*$[\s\S]*?^---/m.test(manifest)) {
    throw new Error("source is not xhs-diandian-summarize-note");
  }
  for (const file of release.files) {
    const metadata = await lstat(join(source, file));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`release manifest entry is not a regular file: ${file}`);
    }
  }
}

async function assertSameRelease(source, destination, release) {
  const destinationFiles = await listedFilesBelow(destination);
  const expectedFiles = [...release.files].sort();
  if (JSON.stringify(destinationFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`versioned skill release already exists with different files: ${destination}`);
  }
  for (const file of release.files) {
    const [left, right] = await Promise.all([
      readFile(join(source, file)),
      readFile(join(destination, file)),
    ]);
    if (!left.equals(right)) {
      throw new Error(`versioned skill release already exists with different content: ${destination}`);
    }
  }
}

async function copyRelease(source, destination, release) {
  for (const file of release.files) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, file), target);
  }
}

async function recoverablePartialRelease(source, releaseRoot, release) {
  let files;
  try {
    files = await listedFilesBelow(releaseRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (files.length === 0) return true;
  for (const relativeFile of files) {
    const prefix = `${release.skill_directory}/`;
    if (!relativeFile.startsWith(prefix)) return false;
    const skillRelative = relativeFile.slice(prefix.length);
    if (!release.files.includes(skillRelative)) return false;
    const [expected, present] = await Promise.all([
      readFile(join(source, skillRelative)),
      readFile(join(releaseRoot, relativeFile)),
    ]);
    if (!expected.equals(present)) return false;
  }
  return true;
}

async function publishRelease(source, skillsRoot, release) {
  const releaseRoot = join(skillsRoot, release.release_directory);
  const skillPath = join(releaseRoot, release.skill_directory);
  let partialRelease = false;
  try {
    if ((await stat(skillPath)).isDirectory()) {
      try {
        await assertSameRelease(source, skillPath, release);
        return skillPath;
      } catch (error) {
        if (!await recoverablePartialRelease(source, releaseRoot, release)) throw error;
        partialRelease = true;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(skillsRoot, { recursive: true });
  const stagingRoot = await mkdtemp(join(skillsRoot, `.${release.release_directory}-stage-`));
  const stagingSkill = join(stagingRoot, release.skill_directory);
  try {
    await copyRelease(source, stagingSkill, release);
    await assertSameRelease(source, stagingSkill, release);
    if (!partialRelease) {
      await rename(stagingRoot, releaseRoot);
    } else {
      const backup = `${releaseRoot}.partial-${process.pid}-${Date.now()}`;
      await rename(releaseRoot, backup);
      try {
        await rename(stagingRoot, releaseRoot);
        await rm(backup, { recursive: true, force: true });
      } catch (replacementError) {
        await rm(releaseRoot, { recursive: true, force: true });
        await rename(backup, releaseRoot);
        throw replacementError;
      }
    }
    return skillPath;
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

function gitResult(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

function assertPrivateConfig(configPath) {
  const repository = gitResult(dirname(configPath), ["rev-parse", "--show-toplevel"]);
  if (repository.status !== 0) return;
  const root = repository.stdout.trim();
  const relativeConfig = publicPath(relative(root, configPath));
  const ignored = gitResult(root, ["check-ignore", "--quiet", "--", relativeConfig]);
  if (ignored.status !== 0) {
    throw new Error("refusing to write a private absolute Skill path into a tracked configuration file");
  }
}

async function atomicWrite(path, content) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function registryEntry(version, activePath, verifiedAt) {
  return {
    capability: "note_summary_with_diandian",
    package: PACKAGE,
    active_version: version,
    next_version: null,
    strategy: "publish_local_skill_and_configure_favsense_runtime",
    active_path: activePath,
    status: "active",
    source: "rowland-dot/favsense:skills/xhs-diandian-summarize-note",
    test_command: `python -B -m unittest discover -s ${activePath}/tests -v`,
    verified_at: verifiedAt,
  };
}

export async function syncDiandianSkill({
  source,
  knowledgeRoot,
  configPath,
  version,
  verifiedAt,
  writeAtomic = atomicWrite,
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(verifiedAt || ""))) {
    throw new Error("verifiedAt must use YYYY-MM-DD format");
  }
  const resolvedSource = resolve(source);
  const resolvedKnowledgeRoot = resolve(knowledgeRoot);
  const resolvedConfigPath = resolve(configPath);
  const release = await loadRelease(resolvedSource);
  if (version !== undefined && version !== release.version) {
    throw new Error("requested version does not match release.json");
  }
  await validateSource(resolvedSource, release);
  assertPrivateConfig(resolvedConfigPath);

  const registryPath = join(resolvedKnowledgeRoot, REGISTRY_RELATIVE);
  const [registryBytes, configBytes] = await Promise.all([
    readFile(registryPath),
    readFile(resolvedConfigPath),
  ]);
  const registry = JSON.parse(registryBytes.toString("utf8"));
  const config = JSON.parse(configBytes.toString("utf8"));
  if (!Array.isArray(registry.active_local_skills)) {
    throw new Error("skill lineage registry is missing active_local_skills");
  }
  if (!Array.isArray(registry.superseded_local_versions)) {
    registry.superseded_local_versions = [];
  }
  const activeIndex = registry.active_local_skills.findIndex((item) => item?.package === PACKAGE);
  const previous = activeIndex >= 0 ? registry.active_local_skills[activeIndex] : null;
  if (previous && compareSemver(release.version, previous.active_version) < 0) {
    throw new Error("refusing to activate an older DianDian Skill release");
  }

  const skillsRoot = join(resolvedKnowledgeRoot, "local-knowledge-base", "skills");
  const skillPath = await publishRelease(resolvedSource, skillsRoot, release);
  const activePath = publicPath(relative(resolvedKnowledgeRoot, skillPath));
  const nextEntry = registryEntry(release.version, activePath, verifiedAt);
  registry.superseded_local_versions = registry.superseded_local_versions.filter(
    (item) => !(item?.package === PACKAGE && item?.version === release.version),
  );
  if (previous && (previous.active_version !== release.version || previous.active_path !== activePath)) {
    const superseded = {
      capability: previous.capability,
      package: previous.package,
      version: previous.active_version,
      path: previous.active_path,
      status: "superseded",
    };
    if (!registry.superseded_local_versions.some(
      (item) => item?.package === superseded.package && item?.version === superseded.version
    )) registry.superseded_local_versions.push(superseded);
  }
  if (activeIndex >= 0) registry.active_local_skills[activeIndex] = nextEntry;
  else registry.active_local_skills.push(nextEntry);
  registry.updated_at = verifiedAt;

  if (!config.diandian || typeof config.diandian !== "object" || Array.isArray(config.diandian)) {
    config.diandian = { enabled: false };
  }
  config.diandian.skill_path = skillPath;
  const registryContent = `${JSON.stringify(registry, null, 2)}\n`;
  const configContent = `${JSON.stringify(config, null, 2)}\n`;
  try {
    await writeAtomic(registryPath, registryContent);
    await writeAtomic(resolvedConfigPath, configContent);
  } catch (error) {
    await atomicWrite(registryPath, registryBytes.toString("utf8"));
    await atomicWrite(resolvedConfigPath, configBytes.toString("utf8"));
    throw error;
  }
  return {
    skillPath,
    registryPath,
    configPath: resolvedConfigPath,
    version: release.version,
  };
}

function args(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("arguments must use --name value pairs");
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = args(process.argv.slice(2));
  const result = await syncDiandianSkill({
    source: options.source,
    knowledgeRoot: options["knowledge-root"],
    configPath: options.config,
    version: options.version,
    verifiedAt: options["verified-at"],
  });
  console.log(`DianDian Skill v${result.version} is active in the local knowledge base.`);
}
