#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCandidates } from "./generate-curation-candidates.mjs";
import { attachEvidenceToCandidates, normalizeEvidencePacket, sealCandidateRevision } from "./normalize-evidence.mjs";
import { executeJournaledTransaction } from "./journaled-transaction.mjs";
import { acceptedRevisionsCurrent } from "./curation-quality.mjs";
import { curationRevision } from "./curation-revision.mjs";
import { confirmedSkillResource } from "./resource-quality.mjs";

const clean = (value) => String(value ?? "").normalize("NFC").trim();

function registryAssessment(candidate, input) {
  if (candidate.kind !== "Skill") return { status: "missing", resource_id: "", reason_code: "resource_not_applicable", resource_identity_sha256: "", verification_snapshot_sha256: "", resource: null };
  const collection = clean(input.profile?.resource_index?.collection || "resources");
  const resources = Array.isArray(input.resources?.[collection]) ? input.resources[collection] : [];
  const aliases = new Set((candidate.tools || []).map((tool) => clean(tool).toLocaleLowerCase("zh-CN")));
  const matches = resources.filter((resource) => [resource?.name, ...(resource?.aliases || [])].some((alias) => aliases.has(clean(alias).toLocaleLowerCase("zh-CN"))));
  const verified = confirmedSkillResource(matches, { today: input.effective_date, maxAgeDays: input.profile?.resource_index?.verification_max_age_days });
  return verified
    ? { status: "verified", resource_id: verified.id, reason_code: "", resource_identity_sha256: verified.resource_identity_sha256, verification_snapshot_sha256: verified.verification_snapshot_sha256, resource: verified }
    : { status: "missing", resource_id: "", reason_code: "resource_ambiguous", resource_identity_sha256: "", verification_snapshot_sha256: "", resource: null };
}

function exactReviewSet(review, candidates) {
  if (!Array.isArray(review)) throw new Error("CURATION_REVIEW_INVALID");
  const expected = candidates.map((candidate) => candidate.id).sort();
  const actual = review.map((item) => clean(item?.id)).sort();
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || actual.join("\n") !== expected.join("\n")) throw new Error("CURATION_REVIEW_SCOPE_INVALID");
  for (const item of review) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !["accepted", "unavailable", "pending", "rejected"].includes(item.status)) throw new Error("CURATION_REVIEW_INVALID");
  }
  return review;
}

function exactAssessment(value) {
  const keys = ["reason_code", "resource", "resource_id", "resource_identity_sha256", "status", "verification_snapshot_sha256"];
  if (
    !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== keys.join(",")
    || !["verified", "candidate", "ambiguous", "missing", "stale"].includes(value.status)
  ) throw new Error("CURATION_RESOURCE_ASSESSMENT_INVALID");
  const withSnapshot = ["verified", "stale"].includes(value.status);
  if (
    withSnapshot !== Boolean(value.resource && typeof value.resource === "object" && !Array.isArray(value.resource))
    || withSnapshot !== Boolean(clean(value.resource_id))
    || withSnapshot !== /^[a-f0-9]{64}$/.test(clean(value.resource_identity_sha256))
    || withSnapshot !== /^[a-f0-9]{64}$/.test(clean(value.verification_snapshot_sha256))
  ) throw new Error("CURATION_RESOURCE_ASSESSMENT_INVALID");
  return value;
}

