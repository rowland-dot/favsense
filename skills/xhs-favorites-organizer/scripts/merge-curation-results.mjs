import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { containsCredentialShape } from "./sensitive-data.mjs";
import { curationRevision, reviewPacketRevision } from "./curation-revision.mjs";
import { auditCuration } from "./validate-curation.mjs";
import { currentFormalRevisions, loadFormalPointSummary } from "./curation-quality.mjs";
import { generateCandidates } from "./generate-curation-candidates.mjs";
import {
  attachEvidenceToCandidates,
  normalizeEvidencePacket,
  sealCandidateRevision
} from "./normalize-evidence.mjs";
import { confirmedSkillResource } from "./resource-quality.mjs";
import { executeJournaledTransaction, recoverJournaledTransaction } from "./journaled-transaction.mjs";
import { acquireOrganizationMutationLock } from "./organization-mutation-lock.mjs";

const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ALLOWED_STATUS = new Set(["accepted", "pending", "rejected"]);
const JOURNAL_NAME = /^\.organization-tx-(curation-review-[A-Za-z0-9_-]{1,63})$/;
const LEGACY_STAGING_NAME = /^\.curation-review-staging-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_CLI_ERRORS = new Set([
  "CURATION_MERGE_BUSY",
  "CURATION_MERGE_LOCK_INVALID",
  "CURATION_MERGE_TRANSACTION_UNSAFE",
  "CURATION_MERGE_INPUT_INVALID",
  "CURATION_MERGE_TRANSACTION_FAILED",
  "CURATION_MERGE_CLEANUP_FAILED"
]);

