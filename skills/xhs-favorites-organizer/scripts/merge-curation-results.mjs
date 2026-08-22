import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { containsCredentialShape } from "./sensitive-data.mjs";
import { curationRevision } from "./curation-revision.mjs";
import { auditCuration } from "./validate-curation.mjs";

const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ALLOWED_STATUS = new Set(["accepted", "pending", "rejected"]);

function clean(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function readJson(filename, label) {
  try { return JSON.parse(fs.readFileSync(path.resolve(filename), "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { throw new Error(`${label} could not be read: ${error.message}`); }
}
function atomicJson(filename, value) {
  const target = path.resolve(filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8"); fs.renameSync(temporary, target); }
  finally { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); }
}
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key || "end"}`);
    result[key.slice(2)] = value;
  }
  for (const required of ["catalog", "config", "scope", "review", "candidates", "resources", "audit", "curation"]) {
    if (!result[required]) throw new Error(`--${required} is required`);
  }
  return result;
}

function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("candidate must be an object");
  if (clean(candidate.title).length < 2) throw new Error("candidate title is too short");
  if (clean(candidate.summary).length < 32) throw new Error("candidate summary is too short");
  if (clean(candidate.action).length < 16) throw new Error("candidate action is too short");
  if (!clean(candidate.kind)) throw new Error("candidate kind is required");
  if (!Array.isArray(candidate.themes) || candidate.themes.length === 0) throw new Error("candidate themes are required");
  if (!Array.isArray(candidate.tools)) throw new Error("candidate tools must be an array");
  if (containsCredentialShape(candidate)) throw new Error("candidate contains private source data");
  const category = clean(candidate.category);
  const categoryOverride = candidate.category_override === true;
  const categoryReason = clean(candidate.category_reason);
  if (categoryOverride && (!category || !categoryReason)) {
    throw new Error("category override requires a target category and reason");
  }
  return {
    title: clean(candidate.title),
    ...(category ? { category } : {}),
    summary: clean(candidate.summary),
    action: clean(candidate.action),
    themes: [...new Set(candidate.themes.map(clean).filter(Boolean))],
    tools: [...new Set(candidate.tools.map(clean).filter(Boolean))],
    kind: clean(candidate.kind),
    ...(categoryOverride ? {
      category_override: true,
      category_reason: categoryReason
    } : {})
  };
}

function validateAudit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("audit must be an object");
  const status = clean(value.status);
  if (!ALLOWED_STATUS.has(status)) throw new Error("audit status is invalid");
  const methods = Array.isArray(value.evidence_methods)
    ? [...new Set(value.evidence_methods.map(clean).filter(Boolean))]
    : [];
  const unresolved = Array.isArray(value.unresolved_facts)
    ? [...new Set(value.unresolved_facts.map(clean).filter(Boolean))]
    : [];
  const result = {
    status,
    reviewed_at: clean(value.reviewed_at),
    evidence_methods: methods,
    comments_checked: value.comments_checked === true,
    claims_supported: value.claims_supported === true,
    resource_status: clean(value.resource_status || "not_applicable"),
    unresolved_facts: unresolved
  };
  if (clean(value.reason)) result.reason = clean(value.reason);
  if (clean(value.diandian_summary_sha256)) result.diandian_summary_sha256 = clean(value.diandian_summary_sha256);
  if (status === "accepted" && unresolved.length) throw new Error("accepted audit cannot contain unresolved facts");
  if (status === "pending" && !result.reason && !unresolved.length) throw new Error("pending audit requires a reason or unresolved fact");
  if (containsCredentialShape(result)) throw new Error("audit contains private source data");
  return result;
}

export function mergeResults({ catalog, config, scope, review, candidates, resources, audit, curation, expectedCount = null }) {
  const items = Array.isArray(review?.items) ? review.items : null;
  if (!items) throw new Error("review.items must be an array");
  if (expectedCount !== null && items.length !== expectedCount) throw new Error(`review must contain exactly ${expectedCount} items`);
  const catalogIds = new Set(Object.keys(catalog.notes || catalog));
  const scopeIds = new Set(scope.note_ids || []);
  const seen = new Set();
  const nextCandidates = { ...(candidates || {}) };
  const nextAudit = { ...(audit || {}), notes: { ...(audit?.notes || {}) } };
  const nextCuration = { ...(curation || {}) };
  const counts = { accepted: 0, pending: 0, rejected: 0 };
  for (const item of items) {
    const noteId = clean(item?.note_id);
    if (!NOTE_ID.test(noteId) || !catalogIds.has(noteId) || !scopeIds.has(noteId)) throw new Error("review contains an unknown, invalid, or out-of-scope note ID");
    if (seen.has(noteId)) throw new Error("review contains a duplicate note ID");
    seen.add(noteId);
    const candidate = validateCandidate(item.candidate);
    const auditEntry = validateAudit(item.audit);
    if (auditEntry.status === "accepted") {
      auditEntry.curation_sha256 = curationRevision(candidate);
      const quality = auditCuration({
        catalog: { notes: { [noteId]: (catalog.notes || catalog)[noteId] } },
        config,
        curation: { [noteId]: candidate },
        resources,
        audit: { notes: { [noteId]: auditEntry } },
        scopeIds: [noteId]
      });
      if (quality.fatal.length) {
        throw new Error(`accepted audit failed quality validation: ${quality.fatal.join("; ")}`);
      }
    }
    nextCandidates[noteId] = candidate;
    nextAudit.notes[noteId] = auditEntry;
    if (auditEntry.status === "accepted") nextCuration[noteId] = candidate;
    else delete nextCuration[noteId];
    counts[auditEntry.status] += 1;
  }
  return { candidates: nextCandidates, audit: nextAudit, curation: nextCuration, counts };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const merged = mergeResults({
    catalog: readJson(options.catalog, "catalog"),
    config: readJson(options.config, "config"),
    scope: readJson(options.scope, "scope"),
    review: readJson(options.review, "review"),
    candidates: readJson(options.candidates, "candidates"),
    resources: readJson(options.resources, "resources"),
    audit: readJson(options.audit, "audit"),
    curation: readJson(options.curation, "curation"),
    expectedCount: options["expected-count"] === undefined ? null : Number(options["expected-count"])
  });
  atomicJson(options.candidates, merged.candidates);
  atomicJson(options.audit, merged.audit);
  atomicJson(options.curation, merged.curation);
  process.stdout.write(`${JSON.stringify({ ok: true, ...merged.counts })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
