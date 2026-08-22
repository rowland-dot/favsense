import { createHash } from "node:crypto";

const HASH = /^[a-f0-9]{64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const clean = (value) => String(value ?? "").normalize("NFC").trim();

function utcDay(value) {
  if (!DATE.test(clean(value))) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : Math.floor(date.getTime() / 86_400_000);
}

export function stableResourceId(canonicalRepo) {
  if (!REPO.test(clean(canonicalRepo))) throw new Error("RESOURCE_REPOSITORY_INVALID");
  return `github-${canonicalRepo.toLowerCase().replace("/", "-")}`;
}

export function resourceFreshness(resource, { today, maxAgeDays = 30 } = {}) {
  const current = utcDay(today); const verified = utcDay(resource?.verified_at);
  if (current === null || verified === null || verified > current || !Number.isSafeInteger(maxAgeDays) || maxAgeDays < 0) return "stale";
  return current - verified <= maxAgeDays ? "fresh" : "stale";
}

export function validateVerifiedResource(resource, options = {}) {
  const errors = [];
  if (!resource || typeof resource !== "object" || Array.isArray(resource)) return ["resource_invalid"];
  const canonical = clean(resource.canonical_repo);
  if (!REPO.test(canonical)) errors.push("canonical_repo_invalid");
  if (resource.id !== (REPO.test(canonical) ? stableResourceId(canonical) : "")) errors.push("resource_id_invalid");
  if (!clean(resource.name)) errors.push("name_missing");
  if (resource.type !== "Agent Skill") errors.push("type_not_agent_skill");
  if (resource.repo !== `https://github.com/${canonical}`) errors.push("repo_url_invalid");
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/archive\/refs\/heads\/[A-Za-z0-9_.\/-]+\.zip$/.test(clean(resource.download))) errors.push("download_url_invalid");
  if (!clean(resource.license) || !clean(resource.skill_manifest) || clean(resource.skill_manifest).includes("..")) errors.push("official_evidence_incomplete");
  if (!Array.isArray(resource.compatibility) || !resource.compatibility.length || !Array.isArray(resource.compatibility_evidence) || !resource.compatibility_evidence.length) errors.push("compatibility_incomplete");
  if (!Number.isSafeInteger(resource.stars_numeric) || resource.stars_numeric < 0) errors.push("stars_invalid");
  if (resource.status !== "verified") errors.push("status_not_verified");
  if (!HASH.test(clean(resource.resource_identity_sha256))) errors.push("identity_revision_invalid");
  if (!HASH.test(clean(resource.verification_snapshot_sha256))) errors.push("snapshot_revision_invalid");
  if (resourceFreshness(resource, options) !== "fresh") errors.push("resource_stale");
  return errors;
}

export function confirmedSkillResource(resources, options = {}) {
  if (!Array.isArray(resources)) return null;
  const valid = resources.filter((resource) => validateVerifiedResource(resource, options).length === 0);
  return valid.length === 1 ? valid[0] : null;
}

export function resourceRevision(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
