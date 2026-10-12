import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const HASH = /^[a-f0-9]{64}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9_.\/-]{1,200}$/;
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

// A non-Skill note has no resource to verify. The review step stores "verified" when it checked the
// note's tools and "missing" otherwise, and seals that value into the audited candidate revision.
// Sealing the same value again on rebuild is what lets an unchanged accepted note keep its audit.
export function nonSkillResourceAssessment(auditResourceStatus) {
  return {
    status: clean(auditResourceStatus) === "verified" ? "verified" : "missing",
    resource_id: "",
    reason_code: "resource_not_applicable",
    resource_identity_sha256: "",
    verification_snapshot_sha256: "",
    resource: null
  };
}

const MAX_AGE_KEY = "resource_index.verification_max_age_days";
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_PROFILE_PATH = "config/domain-profiles/software.json";

function configError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

// The one place that turns a domain profile into "how many days a resource check stays fresh".
// An absent key means the default; a present key that is not a non-negative whole number is a
// configuration mistake and is reported, never read as "everything is stale". `source` names the
// profile file in the message when the caller knows it.
export function verificationMaxAgeDays(profile, source = "domain profile") {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw configError("RESOURCE_PROFILE_REQUIRED", "a domain profile is required to decide how fresh a resource check must be");
  }
  const value = profile.resource_index?.verification_max_age_days;
  if (value === undefined) return DEFAULT_MAX_AGE_DAYS;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw configError("RESOURCE_MAX_AGE_INVALID", `${source}: ${MAX_AGE_KEY} must be a non-negative whole number`);
  }
  return value;
}

// The domain profile a collection config points at, read the way the builders read it: the path is
// relative to the workspace root and defaults to the software profile. A profile that cannot be read,
// or whose limit is broken, is reported here by its workspace-relative path, so the message names the
// file to fix without revealing where the workspace lives on this machine.
export function readDomainProfile(root, config) {
  const file = resolve(root, String(config?.domain_profile || DEFAULT_PROFILE_PATH));
  const name = relative(resolve(root), file).split(sep).join("/");
  let profile;
  try {
    const text = readFileSync(file, "utf8");
    profile = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  }
  catch { throw configError("DOMAIN_PROFILE_UNREADABLE", name); }
  verificationMaxAgeDays(profile, name);
  return profile;
}

// The limit is always resolved by the caller (see verificationMaxAgeDays); this function has no
// default of its own, so a call site that forgot to pass it fails loudly instead of judging stale.
export function resourceFreshness(resource, options) {
  const { today, maxAgeDays } = options ?? {};
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 0) {
    throw configError("RESOURCE_MAX_AGE_INVALID", `${MAX_AGE_KEY} was not resolved before the freshness check`);
  }
  const current = utcDay(today); const verified = utcDay(resource?.verified_at);
  if (current === null || verified === null || verified > current) return "stale";
  return current - verified <= maxAgeDays ? "fresh" : "stale";
}

function verifiedDownloadBranch(resource, canonical) {
  if (!REPO.test(canonical)) return null;
  const prefix = `https://github.com/${canonical}/archive/refs/heads/`;
  const download = clean(resource?.download);
  if (!download.startsWith(prefix) || !download.endsWith(".zip")) return null;
  const branch = download.slice(prefix.length, -4);
  if (!BRANCH.test(branch) || branch.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return branch;
}

function normalizedStringList(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const items = value.map(clean);
  return items.every(Boolean) ? items : null;
}

export function expectedResourceRevisions(resource) {
  const canonical = clean(resource?.canonical_repo);
  const name = clean(resource?.name);
  const type = clean(resource?.type);
  const defaultBranch = verifiedDownloadBranch(resource, canonical);
  const download = clean(resource?.download);
  const license = clean(resource?.license);
  const skillManifest = clean(resource?.skill_manifest);
  const compatibility = normalizedStringList(resource?.compatibility);
  const compatibilityEvidence = normalizedStringList(resource?.compatibility_evidence);
  if (
    !name || type !== "Agent Skill" || !defaultBranch || !license || !skillManifest || skillManifest.includes("..")
    || !compatibility || !compatibilityEvidence
    || !Number.isSafeInteger(resource?.stars_numeric) || resource.stars_numeric < 0
    || utcDay(resource?.verified_at) === null
  ) return null;
  const resourceIdentity = resourceRevision({
    canonical_repo: canonical,
    name,
    type,
    license,
    skill_manifest: skillManifest,
    compatibility,
    compatibility_evidence: compatibilityEvidence,
  });
  return {
    resource_identity_sha256: resourceIdentity,
    verification_snapshot_sha256: resourceRevision({
      resource_identity_sha256: resourceIdentity,
      default_branch: defaultBranch,
      download,
      stars_numeric: resource.stars_numeric,
      verified_at: clean(resource.verified_at),
    }),
  };
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
  if (verifiedDownloadBranch(resource, canonical) === null) errors.push("download_url_invalid");
  if (!clean(resource.license) || !clean(resource.skill_manifest) || clean(resource.skill_manifest).includes("..")) errors.push("official_evidence_incomplete");
  if (!normalizedStringList(resource.compatibility) || !normalizedStringList(resource.compatibility_evidence)) errors.push("compatibility_incomplete");
  if (!Number.isSafeInteger(resource.stars_numeric) || resource.stars_numeric < 0) errors.push("stars_invalid");
  if (resource.status !== "verified") errors.push("status_not_verified");
  const expectedRevisions = expectedResourceRevisions(resource);
  if (
    !HASH.test(clean(resource.resource_identity_sha256))
    || resource.resource_identity_sha256 !== expectedRevisions?.resource_identity_sha256
  ) errors.push("identity_revision_invalid");
  if (
    !HASH.test(clean(resource.verification_snapshot_sha256))
    || resource.verification_snapshot_sha256 !== expectedRevisions?.verification_snapshot_sha256
  ) errors.push("snapshot_revision_invalid");
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