function clean(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function sha256(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }
function codedError(code, cause) { return new Error(code, { cause }); }
function readJson(filename, label) {
  try { return JSON.parse(fs.readFileSync(path.resolve(filename), "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { throw new Error(`${label} could not be read: ${error.message}`); }
}
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key || "end"}`);
    result[key.slice(2)] = value;
  }
  for (const required of [
    "catalog", "config", "scope", "review", "candidates", "resources",
    "audit", "curation", "evidence-review"
  ]) {
    if (!result[required]) throw new Error(`--${required} is required`);
  }
  return result;
}

function validateCandidate(candidate, { noteId = "", contentSha256 = "", requireBinding = false } = {}) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("candidate must be an object");
  if (
    requireBinding
    && (
      clean(candidate.id) !== noteId
      || clean(candidate.content_sha256) !== contentSha256
    )
  ) throw new Error("candidate note binding is missing or stale");
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

function boundedCandidateSkeleton(candidate) {
  if (candidate !== null && candidate !== undefined) {
    if (typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("candidate skeleton must be an object or null");
    }
    if (containsCredentialShape(candidate)) throw new Error("candidate contains private source data");
  }
  const value = candidate && typeof candidate === "object" ? candidate : {};
  const boundedList = (items) => Array.isArray(items)
    ? [...new Set(items.map(clean).filter(Boolean))].slice(0, 12).map((item) => item.slice(0, 120))
    : [];
  return {
    title: clean(value.title).slice(0, 200),
    summary: clean(value.summary).slice(0, 1_000),
    action: clean(value.action).slice(0, 500),
    themes: boundedList(value.themes),
    tools: boundedList(value.tools),
    kind: clean(value.kind).slice(0, 80)
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

function resourceAssessment(candidate, auditEntry, resources, today) {
  const collection = Array.isArray(resources) ? resources : resources?.resources || [];
  if (candidate.kind !== "Skill") {
    return {
      status: auditEntry.resource_status === "verified" ? "verified" : "missing",
      resource_id: "",
      reason_code: "resource_not_applicable",
      resource_identity_sha256: "",
      verification_snapshot_sha256: "",
      resource: null
    };
  }
  const names = new Set(candidate.tools.map((tool) => clean(tool).toLocaleLowerCase("zh-CN")));
  const matches = collection.filter((resource) => [resource?.name, ...(resource?.aliases || [])]
    .some((alias) => names.has(clean(alias).toLocaleLowerCase("zh-CN"))));
  const verified = confirmedSkillResource(matches, {
    today,
    maxAgeDays: 30
  });
  return verified ? {
    status: "verified",
    resource_id: verified.id,
    reason_code: "",
    resource_identity_sha256: verified.resource_identity_sha256,
    verification_snapshot_sha256: verified.verification_snapshot_sha256,
    resource: verified
  } : {
    status: "missing",
    resource_id: "",
    reason_code: "resource_ambiguous",
    resource_identity_sha256: "",
    verification_snapshot_sha256: "",
    resource: null
  };
}

function formalCandidate(noteId, note, candidate, auditEntry, resources, evidenceItem, point, today) {
  const methods = [{
    method: "public_text",
    provider: "favsense",
    version: "1",
    result_sha256: sha256(clean(note.description))
  }];
  if (auditEntry.evidence_methods.includes("diandian_summary")) {
    if (!point || point.content_sha256 !== note.content_sha256 || point.summary_sha256 !== auditEntry.diandian_summary_sha256) {
      throw new Error("accepted DianDian evidence is missing or stale");
    }
    methods.push({
      method: "diandian_summary",
      provider: point.provider,
      version: point.prompt_version,
      result_sha256: point.summary_sha256
    });
  }
  if (auditEntry.evidence_methods.includes("audio_transcript")) {
    if (clean(evidenceItem?.content_sha256) !== note.content_sha256) {
      throw new Error("accepted transcript evidence is stale");
    }
    const transcript = clean(evidenceItem?.transcript_text);
    const artifact = evidenceItem?.transcript_evidence;
    if (
      !transcript
      || artifact?.method !== "local_transcription"
      || !clean(artifact?.provider)
      || !clean(artifact?.version)
      || !/^[a-f0-9]{64}$/.test(clean(artifact?.result_sha256))
      || artifact.result_sha256 !== sha256(transcript)
    ) throw new Error("accepted transcript evidence is missing or invalid");
    methods.push({
      method: "audio_transcript",
      provider: clean(artifact.provider),
      version: clean(artifact.version),
      result_sha256: artifact.result_sha256
    });
  }
  if (auditEntry.evidence_methods.includes("image_ocr")) {
    if (clean(evidenceItem?.content_sha256) !== note.content_sha256) {
      throw new Error("accepted visual evidence is stale");
    }
    const visual = clean(evidenceItem?.visual_text);
    const artifact = evidenceItem?.visual_evidence;
    if (
      !visual
      || artifact?.method !== "local_image_ocr"
      || !clean(artifact?.provider)
      || !clean(artifact?.version)
      || !/^[a-f0-9]{64}$/.test(clean(artifact?.result_sha256))
      || artifact.result_sha256 !== sha256(visual)
    ) throw new Error("accepted image OCR evidence is missing or invalid");
    methods.push({
      method: "image_ocr",
      provider: clean(artifact.provider),
      version: clean(artifact.version),
      result_sha256: artifact.result_sha256
    });
  }
  if (auditEntry.evidence_methods.includes("image_review")) {
    throw new Error("accepted image review evidence is unavailable as a revision-bound artifact");
  }
  for (const method of ["visual_ocr", "video_analysis"]) {
    if (auditEntry.evidence_methods.includes(method)) {
      throw new Error(`accepted ${method} evidence is unavailable as a revision-bound artifact`);
    }
  }
  const packet = normalizeEvidencePacket({
    note_id: noteId,
    content_sha256: note.content_sha256,
    public_text: clean(note.description),
    comments: [],
    comments_checked: auditEntry.comments_checked,
    methods
  });
  const seed = generateCandidates({
    catalog: [{ id: noteId, ...note }],
    scope: { note_ids: [noteId] },
    profile: { classification: { default: candidate.kind } },
    priorCandidates: [{ id: noteId, ...candidate }]
  })[0];
  const assessment = resourceAssessment(candidate, auditEntry, resources, today);
  if (candidate.kind === "Skill" && assessment.status !== "verified") {
    throw new Error("accepted Skill resource is unavailable or stale");
  }
  const sealed = sealCandidateRevision(attachEvidenceToCandidates([seed], [packet])[0], assessment);
  return {
    entry: {
      ...sealed,
      review_status: auditEntry.status,
      review_reason_code: clean(auditEntry.reason)
    },
    assessment
  };
}

export function mergeResults({
  catalog, config, scope, review, candidates, resources, audit, curation,
  evidenceReview = null, pointSummaries = null, expectedCount = null,
  expectedPromptVersion = "",
  requirePacketBinding = false,
  today = new Date().toISOString().slice(0, 10)
}) {
  if (expectedPromptVersion && !/^[a-f0-9]{64}$/.test(expectedPromptVersion)) {
    throw new Error("DianDian prompt version is invalid");
  }
  const items = Array.isArray(review?.items) ? review.items : null;
  if (!items) throw new Error("review.items must be an array");
  if (expectedCount !== null && items.length !== expectedCount) throw new Error(`review must contain exactly ${expectedCount} items`);
  const catalogIds = new Set(Object.keys(catalog.notes || catalog));
  const scopeList = Array.isArray(scope?.note_ids) ? scope.note_ids.map(clean) : [];
  const scopeIds = new Set(scopeList);
  if (
    scopeList.length !== scopeIds.size
    || scopeList.some((noteId) => !NOTE_ID.test(noteId) || !catalogIds.has(noteId))
  ) throw new Error("scope contains an unknown, invalid, or duplicate note ID");
  const seen = new Set();
  const nextCandidates = { ...(candidates || {}) };
  const nextAudit = { ...(audit || {}), notes: { ...(audit?.notes || {}) } };
  const nextCuration = { ...(curation || {}) };
  const evidenceById = new Map();
  const evidenceItems = Array.isArray(evidenceReview?.items) ? evidenceReview.items : [];
  for (const item of evidenceItems) {
    const noteId = clean(item?.note_id);
    if (!scopeIds.has(noteId)) {
      if (requirePacketBinding) throw new Error("review packet set contains an out-of-scope note");
      continue;
    }
    if (!NOTE_ID.test(noteId) || evidenceById.has(noteId)) {
      throw new Error("evidence review contains an invalid or duplicate note ID");
    }
    evidenceById.set(noteId, item);
  }
  if (requirePacketBinding && evidenceById.size !== scopeIds.size) {
    throw new Error("review packet set does not match the review scope");
  }
  const counts = { accepted: 0, pending: 0, rejected: 0 };
  for (const item of items) {
    const noteId = clean(item?.note_id);
    if (!NOTE_ID.test(noteId) || !catalogIds.has(noteId) || !scopeIds.has(noteId)) throw new Error("review contains an unknown, invalid, or out-of-scope note ID");
    if (seen.has(noteId)) throw new Error("review contains a duplicate note ID");
    seen.add(noteId);
    const note = (catalog.notes || catalog)[noteId];
    const evidenceItem = evidenceById.get(noteId);
    const expectedReviewPacket = clean(evidenceItem?.review_packet_sha256);
    if (
      (requirePacketBinding || expectedReviewPacket)
      && (
        !/^[a-f0-9]{64}$/.test(expectedReviewPacket)
        || reviewPacketRevision(evidenceItem) !== expectedReviewPacket
        || clean(item?.review_packet_sha256) !== expectedReviewPacket
      )
    ) throw new Error("review packet binding is missing or stale");
    if (
      requirePacketBinding
      && clean(evidenceItem?.content_sha256) !== clean(note?.content_sha256)
    ) throw new Error("review packet content revision is stale");
    const auditEntry = validateAudit(item.audit);
    const candidate = auditEntry.status === "accepted"
      ? validateCandidate(item.candidate, {
          noteId,
          contentSha256: clean(note?.content_sha256),
          requireBinding: requirePacketBinding
        })
      : boundedCandidateSkeleton(item.candidate);
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
    let storedCandidate = candidate;
    if (auditEntry.status === "accepted") {
      const point = pointSummaries?.[noteId] || null;
      const formal = formalCandidate(
        noteId, note, candidate, auditEntry, resources, evidenceItem, point, today
      );
      const formalEntry = formal.entry;
      const current = currentFormalRevisions(
        note,
        formalEntry,
        formal.assessment.resource,
        expectedPromptVersion
      );
      if (!current) throw new Error("accepted review could not be bound to current formal revisions");
      Object.assign(auditEntry, current, {
        curation_sha256: current.curation_revision
      });
      const quality = auditCuration({
        catalog: { notes: { [noteId]: note } },
        config,
        curation: { [noteId]: formalEntry },
        resources,
        audit: { notes: { [noteId]: auditEntry } },
        scopeIds: [noteId]
      });
      if (quality.fatal.length) {
        throw new Error(`accepted formal audit failed quality validation: ${quality.fatal.join("; ")}`);
      }
      storedCandidate = formalEntry;
      nextCuration[noteId] = formalEntry;
    } else {
      delete nextCuration[noteId];
    }
    const finalQuality = auditCuration({
      catalog: { notes: { [noteId]: note } },
      config,
      curation: auditEntry.status === "accepted" ? { [noteId]: storedCandidate } : {},
      resources,
      audit: { notes: { [noteId]: auditEntry } },
      scopeIds: [noteId]
    });
    if (finalQuality.fatal.length) {
      throw new Error(
        `${auditEntry.status} final audit failed quality validation: ${finalQuality.fatal.join("; ")}`
      );
    }
    nextCandidates[noteId] = storedCandidate;
    nextAudit.notes[noteId] = auditEntry;
    counts[auditEntry.status] += 1;
  }
  if (requirePacketBinding && seen.size !== scopeIds.size) {
    throw new Error("review item set does not match the review scope");
  }
  return { candidates: nextCandidates, audit: nextAudit, curation: nextCuration, counts };
}

async function recoverCurationJournals(root, transactionRoot, participants) {
  await recoverJournaledTransaction({
    root,
    transactionRoot,
    id: `curation-review-probe-${randomUUID()}`,
    participants
  });
  const before = await plainDirectoryChain(root, transactionRoot);
  const entries = await readdir(transactionRoot);
  const after = await plainDirectoryChain(root, transactionRoot);
  if (
    before.length !== after.length
    || before.some((metadata, index) => !sameIdentity(metadata, after[index]))
  ) throw new Error("TRANSACTION_ROOT_CHANGED");
  for (const name of entries) {
    if (!name.startsWith(".organization-tx-curation-review-")) continue;
    const match = JOURNAL_NAME.exec(name);
    if (!match) throw new Error("TRANSACTION_JOURNAL_NAME_INVALID");
    await recoverJournaledTransaction({
      root,
      transactionRoot,
      id: match[1],
      participants
    });
  }
  return entries.filter((name) => LEGACY_STAGING_NAME.test(name));
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function plainDirectoryChain(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("TRANSACTION_PATH_ESCAPE");
  }
  const chain = [root];
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    chain.push(cursor);
  }
  return Promise.all(chain.map(async (directory) => {
    const metadata = await lstat(directory, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("TRANSACTION_PATH_UNSAFE");
    }
    return metadata;
  }));
}

function assertNoLegacyStaging(names) {
  if (names.length) throw new Error("TRANSACTION_STAGING_CLEANUP_REQUIRED");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  const transactionRoot = path.join(root, ".xhs-favorites", "organization-transactions");
  const participants = [
    { name: "curation-candidates", target: path.resolve(options.candidates) },
    { name: "curation-audit", target: path.resolve(options.audit) },
    { name: "formal-curation", target: path.resolve(options.curation) }
  ];
  let releaseMutationLock;
  try {
    releaseMutationLock = await acquireOrganizationMutationLock(root, {
      busyError: () => codedError("CURATION_MERGE_BUSY"),
      invalidError: () => codedError("CURATION_MERGE_LOCK_INVALID")
    });
  } catch (error) {
    if (SAFE_CLI_ERRORS.has(error?.message)) throw error;
    throw codedError("CURATION_MERGE_LOCK_INVALID", error);
  }
  let legacyStaging = [];
  let result;
  try {
    try {
      legacyStaging = await recoverCurationJournals(root, transactionRoot, participants);
    } catch (error) {
      throw codedError("CURATION_MERGE_TRANSACTION_UNSAFE", error);
    }
    try {
      assertNoLegacyStaging(legacyStaging);
      legacyStaging = [];
    } catch (error) {
      throw codedError("CURATION_MERGE_CLEANUP_FAILED", error);
    }
    let merged;
    try {
      const scope = readJson(options.scope, "scope");
      const expectedPromptVersion = String(options["diandian-prompt-version"] || "");
      if (expectedPromptVersion && !/^[a-f0-9]{64}$/.test(expectedPromptVersion)) {
        throw new Error("DianDian prompt version is invalid");
      }
      merged = mergeResults({
        catalog: readJson(options.catalog, "catalog"),
        config: readJson(options.config, "config"),
        scope,
        review: readJson(options.review, "review"),
        candidates: readJson(options.candidates, "candidates"),
        resources: readJson(options.resources, "resources"),
        audit: readJson(options.audit, "audit"),
        curation: readJson(options.curation, "curation"),
        evidenceReview: options["evidence-review"] ? readJson(options["evidence-review"], "evidence review") : null,
        pointSummaries: options["diandian-root"]
          ? Object.fromEntries((scope.note_ids || []).map((noteId) => [
              noteId,
              loadFormalPointSummary(path.resolve(options["diandian-root"]), noteId, expectedPromptVersion)
            ]))
          : null,
        expectedPromptVersion,
        requirePacketBinding: true,
        expectedCount: options["expected-count"] === undefined ? null : Number(options["expected-count"])
      });
    } catch (error) {
      throw codedError("CURATION_MERGE_INPUT_INVALID", error);
    }
    try {
      await executeJournaledTransaction({
        root,
        transactionRoot,
        id: `curation-review-${randomUUID().replaceAll("-", "")}`,
        participants: [
          { ...participants[0], content: `${JSON.stringify(merged.candidates, null, 2)}\n` },
          { ...participants[1], content: `${JSON.stringify(merged.audit, null, 2)}\n` },
          { ...participants[2], content: `${JSON.stringify(merged.curation, null, 2)}\n` }
        ]
      });
    } catch (error) {
      throw codedError("CURATION_MERGE_TRANSACTION_FAILED", error);
    }
    result = { ok: true, ...merged.counts };
  } finally {
    try {
      assertNoLegacyStaging(legacyStaging);
    } catch (error) {
      throw codedError("CURATION_MERGE_CLEANUP_FAILED", error);
    } finally {
      await releaseMutationLock();
    }
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const code = SAFE_CLI_ERRORS.has(error?.message)
        ? error.message
        : "CURATION_MERGE_FAILED";
      process.stderr.write(`curation-merge: ${code}\n`);
      process.exitCode = 1;
    });
}
