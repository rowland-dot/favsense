#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCandidates } from "./generate-curation-candidates.mjs";
import { attachEvidenceToCandidates, normalizeEvidencePacket, sealCandidateRevision } from "./normalize-evidence.mjs";
import { executeJournaledTransaction } from "./journaled-transaction.mjs";

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
    : attached.map(() => ({ status: "missing", resource_id: "", reason_code: "resource_not_applicable", resource_identity_sha256: "", verification_snapshot_sha256: "", resource: null }));
  stage("candidate_seal");
  const candidates = attached.map((candidate, index) => sealCandidateRevision(candidate, assessment[index]));
  stage("review");
  const review = typeof hooks.review === "function" ? await hooks.review(candidates, packets) : candidates.map((candidate) => ({ id: candidate.id, status: "pending", reason_code: "audit_pending" }));
  stage("merge");
  const curation = Object.fromEntries(candidates.map((candidate) => {
    const decision = review.find((item) => item.id === candidate.id) || { status: "pending", reason_code: "audit_pending" };
    return [candidate.id, { ...candidate, review_status: decision.status, review_reason_code: decision.reason_code || "" }];
  }));
  stage("validate");
  const counts = { accepted: 0, pending: 0, rejected: 0, resource_pending: 0 };
  for (const entry of Object.values(curation)) {
    if (entry.review_status === "accepted") counts.accepted += 1;
    else if (entry.review_status === "rejected") counts.rejected += 1;
    else counts.pending += 1;
    if (entry.resource_assessment.status !== "verified" && entry.tools.length) counts.resource_pending += 1;
  }
  return { schema_version: 1, ok: true, outcome: "ready_for_safe_build", counts, candidates, evidence: packets, audit, curation, resource_assessments: assessment };
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
