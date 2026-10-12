import { expectedResourceRevisions, stableResourceId } from "./resource-quality.mjs";
import { load } from "js-yaml";
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
  if (!frontmatter) return false;
  let fields;
  try {
    fields = load(frontmatter[1]);
  } catch {
    return false;
  }
  return ["name", "description"].every((key) => typeof fields?.[key] === "string" && fields[key].trim() !== "");
}

// Plain-English sentences that say a host is supported: the text after the cue, up to the end of the clause, must name the host.
const SUPPORT_CUES = [
  /\b(?:work|works|working)\s+with\b/gi,
  /\bsupport(?:s|ed\s+(?:by|in|on))\b/gi,
  /\bcan\s+be\s+loaded\s+by\b/gi,
  /\b(?:needs?|requires?)\s+an?\s+(?:[\w-]+\s+)?host\b/gi,
];

function statesSupport(sentence, mentionsHost, escapedHost) {
  for (const cue of SUPPORT_CUES) {
    for (const match of sentence.matchAll(cue)) {
      const clause = sentence.slice(match.index + match[0].length).split(/[;!?]|\sbut\s|\s[—–]\s/)[0];
      if (mentionsHost.test(clause)) return true;
    }
  }
  // Owner ruling 2026-10-13 (issue #57): Chinese support phrases count. Their negations (不支持, 暂不支持 ...) are
  // caught by deniesHost, which runs before this function.
  const chineseClause = "[^，。；！？]*?";
  if (new RegExp(`(?:支持|适用于|可用于)${chineseClause}\\b${escapedHost}\\b`).test(sentence)) return true;
  if (new RegExp(`\\b${escapedHost}\\b\\s*也能用`).test(sentence)) return true;
  // Owner ruling 2026-10-13: "a <host> skill" counts, and only that exact shape: article or 一个, the host, singular "skill", not negated.
  const hostSkill = sentence.match(new RegExp(`(\\b(?:not|never|isn['’]t)\\s+)?(?:\\ban?\\b|一个)\\s*${escapedHost}\\s+skill(?![\\w/-])`, "i"));
  if (hostSkill && !hostSkill[1]) return true;
  // Owner ruling 2026-10-13: after "works with any host that supports <standard> —" the list that follows names the hosts.
  const standardList = sentence.match(/\bworks?\s+with\s+any\s+(?:[\w-]+\s+)?host\s+that\s+supports?\b[^—–]*\s[—–]\s(.*)$/i);
  if (standardList && mentionsHost.test(standardList[1].split(/[;!?]|\sbut\s/)[0])) return true;
  return false;
}

// A negation is a denial only when it negates a support statement naming the host or directly qualifies the host name.
function deniesHost(sentence, escapedHost) {
  const negation = "(?:not|never|cannot|can['’]t|won['’]t|doesn['’]t|isn['’]t|aren['’]t|don['’]t)";
  const sameClause = "(?:(?!\\bbut\\b)[^,;()])*?";
  return [
    new RegExp(`\\b${negation}\\s+(?:[\\w'’-]+\\s+){0,2}?(?:support\\w*|compatible|work\\w*|run\\w*|load\\w*)\\b${sameClause}\\b${escapedHost}\\b`, "i"),
    new RegExp(`\\b${escapedHost}\\s+(?:is|are)\\s+(?:not|never)\\s+(?:\\w+\\s+)?(?:support\\w*|compatible)`, "i"),
    new RegExp(`\\b(?:not|never|no|without|except|excluding|excludes?)\\s+(?:(?:with|on|in|for|the)\\s+)?${escapedHost}\\b`, "i"),
    new RegExp(`\\b(?:incompatible|unsupported)\\b${sameClause}\\b${escapedHost}\\b`, "i"),
    // The Chinese denials that mirror the Chinese support phrases above.
    new RegExp(`(?:不|无法|未能?|没有)(?:支持|适用于|可用于|用于|兼容)[^，。；！？]*?\\b${escapedHost}\\b`),
    new RegExp(`\\b${escapedHost}\\b\\s*(?:暂|目前|尚|还)?(?:不|无法|没有)(?:支持|适用|可用|能用|兼容)`),
  ].some((pattern) => pattern.test(sentence));
}

function compatibilityStatement(text, compatibility) {
  const escaped = compatibility.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionsCompatibility = new RegExp(`\\b${escaped}\\b`, "i");
  const negative = /\b(?:not|no|never|without|unsupported|incompatible|excludes?|except|doesn't|doesn’t|does\s+not|isn't|isn’t|cannot|can't|can’t|won't|won’t)\b/i;
  let supported = false;
  for (const line of text.split(/\r?\n/)) {
    if (!mentionsCompatibility.test(line)) continue;
    const declaration = line.match(/^\s*compatibility\s*:\s*(.+?)\s*$/i);
    if (!declaration) {
      const prose = line.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*`]/g, "");
      for (const sentence of prose.split(/(?<=[.!?。])\s+/)) {
        if (!mentionsCompatibility.test(sentence)) continue;
        if (deniesHost(sentence, escaped)) return "negative";
        if (statesSupport(sentence, mentionsCompatibility, escaped)) supported = true;
      }
      continue;
    }
    if (negative.test(line)) return "negative";
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
  now = Date.now,
  timeoutMs = 10_000,
  deadlineAt = Date.now() + DEFAULT_RESOURCE_DEADLINE_MS,
} = {}) {
  if (
    typeof fetchImpl !== "function"
    || typeof now !== "function"
    || !Number.isFinite(now())
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(today || ""))
    || !Number.isFinite(timeoutMs)
    || timeoutMs <= 0
    || !Number.isFinite(deadlineAt)
  ) throw new Error("RESOURCE_VERIFIER_INPUT_INVALID");
  // The build judges freshness by the UTC calendar day (curation-standard.md), so a verification dated ahead of
  // UTC today (e.g. a Sydney-morning run passing its local date) would look like it comes from the future and read as stale.
  if (today > new Date(now()).toISOString().slice(0, 10)) throw new Error("RESOURCE_VERIFIER_DATE_AHEAD_OF_UTC");
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
