import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { copyFile, cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { contentRevision, evidenceRevision } from "./content-revision.mjs";
import { curationRevision, publicCurationProjection } from "./curation-revision.mjs";
import { generateCandidates } from "./generate-curation-candidates.mjs";
import { executeJournaledTransaction, recoverJournaledTransaction } from "./journaled-transaction.mjs";
import { sealCandidateRevision } from "./normalize-evidence.mjs";
import { atomicWriteTextFile } from "./public-tree-policy.mjs";
import { confirmedSkillResource, validateVerifiedResource } from "./resource-quality.mjs";
import { containsCredentialShape } from "./sensitive-data.mjs";

const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);
const REPORT_KEYS = ["apply_performed", "counts", "created_at", "dry_run_id", "expires_at", "next_command", "schema_version"];
const PARTICIPANTS = [
  ["organization-state", "organization_state"],
  ["point-records", "point_records"],
  ["curation-audit", "curation_audit"],
  ["resource-assessments", "resource_assessments"],
  ["formal-curation", "formal_curation"],
  ["formal-resources", "formal_resources"],
];
const FORMAL_CURATION_KEYS = new Set([
  "action", "candidate_revision", "category", "category_override", "category_reason",
  "evidence_dependencies", "evidence_sha256", "kind", "summary", "themes", "title", "tools",
]);
const clean = (value) => String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
const shaText = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");
const shaBytes = (value) => createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
const canonicalJson = (value) => JSON.stringify(canonical(value));
const shaJson = (value) => shaText(canonicalJson(value));

function livePathRevision(path, relativePath = "") {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
  if (metadata.isSymbolicLink()) throw new Error("MIGRATION_PATH_UNSAFE");
  if (metadata.isFile()) {
    if (metadata.size > 16 * 1024 * 1024) throw new Error("MIGRATION_TARGET_UNSAFE");
    return { kind: "file", path: relativePath, sha256: shaBytes(readFileSync(path)) };
  }
  if (!metadata.isDirectory()) throw new Error("MIGRATION_TARGET_UNSAFE");
  return {
    kind: "directory",
    path: relativePath,
    entries: readdirSync(path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => livePathRevision(join(path, entry.name), join(relativePath, entry.name))),
  };
}
function liveTargetRevisions(root) {
  return Object.fromEntries(
    Object.entries(migrationTargetPaths(root)).map(([key, path]) => [key, livePathRevision(path)]),
  );
}

