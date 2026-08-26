#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { curationRevision } from "./curation-revision.mjs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const GENERIC_TEXT = [
  /内容解读完成后/,
  /这里会直接呈现/,
  /相关项目和具体用法/,
  /进一步了解|继续关注|按需使用|可以尝试$/,
  /尚未完整解读|待确认/
];
const EVIDENCE_METHODS = new Set([
  "description", "comments", "audio_transcript", "visual_ocr", "image_ocr", "image_review",
  "video_analysis", "diandian_summary", "official_source"
]);

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function readJson(filename, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filename), "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${label} could not be read: ${error.message}`);
  }
}

function date(value, label) {
  const normalized = clean(value).slice(0, 10);
  if (!ISO_DATE.test(normalized) || Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  return normalized;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key || "end"}`);
    result[key.slice(2)] = value;
  }
  for (const required of ["catalog", "config", "curation", "resources", "audit", "report"]) {
    if (!result[required]) throw new Error(`--${required} is required`);
  }
  if (!result.scope && (!result.from || !result.to)) {
    throw new Error("either --scope or both --from and --to are required");
  }
  return result;
}

function aliasesFor(resource) {
  return [resource.name, ...(Array.isArray(resource.aliases) ? resource.aliases : [])]
    .map((value) => clean(value).toLowerCase())
    .filter(Boolean);
}

function validateResource(resource, kind, errors) {
  const prefix = `resource:${clean(resource?.name) || "<unnamed>"}`;
  if (!resource) return errors.push(`${prefix}:missing`);
  if (!clean(resource.type)) errors.push(`${prefix}:type-missing`);
  if (kind === "Skill") {
    if (!/skill/i.test(clean(resource.type))) errors.push(`${prefix}:not-a-skill`);
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/i.test(clean(resource.repo))) errors.push(`${prefix}:github-repo-missing`);
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/archive\/refs\/heads\/[^/]+\.zip$/i.test(clean(resource.download))) errors.push(`${prefix}:zip-missing`);
    if (!clean(resource.license)) errors.push(`${prefix}:license-missing`);
    if (!clean(resource.skill_manifest)) errors.push(`${prefix}:skill-manifest-missing`);
    if (!ISO_DATE.test(clean(resource.verified_at))) errors.push(`${prefix}:verified-at-missing`);
  }
}

export function auditCuration({ catalog, config, curation, resources, audit, from, to, scopeIds }) {
  const notes = catalog.notes || catalog;
  const resourceItems = Array.isArray(resources) ? resources : resources.resources || [];
  const resourceLookup = new Map();
  for (const resource of resourceItems) for (const alias of aliasesFor(resource)) resourceLookup.set(alias, resource);
  const requestedIds = Array.isArray(scopeIds) ? [...new Set(scopeIds.map(clean).filter(Boolean))] : null;
  const scoped = requestedIds
    ? requestedIds.filter((noteId) => Object.hasOwn(notes, noteId)).map((noteId) => [noteId, notes[noteId]])
    : Object.entries(notes).filter(([, note]) => {
      const published = clean(note.published_at).slice(0, 10);
      return ISO_DATE.test(published) && published >= from && published <= to;
    });
  const report = {
    version: 1,
    scope: requestedIds ? { mode: "explicit-note-ids", requested: requestedIds.length } : { mode: "published-date", from, to },
    totals: { scoped: scoped.length, accepted: 0, pending: 0, rejected: 0, invalid: 0 },
    notes: {}
  };
  const fatal = [];

  if (requestedIds) {
    for (const noteId of requestedIds) {
      if (!Object.hasOwn(notes, noteId)) fatal.push(`${noteId}: scope-note-missing-from-catalog`);
    }
  }

  for (const [noteId, note] of scoped) {
    const review = audit.notes?.[noteId];
    const entry = curation[noteId];
    const errors = [];
    if (!review) {
      errors.push("audit-missing");
      report.notes[noteId] = { status: "invalid", errors };
      report.totals.invalid += 1;
      fatal.push(`${noteId}: ${errors.join(", ")}`);
      continue;
    }
    const status = clean(review.status);
    if (!["accepted", "pending", "rejected"].includes(status)) errors.push("status-invalid");
    if (!ISO_DATE.test(clean(review.reviewed_at))) errors.push("reviewed-at-missing");
    const methods = Array.isArray(review.evidence_methods) ? [...new Set(review.evidence_methods.map(clean).filter(Boolean))] : [];
    for (const method of methods) if (!EVIDENCE_METHODS.has(method)) errors.push(`evidence-method-invalid:${method}`);

    if (status === "accepted") {
      if (methods.includes("diandian_summary") && !/^[a-f0-9]{64}$/.test(clean(review.diandian_summary_sha256))) {
        errors.push("diandian-summary-hash-missing");
      }
      if (review.comments_checked !== true) errors.push("comments-not-checked");
      if (!methods.includes("comments")) errors.push("comment-evidence-method-missing");
      if (!entry) errors.push("accepted-curation-missing");
      if (entry && clean(review.curation_sha256) !== curationRevision(entry)) {
        errors.push("curation-revision-missing-or-stale");
      }
      if (review.claims_supported !== true) errors.push("claims-not-supported");
      if ((review.unresolved_facts || []).length) errors.push("accepted-has-unresolved-facts");
      if (note.type === "视频" && !methods.some((method) => ["audio_transcript", "visual_ocr", "video_analysis", "diandian_summary"].includes(method))) {
        errors.push("video-body-evidence-missing");
      }
      if (note.type === "图文" && !methods.some((method) => ["image_ocr", "image_review", "diandian_summary"].includes(method))) {
        errors.push("image-text-evidence-missing");
      }
      if (entry) {
        const title = clean(entry.title || note.title);
        if (!title || /未命名收藏/.test(title)) errors.push("title-invalid");
        if (clean(entry.summary).length < 32 || GENERIC_TEXT.some((pattern) => pattern.test(clean(entry.summary)))) errors.push("summary-not-specific");
        if (clean(entry.action).length < 16 || GENERIC_TEXT.some((pattern) => pattern.test(clean(entry.action)))) errors.push("action-not-specific");
        if (!Array.isArray(entry.themes) || entry.themes.length < 1) errors.push("themes-missing");
        if (!Array.isArray(entry.tools)) errors.push("tools-invalid");
        if (entry.category_override === true && (!clean(entry.category) || !clean(entry.category_reason))) {
          errors.push("category-override-unexplained");
        }
        const kind = clean(entry.kind);
        if (!kind) errors.push("kind-missing");
        const tools = Array.isArray(entry.tools) ? entry.tools : [];
        if (tools.length && review.resource_status !== "verified") errors.push("resource-status-not-verified");
        if (!tools.length && !["not_applicable", "unresolved"].includes(review.resource_status)) errors.push("resource-status-invalid");
        for (const tool of tools) {
          const resource = resourceLookup.get(clean(tool).toLowerCase());
          if (!resource) errors.push(`resource-not-indexed:${clean(tool)}`);
          else validateResource(resource, kind, errors);
        }
        if (kind === "Skill" && !tools.length) errors.push("skill-without-resource");
      }
    } else {
      if (!clean(review.reason)) errors.push(`${status}-reason-missing`);
      if (entry) errors.push(`${status}-must-not-be-published`);
    }

    const finalStatus = errors.length ? "invalid" : status;
    report.notes[noteId] = { status: finalStatus, errors };
    if (errors.length) {
      report.totals.invalid += 1;
      fatal.push(`${noteId}: ${errors.join(", ")}`);
    } else {
      report.totals[status] += 1;
    }
  }
  return { report, fatal };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const from = options.from ? date(options.from, "from") : undefined;
  const to = options.to ? date(options.to, "to") : undefined;
  if (from && to && from > to) throw new Error("from must not be later than to");
  const scope = options.scope ? readJson(options.scope, "scope") : null;
  if (scope && !Array.isArray(scope.note_ids)) throw new Error("scope.note_ids must be an array");
  const result = auditCuration({
    catalog: readJson(options.catalog, "catalog"),
    config: readJson(options.config, "config"),
    curation: readJson(options.curation, "curation"),
    resources: readJson(options.resources, "resources"),
    audit: readJson(options.audit, "audit"),
    from,
    to,
    scopeIds: scope?.note_ids
  });
  const output = path.resolve(options.report);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(result.report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(result.report.totals)}\n`);
  if (result.fatal.length) {
    for (const item of result.fatal) process.stderr.write(`${item}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
