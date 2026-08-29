#!/usr/bin/env node

import { cp, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  readFrozenSiteManifest,
  siteTreeManifest,
} from "./build-organization-snapshot.mjs";
import { validatePublicTree } from "./public-tree-policy.mjs";

function readOption(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
  return value;
}

function runGit(args, cwd, allowed = [0]) {
  const result = spawnSync("git", ["-c", "credential.interactive=false", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "0",
      GCM_GUI_PROMPT: "0",
    },
  });
  if (!allowed.includes(result.status ?? -1)) {
    const detail = (result.error?.message || result.stderr || result.stdout || "git command failed").trim();
    throw new Error(detail.slice(0, 1500));
  }
  return result;
}

function validateRepository(value) {
  const huggingFace = /^https:\/\/huggingface\.co\/spaces\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?$/;
  const localTest = process.env.FAVSENSE_ALLOW_LOCAL_PUBLISH === "1" && path.isAbsolute(value);
  if (!huggingFace.test(value) && !localTest) {
    throw new Error("--repository must be an HTTPS Hugging Face Space repository URL");
  }
}

function profileIdentifier(profileUrl) {
  if (typeof profileUrl !== "string" || !profileUrl.trim()) return "";
  try {
    const url = new URL(profileUrl);
    if (!/^(?:www\.)?xiaohongshu\.com$/i.test(url.hostname)) return "";
    const match = url.pathname.match(/^\/user\/profile\/([^/]+)\/?$/i);
    if (!match) return "";
    try {
      return decodeURIComponent(match[1]).trim();
    } catch {
      return match[1].trim();
    }
  } catch {
    return "";
  }
}

function privateIdentifiersFromConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const identifiers = [
    config.legacy_source_board_id,
    profileIdentifier(config.profile_url),
    ...(Array.isArray(config.boards) ? config.boards.map((board) => board?.id) : []),
  ]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  return [...new Set(identifiers)];
}

async function loadPrivateIdentifiers(configPath) {
  let source;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error("private publisher config could not be read");
  }

  try {
    return privateIdentifiersFromConfig(JSON.parse(source));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("private publisher config must contain valid JSON");
    }
    throw error;
  }
}

async function ensureMiniHeader(readmePath) {
  const readme = await readFile(readmePath, "utf8");
  const frontMatter = readme.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!frontMatter) throw new Error("Space README.md must begin with YAML front matter");

  const lineEnding = frontMatter[1].includes("\r\n") ? "\r\n" : "\n";
  const lines = frontMatter[2].split(/\r?\n/);
  const setScalar = (key, value) => {
    const indexes = lines.reduce((matches, line, index) => {
      if (new RegExp(`^${key}\\s*:`).test(line)) matches.push(index);
      return matches;
    }, []);
    if (indexes.length === 0) lines.push(`${key}: ${value}`);
    else {
      lines[indexes[0]] = `${key}: ${value}`;
      for (let index = indexes.length - 1; index > 0; index -= 1) lines.splice(indexes[index], 1);
    }
  };

  setScalar("header", "mini");
  setScalar("hf_oauth", "true");
  const scopesIndex = lines.findIndex((line) => /^hf_oauth_scopes\s*:/.test(line));
  if (scopesIndex !== -1) {
    let end = scopesIndex + 1;
    while (end < lines.length && (/^\s+/.test(lines[end]) || lines[end].trim() === "")) end += 1;
    lines.splice(scopesIndex, end - scopesIndex);
  }
  lines.push("hf_oauth_scopes:", "  - contribute-repos");

  const updatedFrontMatter = `${frontMatter[1]}${lines.join(lineEnding)}${frontMatter[3]}`;
  const updated = `${updatedFrontMatter}${readme.slice(frontMatter[0].length)}`;
  if (updated !== readme) await writeFile(readmePath, updated, "utf8");
}