function migrationError(code) {
  const error = new Error(code);
  error.code = code;
  error.next_action = "rerun_dry_run";
  return error;
}
function parseInstant(value, code) {
  const instant = new Date(value);
  if (!value || Number.isNaN(instant.getTime())) throw migrationError(code);
  return instant;
}
function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.schema_version !== 1
    || !Array.isArray(input.records) || input.records.length > 100_000
    || containsCredentialShape(input)) throw new Error("MIGRATION_INPUT_INVALID");
}
function uniqueRecords(input) {
  validateInput(input);
  const records = new Map();
  const conflicts = new Set();
  let duplicates = 0;
  for (const record of input.records) {
    const id = clean(record?.id);
    if (!SAFE_ID.test(id) || RESERVED_IDS.has(id)
      || !record?.note || typeof record.note !== "object" || Array.isArray(record.note)) {
      throw new Error("MIGRATION_RECORD_INVALID");
    }
    if (!records.has(id)) records.set(id, structuredClone(record));
    else {
      duplicates += 1;
      const retained = canonicalJson(records.get(id));
      const incoming = canonicalJson(record);
      if (retained !== incoming) {
        conflicts.add(id);
        if (incoming < retained) records.set(id, structuredClone(record));
      }
    }
  }
  return { records: [...records.entries()].sort(([left], [right]) => left.localeCompare(right)), conflicts, duplicates };
}
function currentCandidate(id, record, contentSha256, evidenceSha256, dependencies, resource = null, snapshotOverride = "") {
  const seed = generateCandidates({
    catalog: [{ id, ...record.note, content_sha256: contentSha256 }],
    scope: { note_ids: [id] },
    profile: { classification: { default: "Other" } },
  })[0];
  const curation = record.curation || {};
  const resourceAssessment = resource ? {
    status: "verified",
    resource_id: resource.id,
    reason_code: "",
    resource_identity_sha256: resource.resource_identity_sha256,
    verification_snapshot_sha256: snapshotOverride || resource.verification_snapshot_sha256,
  } : {
    status: "missing", resource_id: "", reason_code: "resource_not_applicable",
    resource_identity_sha256: "", verification_snapshot_sha256: "",
  };
  return sealCandidateRevision({
    ...seed,
    title: clean(curation.title),
    summary: clean(curation.summary),
    action: clean(curation.action),
    themes: Array.isArray(curation.themes) ? curation.themes : [],
    tools: Array.isArray(curation.tools) ? curation.tools : [],
    kind: clean(curation.kind || "Other"),
    evidence_sha256: evidenceSha256,
    evidence_dependencies: dependencies,
    blockers: [],
  }, resourceAssessment);
}
function phase(status, reasonCode, updatedAt) {
  return { status, reason_code: reasonCode, updated_at: updatedAt };
}
function migrateRecord(id, record, conflicting, today, updatedAt) {
  const contentSha256 = contentRevision(record.note);
  const base = {
    schema_version: 2,
    note_id: id,
    content_sha256: contentSha256,
    evidence_sha256: "",
    candidate_kind: clean(record.curation?.kind || "Other"),
    confirmed_kind: "Other",
    evidence_dependencies: [],
    dimensions: {
      core: phase("saved", "", updatedAt),
      summary: phase("stale", "unknown_legacy", updatedAt),
      evidence: phase("missing", "evidence_missing", updatedAt),
      resource: phase("not_applicable", "resource_not_applicable", updatedAt),
      curation: phase("pending_review", "audit_pending", updatedAt),
      public: phase("not_eligible", "audit_pending", updatedAt),
    },
  };
  if (conflicting) return { classification: "rejected", state: { ...base, rejection_reason: "conflicting_duplicate" } };

  const point = record.point;
  const pointTitle = clean(point?.title || record.note.title);
  const pointSummary = String(point?.summary ?? "").replace(/\r\n?/g, "\n").trim();
  if (point?.version === 1 && clean(point.provider) === "xiaohongshu-diandian" && clean(point.prompt) === "总结"
    && pointTitle && pointSummary && pointSummary.length <= 200_000 && HASH.test(clean(record.legacy_prompt_version))
    && !Number.isNaN(new Date(point.captured_at).getTime())) {
    const summary = pointSummary;
    const summarySha256 = shaText(summary);
    const promptVersion = clean(record.legacy_prompt_version);
    const migratedPoint = {
      version: 2, provider: "xiaohongshu-diandian", prompt: "总结", prompt_version: promptVersion,
      note_id: id, title: pointTitle, summary, content_sha256: contentSha256,
      request_sha256: shaText(`${pointTitle}\0${summary}`),
      summary_sha256: summarySha256, captured_at: new Date(point.captured_at).toISOString(),
    };
    const dependency = { method: "diandian_summary", provider: migratedPoint.provider, version: promptVersion, result_sha256: summarySha256 };
    const pointEvidenceSha256 = evidenceRevision({
      contentSha256, comments: [], commentsChecked: false, methods: [dependency],
    });
    const independentCuration = record.audit?.status === "accepted"
      ? migrateRecord(id, { ...record, point: undefined, legacy_prompt_version: undefined }, false, today, updatedAt)
      : null;
    if (independentCuration?.classification === "unchanged") {
      return {
        ...independentCuration,
        classification: "migrated",
        point: migratedPoint,
        state: {
          ...independentCuration.state,
          dimensions: {
            ...independentCuration.state.dimensions,
            summary: phase("captured", "", updatedAt),
          },
        },
      };
    }
    return {
      classification: "migrated", point: migratedPoint,
      state: {
        ...base, evidence_sha256: pointEvidenceSha256, evidence_dependencies: [dependency],
        dimensions: {
          ...base.dimensions,
          summary: phase("captured", "", updatedAt),
          evidence: phase("ready", "", updatedAt),
        },
      },
    };
  }

  if (record.audit?.status === "accepted" && record.curation && record.evidence) {
    try {
      const skillCandidate = clean(record.curation.kind || "Other") === "Skill";
      const resourceInputs = Array.isArray(record.resources)
        ? record.resources
        : (record.resource ? [record.resource] : []);
      const resource = skillCandidate ? confirmedSkillResource(resourceInputs, { today, maxAgeDays: 30 }) : null;
      const dependencies = Array.isArray(record.evidence.methods) ? record.evidence.methods : [];
      const evidenceSha256 = evidenceRevision({
        contentSha256, comments: record.evidence.comments || [],
        commentsChecked: record.evidence.comments_checked === true, methods: dependencies,
      });
      const candidate = currentCandidate(id, record, contentSha256, evidenceSha256, dependencies, resource);
      const current = {
        content_sha256: contentSha256, evidence_sha256: evidenceSha256,
        candidate_revision: candidate.candidate_revision, curation_revision: curationRevision(record.curation),
        evidence_dependencies: dependencies,
      };
      const baseRevisionsCurrent = ["content_sha256", "evidence_sha256", "curation_revision"]
        .every((key) => record.audit[key] === current[key])
        && canonicalJson(record.audit.evidence_dependencies) === canonicalJson(current.evidence_dependencies);
      const directCandidateCurrent = record.audit.candidate_revision === current.candidate_revision;
      const sameIdentityRefresh = Boolean(
        resource && baseRevisionsCurrent
        && record.audit.resource_id === resource.id
        && record.audit.resource_identity_sha256 === resource.resource_identity_sha256
        && HASH.test(clean(record.audit.verification_snapshot_sha256))
        && currentCandidate(
          id, record, contentSha256, evidenceSha256, dependencies,
          resource, record.audit.verification_snapshot_sha256,
        ).candidate_revision === record.audit.candidate_revision
      );
      const resourceCurrent = !skillCandidate || Boolean(
        resource
        && record.audit.resource_id === resource.id
        && record.audit.resource_identity_sha256 === resource.resource_identity_sha256
        && (record.audit.verification_snapshot_sha256 === resource.verification_snapshot_sha256 || sameIdentityRefresh)
      );
      const currentAccepted = baseRevisionsCurrent && resourceCurrent && (directCandidateCurrent || sameIdentityRefresh);
      if (currentAccepted) {
        const audit = {
          ...canonical(record.audit),
          candidate_revision: candidate.candidate_revision,
          ...(resource ? {
            resource_id: resource.id,
            resource_identity_sha256: resource.resource_identity_sha256,
            verification_snapshot_sha256: resource.verification_snapshot_sha256,
          } : {}),
        };
        return {
          classification: "unchanged",
          formalCuration: {
            ...publicCurationProjection(record.curation),
            evidence_sha256: evidenceSha256,
            candidate_revision: candidate.candidate_revision,
            evidence_dependencies: dependencies,
          },
          formalResource: resource, audit,
          state: {
            ...base, confirmed_kind: clean(record.curation.kind || "Other"),
            evidence_sha256: evidenceSha256, evidence_dependencies: dependencies,
            dimensions: {
              ...base.dimensions,
              summary: phase("not_required", "", updatedAt),
              evidence: phase("ready", "", updatedAt),
              curation: phase("accepted", "", updatedAt),
              resource: resource
                ? { ...phase("verified", "", updatedAt), resource_id: resource.id }
                : phase("not_applicable", "resource_not_applicable", updatedAt),
              public: phase("ready", "", updatedAt),
            },
          },
        };
      }
    } catch {
      // Unprovable legacy revisions remain pending.
    }
  }
  if (base.candidate_kind === "Skill") base.dimensions.resource = phase("candidate", "resource_stale", updatedAt);
  return { classification: "pending", state: base };
}
function prepareMigration(input, { today = "", updatedAt = "" } = {}) {
  const { records, conflicts, duplicates } = uniqueRecords(input);
  const output = {
    state: { schema_version: 2, notes: {} }, points: {}, audit: { schema_version: 2, notes: {} },
    resources: { schema_version: 1, notes: {} }, formalCuration: {},
    formalResources: { verified_at: today, resources: [] },
  };
  const counts = {
    input_records: input.records.length, input_unique: records.length, duplicates,
    unchanged: 0, migrated: 0, pending: 0, rejected: 0,
  };
  for (const [id, record] of records) {
    const result = migrateRecord(id, record, conflicts.has(id), today, updatedAt);
    counts[result.classification] += 1;
    output.state.notes[id] = result.state;
    if (result.point) output.points[id] = result.point;
    if (result.audit) output.audit.notes[id] = result.audit;
    if (result.formalCuration) output.formalCuration[id] = result.formalCuration;
    if (result.formalResource) output.formalResources.resources.push(result.formalResource);
    output.resources.notes[id] = {
      status: result.state.dimensions.resource.status,
      resource_id: result.state.dimensions.resource.resource_id || "",
      reason_code: result.state.dimensions.resource.reason_code,
      resource_identity_sha256: result.formalResource?.resource_identity_sha256 || "",
      verification_snapshot_sha256: result.formalResource?.verification_snapshot_sha256 || "",
      resource: result.formalResource || null,
    };
  }
  if (counts.input_unique !== counts.unchanged + counts.migrated + counts.pending + counts.rejected) throw new Error("MIGRATION_CONSERVATION_FAILED");
  return { counts, output };
}

