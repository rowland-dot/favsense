import { resourceRevision, stableResourceId } from "./resource-quality.mjs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]{1,300}$/;

async function boundedFetch(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: "GET", redirect: "error", headers: { Accept: "application/vnd.github+json", "User-Agent": "FavSense-resource-verifier/1" }, signal: controller.signal });
    if (!response?.ok) throw new Error("RESOURCE_FETCH_FAILED");
    return response;
  } finally { clearTimeout(timeout); }
}

export async function verifyGitHubResource(candidate, { fetch: fetchImpl, today, timeoutMs = 10_000 } = {}) {
  if (typeof fetchImpl !== "function" || !/^\d{4}-\d{2}-\d{2}$/.test(String(today || ""))) throw new Error("RESOURCE_VERIFIER_INPUT_INVALID");
  const canonical = String(candidate?.canonical_repo || "").trim();
  const manifest = String(candidate?.manifest_path || candidate?.skill_manifest || "").trim();
  if (!REPO.test(canonical) || !SAFE_PATH.test(manifest)) throw new Error("RESOURCE_IDENTITY_INVALID");
  const compatibility = Array.isArray(candidate.compatibility) ? [...new Set(candidate.compatibility.map(String).map((item) => item.trim()).filter(Boolean))].sort() : [];
  const compatibilityEvidence = Array.isArray(candidate.compatibility_evidence) ? [...new Set(candidate.compatibility_evidence.map(String).map((item) => item.trim()).filter((item) => SAFE_PATH.test(item)))].sort() : [];
  if (!compatibility.length || !compatibilityEvidence.length) throw new Error("RESOURCE_COMPATIBILITY_EVIDENCE_MISSING");
  const base = `https://api.github.com/repos/${canonical}`;
  const repositoryResponse = await boundedFetch(fetchImpl, base, timeoutMs);
  const repository = await repositoryResponse.json();
  if (repository.full_name !== canonical || !/^[A-Za-z0-9_.\/-]{1,200}$/.test(String(repository.default_branch || ""))) throw new Error("RESOURCE_REPOSITORY_MISMATCH");
  const manifestResponse = await boundedFetch(fetchImpl, `${base}/contents/${manifest}?ref=${encodeURIComponent(repository.default_branch)}`, timeoutMs);
  const manifestText = await manifestResponse.text();
  if (!manifestText.trim() || manifestText.length > 1024 * 1024) throw new Error("RESOURCE_MANIFEST_MISSING");
  const identity = {
    canonical_repo: canonical,
    default_branch: repository.default_branch,
    license: String(repository.license?.spdx_id || "").trim(),
    skill_manifest: manifest,
    compatibility,
    compatibility_evidence: compatibilityEvidence,
  };
  if (!identity.license) throw new Error("RESOURCE_LICENSE_MISSING");
  const resourceIdentity = resourceRevision(identity);
  const snapshot = resourceRevision({ resource_identity_sha256: resourceIdentity, verified_at: today, stars_numeric: Number(repository.stargazers_count) || 0 });
  return {
    id: stableResourceId(canonical),
    name: String(candidate.name || canonical).trim(),
    type: "Agent Skill",
    canonical_repo: canonical,
    repo: `https://github.com/${canonical}`,
    download: `https://github.com/${canonical}/archive/refs/heads/${repository.default_branch}.zip`,
    license: identity.license,
    skill_manifest: manifest,
    verified_at: today,
    stars_numeric: Number(repository.stargazers_count) || 0,
    compatibility,
    compatibility_evidence: compatibilityEvidence,
    resource_identity_sha256: resourceIdentity,
    verification_snapshot_sha256: snapshot,
    status: "verified",
  };
}

async function runCli() {
  const argv = process.argv.slice(2); const input = argv.indexOf("--input"); const output = argv.indexOf("--output"); const todayIndex = argv.indexOf("--today");
  if (argv.length !== 6 || input < 0 || output < 0 || todayIndex < 0) throw new Error("RESOURCE_VERIFIER_ARGUMENT_INVALID");
  const inputPath = resolve(argv[input + 1]); const outputPath = resolve(argv[output + 1]); const today = argv[todayIndex + 1];
  const candidates = JSON.parse(await readFile(inputPath, "utf8"));
  if (!Array.isArray(candidates) || candidates.length > 100) throw new Error("RESOURCE_CANDIDATES_INVALID");
  const resources = [];
  for (const candidate of candidates) resources.push(await verifyGitHubResource(candidate, { fetch: globalThis.fetch, today }));
  const temporary = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ schema_version: 1, verified_at: today, resources }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, outputPath);
  process.stdout.write(`${JSON.stringify({ ok: true, verified: resources.length })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) runCli().catch((error) => { process.stderr.write(`resource-verifier: ${String(error.message || "failed").replace(/[\r\n]+/g, " ")}\n`); process.exitCode = 1; });