async function main() {
  const workspace = path.resolve(readOption("workspace", process.cwd()));
  const siteRootOption = readOption("site-root", "");
  const buildVersion = readOption("build-version", "");
  const siteManifestSha256 = readOption("site-manifest-sha256", "");
  const configOption = readOption("config", path.join("config", "xhs-favorites.json"));
  const configPath = path.isAbsolute(configOption)
    ? configOption
    : path.resolve(workspace, configOption);
  const repository = readOption("repository");
  const branch = readOption("branch", "main");
  if (!repository) throw new Error("--repository is required");
  validateRepository(repository);
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.includes("..")) {
    throw new Error("--branch contains unsupported characters");
  }
  if (new Set([siteRootOption, buildVersion, siteManifestSha256].map(Boolean)).size !== 1) {
    throw new Error("--site-root, --build-version and --site-manifest-sha256 must be provided together");
  }
  if (buildVersion && !/^[a-f0-9]{64}$/.test(buildVersion)) {
    throw new Error("--build-version must be a SHA-256 digest");
  }
  if (siteManifestSha256 && !/^[a-f0-9]{64}$/.test(siteManifestSha256)) {
    throw new Error("--site-manifest-sha256 must be a SHA-256 digest");
  }

  const publicSite = siteRootOption
    ? path.resolve(siteRootOption)
    : path.join(workspace, "site");
  const siteMetadata = await lstat(publicSite);
  if (!siteMetadata.isDirectory() || siteMetadata.isSymbolicLink()) {
    throw new Error("public site root must be a plain directory");
  }
  const indexMetadata = await lstat(path.join(publicSite, "index.html"));
  if (!indexMetadata.isFile()) throw new Error("site/index.html was not found");
  let frozenManifest = null;
  if (buildVersion) {
    let knowledge;
    try {
      knowledge = JSON.parse(
        await readFile(path.join(publicSite, "data", "knowledge.json"), "utf8")
      );
    } catch {
      throw new Error("frozen public snapshot knowledge data is invalid");
    }
    if (knowledge?.meta?.buildVersion !== buildVersion) {
      throw new Error("frozen public snapshot does not match --build-version");
    }
    try {
      frozenManifest = await readFrozenSiteManifest(publicSite, buildVersion);
    } catch {
      throw new Error("frozen public snapshot manifest does not match");
    }
    if (frozenManifest.tree_sha256 !== siteManifestSha256) {
      throw new Error("frozen public snapshot manifest does not match");
    }
  }
  const privateIdentifiers = await loadPrivateIdentifiers(configPath);
  await validatePublicTree(publicSite, { privateIdentifiers });

  const temporary = await mkdtemp(path.join(tmpdir(), "favsense-hf-publish-"));
  const checkout = path.join(temporary, "space");
  try {
    runGit(["clone", "--depth", "1", "--branch", branch, repository, checkout], workspace);
    await validatePublicTree(checkout, {
      privateIdentifiers,
      excludedRootNames: [".git"],
      allowedRootTextNames: [".editorconfig", ".gitattributes", ".gitignore", "LICENSE"],
    });
    const targetSite = path.join(checkout, "site");
    await rm(targetSite, { recursive: true, force: true });
    await cp(publicSite, targetSite, {
      recursive: true,
      filter(source) {
        return path.relative(publicSite, source).split(path.sep)[0].toLowerCase() !== ".local";
      },
    });
    if (frozenManifest) {
      const copiedManifest = await siteTreeManifest(targetSite, buildVersion);
      if (
        copiedManifest.tree_sha256 !== frozenManifest.tree_sha256
        || JSON.stringify(copiedManifest.entries) !== JSON.stringify(frozenManifest.entries)
      ) {
        throw new Error("frozen public snapshot changed while it was copied");
      }
    }
    await validatePublicTree(targetSite, { privateIdentifiers });
    await ensureMiniHeader(path.join(checkout, "README.md"));
    await validatePublicTree(checkout, {
      privateIdentifiers,
      excludedRootNames: [".git"],
      allowedRootTextNames: [".editorconfig", ".gitattributes", ".gitignore", "LICENSE"],
    });

    runGit(["add", "-A", "--", "site", "README.md"], checkout);
    const diff = runGit(["diff", "--cached", "--quiet"], checkout, [0, 1]);
    if (diff.status === 0) {
      process.stdout.write(`${JSON.stringify({
        ok: true,
        status: "unchanged",
        repository,
        branch,
        ...(buildVersion ? { build_version: buildVersion } : {}),
        ...(frozenManifest ? { site_manifest_sha256: frozenManifest.tree_sha256 } : {}),
      })}\n`);
      return;
    }

    runGit(["config", "user.name", "FavSense Publisher"], checkout);
    runGit(["config", "user.email", "favsense@users.noreply.huggingface.co"], checkout);
    const date = new Date().toISOString().slice(0, 10);
    runGit(["commit", "-m", `data: publish FavSense knowledge ${date}`], checkout);
    runGit(["push", "origin", `HEAD:${branch}`], checkout);
    const commit = runGit(["rev-parse", "HEAD"], checkout).stdout.trim();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      status: "published",
      repository,
      branch,
      commit,
      ...(buildVersion ? { build_version: buildVersion } : {}),
      ...(frozenManifest ? { site_manifest_sha256: frozenManifest.tree_sha256 } : {}),
    })}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`huggingface-publisher: ${error.message}\n`);
  process.exitCode = 1;
});