export function planMigration(input, { now = new Date().toISOString(), root: rootValue } = {}) {
  if (!rootValue) throw new Error("MIGRATION_ROOT_REQUIRED");
  const rootIdentity = shaText(resolve(rootValue).normalize("NFC").toLowerCase());
  const created = parseInstant(now, "MIGRATION_TIME_INVALID");
  const createdAt = created.toISOString();
  const { counts } = prepareMigration(input, { today: createdAt.slice(0, 10), updatedAt: createdAt });
  const normalized = uniqueRecords(input);
  const expiresAt = new Date(created.getTime() + 15 * 60 * 1000).toISOString();
  const dryRunId = shaJson({
    schema_version: 1, created_at: createdAt, expires_at: expiresAt, counts,
    root_identity_sha256: rootIdentity,
    live_target_revisions: liveTargetRevisions(rootValue),
    records: normalized.records.map(([, record]) => canonical(record)),
    conflicts: [...normalized.conflicts].sort(),
  });
  return {
    schema_version: 1, dry_run_id: dryRunId, created_at: createdAt, expires_at: expiresAt,
    apply_performed: false, counts,
    next_command: `node skills/xhs-favorites-organizer/scripts/migrate-organization-state.mjs --input <inventory.json> --root <workspace> --report .xhs-favorites/migration-reports/${dryRunId}.json --apply --confirm ${dryRunId}`,
  };
}
export function migrationTargetPaths(rootValue) {
  const root = resolve(rootValue);
  return {
    organization_state: join(root, ".xhs-favorites", "organization-state", "migration-v2.json"),
    point_records: join(root, ".xhs-favorites", "diandian-summaries"),
    curation_audit: join(root, ".xhs-favorites", "curation-audit.json"),
    resource_assessments: join(root, ".xhs-favorites", "resource-assessments.json"),
    formal_curation: join(root, "skills", "xhs-favorites-organizer", "references", "skills-board-curation.json"),
    formal_resources: join(root, "skills", "xhs-favorites-organizer", "references", "software-resources.json"),
  };
}
export function migrationPrivatePaths(rootValue, dryRunId) {
  if (!HASH.test(String(dryRunId || ""))) throw new Error("MIGRATION_DRY_RUN_ID_INVALID");
  const base = join(resolve(rootValue), ".xhs-favorites", "organization-migration", dryRunId);
  return {
    backup_directory: join(base, "backups"),
    point_staging: join(base, "point-staging"),
    rollback_manifest: join(base, "rollback-manifest.json"),
    dry_run_report: join(base, "dry-run-report.json"),
  };
}
async function pathMetadata(path) {
  try { return await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function validateReport(report, expected) {
  if (!report || typeof report !== "object" || Array.isArray(report)
    || Object.keys(report).sort().join(",") !== [...REPORT_KEYS].sort().join(",")
    || canonicalJson(report) !== canonicalJson(expected)) throw migrationError("MIGRATION_REPORT_STALE");
}
async function assertSafePath(rootValue, targetValue) {
  const root = resolve(rootValue);
  const target = resolve(targetValue);
  const rel = relative(root, target);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("MIGRATION_PATH_ESCAPE");
  const rootMetadata = await pathMetadata(root);
  if (!rootMetadata || !rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("MIGRATION_ROOT_UNSAFE");
  let cursor = root;
  const segments = rel.split(sep);
  for (const [index, segment] of segments.entries()) {
    cursor = join(cursor, segment);
    const metadata = await pathMetadata(cursor);
    if (!metadata) break;
    if (metadata.isSymbolicLink() || (index < segments.length - 1 && !metadata.isDirectory())) {
      throw new Error("MIGRATION_PATH_UNSAFE");
    }
  }
}
async function validatePlainTree(directory) {
  const metadata = await pathMetadata(directory);
  if (!metadata) return;
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("MIGRATION_PATH_UNSAFE");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name);
    const child = await lstat(target);
    if (child.isSymbolicLink()) throw new Error("MIGRATION_PATH_UNSAFE");
    if (child.isDirectory()) await validatePlainTree(target);
    else if (!child.isFile() || child.size > 16 * 1024 * 1024) throw new Error("MIGRATION_TARGET_UNSAFE");
  }
}
async function readSafeJsonFile(path) {
  const metadata = await pathMetadata(path);
  if (!metadata) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 * 1024) {
    throw new Error("MIGRATION_TARGET_UNSAFE");
  }
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MIGRATION_TARGET_SCHEMA_INVALID");
    return value;
  } catch {
    throw new Error("MIGRATION_TARGET_SCHEMA_INVALID");
  }
}
export async function applyMigration(input, { root: rootValue, report, confirm, now = new Date().toISOString(), failAt = "" } = {}) {
  const root = resolve(rootValue);
  if (!report || !HASH.test(String(report.dry_run_id || ""))) throw migrationError("MIGRATION_REPORT_STALE");
  if (confirm !== report.dry_run_id) throw migrationError("MIGRATION_CONFIRMATION_MISMATCH");
  const applyTime = parseInstant(now, "MIGRATION_TIME_INVALID").getTime();
  if (
    applyTime < parseInstant(report.created_at, "MIGRATION_REPORT_STALE").getTime()
    || applyTime >= parseInstant(report.expires_at, "MIGRATION_REPORT_STALE").getTime()
  ) {
    throw migrationError("MIGRATION_CONFIRMATION_EXPIRED");
  }
  const targets = migrationTargetPaths(root);
  const privatePaths = migrationPrivatePaths(root, report.dry_run_id);
  for (const target of [...Object.values(targets), ...Object.values(privatePaths)]) await assertSafePath(root, target);
  const transactionId = `migration-${report.dry_run_id.slice(0, 16)}`;
  const priorManifest = await readSafeJsonFile(privatePaths.rollback_manifest);
  const pendingTransaction = await pathMetadata(join(root, `.organization-tx-${transactionId}`));
  if (priorManifest || pendingTransaction) {
    if (pendingTransaction && (!pendingTransaction.isDirectory() || pendingTransaction.isSymbolicLink())) {
      throw new Error("MIGRATION_TRANSACTION_UNSAFE");
    }
    if (priorManifest && (
      priorManifest.schema_version !== 1
      || priorManifest.dry_run_id !== report.dry_run_id
      || !["prepared", "committed"].includes(priorManifest.status)
    )) {
      throw migrationError("MIGRATION_REPORT_ALREADY_USED");
    }
    if (!pendingTransaction) throw migrationError("MIGRATION_REPORT_ALREADY_USED");
    await recoverJournaledTransaction({
      root,
      id: transactionId,
      participants: [
        ...PARTICIPANTS.map(([name, key]) => ({ name, target: targets[key] })),
        { name: "rollback-manifest", target: privatePaths.rollback_manifest },
      ],
    });
    const restoredManifest = await readSafeJsonFile(privatePaths.rollback_manifest);
    if (
      !restoredManifest || restoredManifest.schema_version !== 1
      || restoredManifest.dry_run_id !== report.dry_run_id
      || restoredManifest.status !== "prepared"
    ) throw new Error("MIGRATION_RECOVERY_MANIFEST_INVALID");
    await atomicWriteTextFile(
      privatePaths.rollback_manifest,
      `${JSON.stringify({ ...restoredManifest, status: "rolled_back" })}\n`,
    );
    throw migrationError("MIGRATION_RECOVERED_RERUN_DRY_RUN");
  }
  const expected = planMigration(input, { now: report.created_at, root });
  validateReport(report, expected);
  const confirmedLiveRevisions = liveTargetRevisions(root);
  const { output } = prepareMigration(input, { today: report.created_at.slice(0, 10), updatedAt: report.created_at });
  const priorState = await readSafeJsonFile(targets.organization_state);
  const priorAudit = await readSafeJsonFile(targets.curation_audit);
  const priorAssessments = await readSafeJsonFile(targets.resource_assessments);
  const priorFormalCuration = await readSafeJsonFile(targets.formal_curation);
  const priorFormalResources = await readSafeJsonFile(targets.formal_resources);
  if (priorState && (priorState.schema_version !== 2 || !priorState.notes || typeof priorState.notes !== "object")) {
    throw new Error("MIGRATION_TARGET_SCHEMA_INVALID");
  }
  if (priorAudit && (priorAudit.schema_version !== 2 || !priorAudit.notes || typeof priorAudit.notes !== "object")) {
    throw new Error("MIGRATION_TARGET_SCHEMA_INVALID");
  }
  if (priorAssessments && (priorAssessments.schema_version !== 1 || !priorAssessments.notes || typeof priorAssessments.notes !== "object")) {
    throw new Error("MIGRATION_TARGET_SCHEMA_INVALID");
  }
  if (priorFormalResources && (
    !/^\d{4}-\d{2}-\d{2}$/.test(clean(priorFormalResources.verified_at))
    || !Array.isArray(priorFormalResources.resources)
  )) throw new Error("MIGRATION_TARGET_SCHEMA_INVALID");
  if (priorFormalCuration && Object.values(priorFormalCuration).some((entry) => (
    !entry || typeof entry !== "object" || Array.isArray(entry)
    || containsCredentialShape(entry)
    || Object.keys(entry).some((key) => !FORMAL_CURATION_KEYS.has(key))
  ))) throw new Error("MIGRATION_TARGET_SCHEMA_INVALID");
  output.state.notes = { ...(priorState?.notes || {}), ...output.state.notes };
  output.audit.notes = { ...(priorAudit?.notes || {}), ...output.audit.notes };
  output.resources.notes = { ...(priorAssessments?.notes || {}), ...output.resources.notes };
  const migratedIds = new Set(uniqueRecords(input).records.map(([id]) => id));
  const retainedFormal = Object.fromEntries(
    Object.entries(priorFormalCuration || {}).filter(([id]) => !migratedIds.has(id)),
  );
  output.formalCuration = { ...retainedFormal, ...output.formalCuration };
  const resourceToday = report.created_at.slice(0, 10);
  const validFormalResource = (resource) => {
    if (!resource || typeof resource !== "object" || Array.isArray(resource) || containsCredentialShape(resource)) return false;
    if (resource.type === "Agent Skill") {
      return validateVerifiedResource(resource, { today: resourceToday, maxAgeDays: 30 }).length === 0;
    }
    return Boolean(clean(resource.name) && clean(resource.type));
  };
  const mergedResources = new Map(
    [...(priorFormalResources?.resources || []), ...output.formalResources.resources]
      .filter(validFormalResource)
      .map((resource) => [
        clean(resource.id) || shaJson({
          name: clean(resource.name), type: clean(resource.type),
          repo: clean(resource.repo), download: clean(resource.download),
        }),
        resource,
      ]),
  );
  output.formalResources.resources = [...mergedResources.values()].sort((left, right) => (
    clean(left.id || left.name).localeCompare(clean(right.id || right.name))
  ));
  if (priorFormalResources) output.formalResources.verified_at = priorFormalResources.verified_at;
  validateReport(report, planMigration(input, { now: report.created_at, root }));
  const values = {
    organization_state: output.state, point_records: output.points, curation_audit: output.audit,
    resource_assessments: output.resources, formal_curation: output.formalCuration, formal_resources: output.formalResources,
  };
  await validatePlainTree(targets.point_records);
  await mkdir(dirname(privatePaths.point_staging), { recursive: true });
  if (await pathMetadata(targets.point_records)) {
    await cp(targets.point_records, privatePaths.point_staging, { recursive: true, errorOnExist: true, force: false });
  } else {
    await mkdir(privatePaths.point_staging);
  }
  for (const [id, point] of Object.entries(output.points)) {
    await rm(join(privatePaths.point_staging, `${id}.json`), { force: true });
    await writeFile(join(privatePaths.point_staging, `${id}.json`), `${JSON.stringify(point, null, 2)}\n`, {
      encoding: "utf8", flag: "wx",
    });
  }
  const participants = PARTICIPANTS.map(([name, key]) => key === "point_records"
    ? { name, target: targets[key], staging: privatePaths.point_staging }
    : { name, target: targets[key], content: `${JSON.stringify(values[key], null, 2)}\n` });
  for (const participant of participants) await mkdir(dirname(participant.target), { recursive: true });
  await mkdir(privatePaths.backup_directory, { recursive: true });
  for (const participant of participants) {
    const metadata = await pathMetadata(participant.target);
    if (metadata) {
      if (metadata.isSymbolicLink()) throw new Error("MIGRATION_TARGET_UNSAFE");
      const backup = join(privatePaths.backup_directory, `${participant.name}.backup`);
      if (metadata.isDirectory()) await cp(participant.target, backup, { recursive: true, errorOnExist: true, force: false });
      else if (metadata.isFile() && metadata.size <= 16 * 1024 * 1024) {
        await copyFile(participant.target, backup, fsConstants.COPYFILE_EXCL);
      } else throw new Error("MIGRATION_TARGET_UNSAFE");
    }
  }
  const manifest = {
    schema_version: 1, dry_run_id: report.dry_run_id, status: "prepared",
    participants: participants.map(({ name }) => name),
  };
  await atomicWriteTextFile(privatePaths.rollback_manifest, `${JSON.stringify(manifest)}\n`);
  await atomicWriteTextFile(privatePaths.dry_run_report, `${JSON.stringify(report)}\n`);
  participants.push({
    name: "rollback-manifest",
    target: privatePaths.rollback_manifest,
    content: `${JSON.stringify({ ...manifest, status: "committed" })}\n`,
  });
  await executeJournaledTransaction({
    root,
    id: transactionId,
    participants,
    failAt,
    beforeParticipant: async (name) => {
      const key = PARTICIPANTS.find(([participantName]) => participantName === name)?.[1];
      if (key && canonicalJson(livePathRevision(targets[key])) !== canonicalJson(confirmedLiveRevisions[key])) {
        throw migrationError("MIGRATION_LIVE_STATE_CHANGED");
      }
    },
  });
  return { schema_version: 1, outcome: "applied", dry_run_id: report.dry_run_id, counts: report.counts };
}

