#!/usr/bin/env node

import { cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

async function validatePublicTree(directory, relative = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!relative && entry.name === ".local") continue;
    const entryPath = path.join(directory, entry.name);
    const entryRelative = path.join(relative, entry.name);
    const lowerName = entry.name.toLowerCase();
    if (
      entry.isFile() &&
      (lowerName === ".env" || lowerName.startsWith(".env.") ||
        ["credentials.json", "secrets.json", "id_rsa"].includes(lowerName) ||
        [".pem", ".p12", ".pfx", ".key"].some((extension) => lowerName.endsWith(extension)))
    ) {
      throw new Error(`secret-like public file is not allowed: ${entryRelative}`);
    }
    const metadata = await lstat(entryPath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`public site must not contain symbolic links: ${entryRelative}`);
    }
    if (entry.isDirectory()) await validatePublicTree(entryPath, entryRelative);
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
  const repository = readOption("repository");
  const branch = readOption("branch", "main");
  if (!repository) throw new Error("--repository is required");
  validateRepository(repository);
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.includes("..")) {
    throw new Error("--branch contains unsupported characters");
  }

  const publicSite = path.join(workspace, "site");
  const indexMetadata = await lstat(path.join(publicSite, "index.html"));
  if (!indexMetadata.isFile()) throw new Error("site/index.html was not found");
  await validatePublicTree(publicSite);

  const temporary = await mkdtemp(path.join(tmpdir(), "favsense-hf-publish-"));
  const checkout = path.join(temporary, "space");
  try {
    runGit(["clone", "--depth", "1", "--branch", branch, repository, checkout], workspace);
    const targetSite = path.join(checkout, "site");
    await rm(targetSite, { recursive: true, force: true });
    await cp(publicSite, targetSite, {
      recursive: true,
      filter(source) {
        return path.relative(publicSite, source).split(path.sep)[0] !== ".local";
      },
    });
    await ensureMiniHeader(path.join(checkout, "README.md"));

    runGit(["add", "-A", "--", "site", "README.md"], checkout);
    const diff = runGit(["diff", "--cached", "--quiet"], checkout, [0, 1]);
    if (diff.status === 0) {
      process.stdout.write(`${JSON.stringify({ ok: true, status: "unchanged", repository, branch })}\n`);
      return;
    }

    runGit(["config", "user.name", "FavSense Publisher"], checkout);
    runGit(["config", "user.email", "favsense@users.noreply.huggingface.co"], checkout);
    const date = new Date().toISOString().slice(0, 10);
    runGit(["commit", "-m", `data: publish FavSense knowledge ${date}`], checkout);
    runGit(["push", "origin", `HEAD:${branch}`], checkout);
    const commit = runGit(["rev-parse", "HEAD"], checkout).stdout.trim();
    process.stdout.write(`${JSON.stringify({ ok: true, status: "published", repository, branch, commit })}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`huggingface-publisher: ${error.message}\n`);
  process.exitCode = 1;
});
