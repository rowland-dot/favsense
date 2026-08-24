import { expectedResourceRevisions, stableResourceId } from "./resource-quality.mjs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]{1,300}$/;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_OFFICIAL_TEXT_BYTES = 1024 * 1024;
const DEFAULT_RESOURCE_DEADLINE_MS = 30_000;
const CLI_STAGE_DEADLINE_MS = 60_000;

async function boundedResponseText(response, maxBytes) {
  const declaredLength = response.headers?.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    throw new Error("RESOURCE_RESPONSE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("RESOURCE_RESPONSE_TOO_LARGE");
    return text;
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("RESOURCE_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

async function boundedFetchText(fetchImpl, url, timeoutMs, maxBytes, accept = "application/vnd.github+json") {
  const controller = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { method: "GET", redirect: "error", headers: { Accept: accept, "User-Agent": "FavSense-resource-verifier/1" }, signal: controller.signal });
        if (!response?.ok) throw new Error("RESOURCE_FETCH_FAILED");
        return boundedResponseText(response, maxBytes);
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("RESOURCE_FETCH_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedEvidenceList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null;
  if (!value.every((item) => typeof item === "string" && SAFE_PATH.test(item.trim()))) return null;
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function normalizedCompatibilityList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return null;
  if (!value.every((item) => typeof item === "string" && item.trim().length >= 2 && item.trim().length <= 80)) return null;
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function isSkillManifest(text) {
  const frontmatter = text.match(/^---\r?\n([\s\S]{1,8192}?)\r?\n---(?:\r?\n|$)/);
  return Boolean(frontmatter && /^name:\s*\S.+$/m.test(frontmatter[1]) && /^description:\s*\S.+$/m.test(frontmatter[1]));
}

function compatibilityStatement(text, compatibility) {
  const escaped = compatibility.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionsCompatibility = new RegExp(`\\b${escaped}\\b`, "i");
  const negative = /\b(?:not|no|never|without|unsupported|incompatible|excludes?|except|doesn't|doesn’t|does\s+not|isn't|isn’t|cannot|can't|can’t|won't|won’t)\b/i;
  let supported = false;
  for (const line of text.split(/\r?\n/)) {
    if (!mentionsCompatibility.test(line)) continue;
    if (negative.test(line)) return "negative";
    const declaration = line.match(/^\s*compatibility\s*:\s*(.+?)\s*$/i);
    if (!declaration) continue;
    const raw = declaration[1].replace(/^\[(.*)\]$/, "$1");
    const values = raw.split(",").map((item) => item.trim().replace(/^(["'])(.*)\1$/, "$2"));
    if (
      values.length < 1
      || values.some((item) => !/^[A-Za-z0-9][A-Za-z0-9+._ -]{0,79}$/.test(item))
      || !values.some((item) => item.toLocaleLowerCase("en-US") === compatibility.toLocaleLowerCase("en-US"))
    ) return "negative";
    supported = true;
  }
  return supported ? "positive" : "absent";
}

export async function verifyGitHubResource(candidate, {
  fetch: fetchImpl,
  today,
  timeoutMs = 10_000,
  deadlineAt = Date.now() + DEFAULT_RESOURCE_DEADLINE_MS,
} = {}) {
  if (
    typeof fetchImpl !== "function"
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(today || ""))
    || !Number.isFinite(timeoutMs)
    || timeoutMs <= 0
    || !Number.isFinite(deadlineAt)
  ) throw new Error("RESOURCE_VERIFIER_INPUT_INVALID");
  const fetchOfficialText = (url, maxBytes, accept) => {
    const remainingMs = Math.min(timeoutMs, deadlineAt - Date.now());
    if (remainingMs <= 0) throw new Error("RESOURCE_STAGE_TIMEOUT");
    return boundedFetchText(fetchImpl, url, remainingMs, maxBytes, accept);
  };
  const canonical = String(candidate?.canonical_repo || "").trim();
  const manifest = String(candidate?.manifest_path || candidate?.skill_manifest || "").trim();
  if (!REPO.test(canonical) || !SAFE_PATH.test(manifest) || !/(?:^|\/)SKILL\.md$/.test(manifest)) throw new Error("RESOURCE_IDENTITY_INVALID");
  const compatibility = normalizedCompatibilityList(candidate.compatibility);
  const requestedCompatibilityEvidence = normalizedEvidenceList(candidate.compatibility_evidence);
  if (!compatibility || !requestedCompatibilityEvidence) throw new Error("RESOURCE_COMPATIBILITY_EVIDENCE_MISSING");
  const base = `https://api.github.com/repos/${canonical}`;
  let repository;
  try {
    repository = JSON.parse(await fetchOfficialText(base, MAX_METADATA_BYTES));
  } catch (error) {
    if (String(error?.message || "").startsWith("RESOURCE_")) throw error;
    throw new Error("RESOURCE_REPOSITORY_METADATA_INVALID");
  }
  const defaultBranch = String(repository.default_branch || "");
  if (
    repository.full_name !== canonical
    || !/^[A-Za-z0-9_.\/-]{1,200}$/.test(defaultBranch)
    || defaultBranch.split("/").some((segment) => segment === "." || segment === "..")
  ) throw new Error("RESOURCE_REPOSITORY_MISMATCH");
  const officialName = String(repository.name || "").trim();
  if (
    !/^[A-Za-z0-9_.-]{1,100}$/.test(officialName)
    || officialName !== canonical.slice(canonical.indexOf("/") + 1)
    || !Number.isSafeInteger(repository.stargazers_count)
    || repository.stargazers_count < 0
  ) throw new Error("RESOURCE_REPOSITORY_METADATA_INVALID");
  const officialTexts = new Map();
  for (const evidencePath of new Set([manifest, ...requestedCompatibilityEvidence])) {
    officialTexts.set(
      evidencePath,
      await fetchOfficialText(
        `${base}/contents/${evidencePath}?ref=${encodeURIComponent(defaultBranch)}`,
        MAX_OFFICIAL_TEXT_BYTES,
        "application/vnd.github.raw+json",
      ),
    );
  }
  const manifestText = officialTexts.get(manifest);
  if (!isSkillManifest(manifestText)) throw new Error("RESOURCE_MANIFEST_INVALID");
  const confirmedEvidence = new Set();
  for (const item of compatibility) {
    let supported = false;
    for (const [evidencePath, text] of officialTexts) {
      const statement = compatibilityStatement(text, item);
      if (statement === "negative") throw new Error("RESOURCE_COMPATIBILITY_CONFLICT");
      if (statement === "positive") {
        supported = true;
        confirmedEvidence.add(evidencePath);
      }
    }
    if (!supported) throw new Error("RESOURCE_COMPATIBILITY_UNCONFIRMED");
  }
  const compatibilityEvidence = [...confirmedEvidence].sort();
  const identity = {
    canonical_repo: canonical,
    default_branch: repository.default_branch,
    license: String(repository.license?.spdx_id || "").trim(),
    skill_manifest: manifest,
    compatibility,
    compatibility_evidence: compatibilityEvidence,
  };
  if (!identity.license) throw new Error("RESOURCE_LICENSE_MISSING");
  const resource = {
    id: stableResourceId(canonical),
    name: officialName,
    type: "Agent Skill",
    canonical_repo: canonical,
    repo: `https://github.com/${canonical}`,
    download: `https://github.com/${canonical}/archive/refs/heads/${defaultBranch}.zip`,
    license: identity.license,
    skill_manifest: manifest,
    verified_at: today,
    stars_numeric: repository.stargazers_count,
    compatibility,
    compatibility_evidence: compatibilityEvidence,
    status: "verified",
  };
  const revisions = expectedResourceRevisions(resource);
  if (!revisions) throw new Error("RESOURCE_REVISION_INVALID");
  return { ...resource, ...revisions };
}

async function runCli() {
  const argv = process.argv.slice(2); const input = argv.indexOf("--input"); const output = argv.indexOf("--output"); const todayIndex = argv.indexOf("--today");
  if (argv.length !== 6 || input < 0 || output < 0 || todayIndex < 0) throw new Error("RESOURCE_VERIFIER_ARGUMENT_INVALID");
  const inputPath = resolve(argv[input + 1]); const outputPath = resolve(argv[output + 1]); const today = argv[todayIndex + 1];
  const candidates = JSON.parse(await readFile(inputPath, "utf8"));
  if (!Array.isArray(candidates) || candidates.length > 100) throw new Error("RESOURCE_CANDIDATES_INVALID");
  const resources = [];
  const deadlineAt = Date.now() + CLI_STAGE_DEADLINE_MS;
  for (const candidate of candidates) resources.push(await verifyGitHubResource(candidate, { fetch: globalThis.fetch, today, deadlineAt }));
  const temporary = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ schema_version: 1, verified_at: today, resources }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, outputPath);
  process.stdout.write(`${JSON.stringify({ ok: true, verified: resources.length })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) runCli().catch((error) => { process.stderr.write(`resource-verifier: ${String(error.message || "failed").replace(/[\r\n]+/g, " ")}\n`); process.exitCode = 1; });