function parseArguments(argv) {
  const result = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") result.apply = true;
    else if (["--input", "--root", "--report", "--confirm", "--fault-at"].includes(argument)) {
      result[argument.slice(2).replaceAll("-", "_")] = argv[++index];
    } else throw new Error("MIGRATION_ARGUMENT_INVALID");
  }
  return result;
}
function privateReportPath(rootValue, reportValue) {
  const root = resolve(rootValue);
  const reportRoot = join(root, ".xhs-favorites", "migration-reports");
  const report = resolve(root, String(reportValue || ""));
  const rel = relative(reportRoot, report);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !rel.toLowerCase().endsWith(".json")) {
    throw new Error("MIGRATION_REPORT_PATH_UNSAFE");
  }
  return report;
}
async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args.input || !args.root) throw new Error("MIGRATION_ARGUMENT_INVALID");
  const metadata = await lstat(args.input);
  if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024) throw new Error("MIGRATION_INPUT_UNSAFE");
  let input;
  try {
    input = JSON.parse(await readFile(args.input, "utf8"));
  } catch {
    throw new Error("MIGRATION_INPUT_INVALID");
  }
  if (!args.apply) {
    const report = planMigration(input, { root: args.root });
    if (args.report) {
      const reportPath = privateReportPath(args.root, args.report);
      await assertSafePath(resolve(args.root), reportPath);
      await atomicWriteTextFile(reportPath, `${JSON.stringify(report)}\n`);
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  if (!args.report || !args.confirm) throw new Error("MIGRATION_CONFIRMATION_REQUIRED");
  const reportPath = privateReportPath(args.root, args.report);
  await assertSafePath(resolve(args.root), reportPath);
  let report;
  try {
    report = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {
    throw new Error("MIGRATION_REPORT_INVALID");
  }
  const result = await applyMigration(input, {
    root: args.root, report, confirm: args.confirm, failAt: args.fault_at,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    const rawCode = clean(error?.code || error?.message || "");
    const code = /^[A-Z][A-Z0-9_:-]{2,120}$/.test(rawCode) ? rawCode : "MIGRATION_FAILED";
    const next = error?.next_action === "rerun_dry_run" ? "; next: rerun dry-run" : "";
    process.stderr.write(`${code} phase: migration${next}\n`);
    process.exitCode = 1;
  });
}