export async function runCurationPipeline(input = {}, hooks = {}) {
  const stage = (name) => hooks.onStage?.(name);
  stage("scope");
  const scopeIds = [...new Set(input.scope?.note_ids || [])].sort();
  if (!scopeIds.length && (input.scope?.note_ids || []).length) throw new Error("CURATION_SCOPE_INVALID");
  stage("audit_placeholders");
  const audit = { schema_version: 2, notes: Object.fromEntries(scopeIds.map((id) => [id, { status: "pending", reason_code: "audit_pending" }])) };
  stage("candidate_seed");
  const seeded = generateCandidates({ catalog: input.catalog, scope: { note_ids: scopeIds }, profile: input.profile, priorCandidates: input.priorCandidates || [] });
  stage("evidence");
  const packets = (input.evidence || []).map(normalizeEvidencePacket);
  const attached = attachEvidenceToCandidates(seeded, packets);
  stage("resource_assessment");
  const assessment = typeof hooks.assessResource === "function"
    ? await Promise.all(attached.map((candidate) => hooks.assessResource(candidate)))
    : attached.map((candidate) => registryAssessment(candidate, input));
  assessment.forEach(exactAssessment);
  stage("candidate_seal");
  const candidates = attached.map((candidate, index) => sealCandidateRevision(candidate, assessment[index]));
  stage("review");
  const currentCuration = input.current_curation && typeof input.current_curation === "object" && !Array.isArray(input.current_curation) ? input.current_curation : {};
  const auditNotes = input.current_audit?.notes && typeof input.current_audit.notes === "object" && !Array.isArray(input.current_audit.notes) ? input.current_audit.notes : {};
  const passthrough = [];
  const remaining = [];
  for (const [index, candidate] of candidates.entries()) {
    const previous = currentCuration[candidate.id];
    const resource = assessment[index];
    const current = {
      content_sha256: candidate.content_sha256,
      evidence_sha256: candidate.evidence_sha256,
      candidate_revision: candidate.candidate_revision,
      curation_revision: previous ? curationRevision(previous) : "",
      evidence_dependencies: candidate.evidence_dependencies,
      resource_required: candidate.kind === "Skill",
      resource_id: resource.resource_id,
      resource_identity_sha256: resource.resource_identity_sha256,
      verification_snapshot_sha256: resource.verification_snapshot_sha256,
      resource_fresh: resource.status === "verified",
    };
    if (auditNotes[candidate.id]?.status === "unavailable") {
      passthrough.push({ id: candidate.id, status: "unavailable", reason_code: "source_unavailable" });
    } else if (previous && acceptedRevisionsCurrent(auditNotes[candidate.id], current)) {
      passthrough.push({ id: candidate.id, status: "accepted", reason_code: "" });
    } else remaining.push(candidate);
  }
  const supplied = typeof hooks.review === "function"
    ? exactReviewSet(await hooks.review(remaining, packets), remaining)
    : remaining.map((candidate) => ({ id: candidate.id, status: "pending", reason_code: "audit_pending" }));
  const review = exactReviewSet([...passthrough, ...supplied], candidates);
  stage("merge");
  const curation = Object.fromEntries(candidates.map((candidate) => {
    const decision = review.find((item) => item.id === candidate.id) || { status: "pending", reason_code: "audit_pending" };
    return [candidate.id, { ...candidate, review_status: decision.status, review_reason_code: decision.reason_code || "" }];
  }));
  stage("validate");
  const counts = { accepted: 0, unavailable: 0, pending: 0, rejected: 0, resource_pending: 0 };
  for (const entry of Object.values(curation)) {
    if (entry.review_status === "accepted") counts.accepted += 1;
    else if (entry.review_status === "unavailable") counts.unavailable += 1;
    else if (entry.review_status === "rejected") counts.rejected += 1;
    else counts.pending += 1;
    if (entry.resource_assessment.status !== "verified" && entry.tools.length) counts.resource_pending += 1;
  }
  return { schema_version: 1, ok: true, outcome: "ready_for_safe_build", scope: { note_ids: scopeIds }, counts, candidates, evidence: packets, audit, curation, resource_assessments: assessment };
}

async function runCli() {
  const argv = process.argv.slice(2); const inputIndex = argv.indexOf("--input"); const outputIndex = argv.indexOf("--output");
  if (argv.length !== 4 || inputIndex < 0 || outputIndex < 0) throw new Error("CURATION_ARGUMENT_INVALID");
  const inputPath = resolve(argv[inputIndex + 1]); const outputPath = resolve(argv[outputIndex + 1]);
  const result = await runCurationPipeline(JSON.parse(await readFile(inputPath, "utf8")));
  const staging = `${outputPath}.${process.pid}.${randomUUID()}.staging`;
  await writeFile(staging, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await executeJournaledTransaction({ root: dirname(outputPath), id: `curation-${randomUUID().slice(0, 16)}`, participants: [{ name: "curation-bundle", target: outputPath, staging }] });
  process.stdout.write(`${JSON.stringify({ schema_version: 1, ok: true, outcome: result.outcome, counts: result.counts })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) runCli().catch((error) => { process.stderr.write(`curation-pipeline: ${String(error.message || "failed").replace(/[\r\n]+/g, " ")}\n`); process.exitCode = 1; });
