#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { containsCredentialShape, normalizeSensitiveText } from "./sensitive-data.mjs";
import { collectVideoEvidenceStats } from "./evidence-stats.mjs";
import { resolveCategoryPolicy } from "./category-policy.mjs";
import { curationRevision } from "./curation-revision.mjs";
import {
  hasCompleteAcceptedAudit,
  isPublishableCuration,
  loadCurationAudit,
  publicEvidenceStatus
} from "./curation-quality.mjs";
import { validateResourceIndex } from "../../../site/resource-utils.mjs";
import { atomicWriteTextFile } from "./public-tree-policy.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspace = resolve(scriptDir, "../../..");

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? resolve(process.cwd(), process.argv[index + 1]) : fallback;
}

const parseJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const configPath = arg("config", resolve(workspace, "config/xhs-favorites.json"));
const config = await parseJson(configPath);
const configuredPath = (value, fallback) => resolve(workspace, value || fallback);
const profilePath = arg("profile", configuredPath(config.domain_profile, "config/domain-profiles/software.json"));
const profile = await parseJson(profilePath);
function validateContentKindProfile(value) {
  const allowedKinds = new Set(Object.keys(value.content_kinds || {}));
  if (!allowedKinds.size) throw new Error("domain_profile.content_kinds must not be empty");
  if (!value.classification || !String(value.classification.default || "").trim()) {
    throw new Error("domain_profile.classification.default is required");
  }
  const groups = [
    ["classification", value.classification?.default, value.classification?.rules || []],
    ["fallback", value.fallback?.default_kind, value.fallback?.kind_rules || []]
  ];
  for (const [label, defaultKind, rules] of groups) {
    if (defaultKind && !allowedKinds.has(defaultKind)) {
      throw new Error(`${label} default kind is not declared in content_kinds: ${defaultKind}`);
    }
    for (const rule of rules) {
      if (!allowedKinds.has(rule.kind)) {
        throw new Error(`${label} rule kind is not declared in content_kinds: ${rule.kind}`);
      }
      if (!rule.pattern) throw new Error(`${label} kind rule is missing a pattern`);
      new RegExp(rule.pattern, "i");
    }
  }
}
validateContentKindProfile(profile);
const resourceIndex = profile.resource_index || {};
if (profile.features?.resource_index) validateResourceIndex(resourceIndex);
const paths = {
  catalog: arg("catalog", resolve(workspace, ".xhs-favorites/catalog.json")),
  curation: arg("curation", configuredPath(config.curation_file, "skills/xhs-favorites-organizer/references/skills-board-curation.json")),
  profile: profilePath,
  resources: arg("resources", configuredPath(resourceIndex.registry_file, "skills/xhs-favorites-organizer/references/software-resources.json")),
  videoAnalysis: arg("video-analysis", resolve(workspace, ".xhs-favorites/video-analysis")),
  diandian: arg("diandian-dir", resolve(workspace, ".xhs-favorites/diandian-summaries")),
  output: arg("output", resolve(workspace, "site/data/knowledge.json"))
};

const [catalog, curation] = await Promise.all([
  parseJson(paths.catalog),
  parseJson(paths.curation)
]);
const {
  policy: curationQuality,
  audit: curationAudit,
  baselineIds: curationBaselineIds,
  baselineRevisions: curationBaselineRevisions
} = loadCurationAudit(workspace, config);
const resourceRegistry = profile.features?.resource_index
  ? await parseJson(paths.resources)
  : { verified_at: "", resources: [] };

function titleFromText(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const beforeTopics = normalized.split("#")[0].trim();
  const withoutTopics = normalized
    .replace(/#[^#]*?\[话题\]#?/gi, " ")
    .replace(/\[[^\]]*话题[^\]]*\]/gi, " ")
    .replace(/#+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const title = beforeTopics || withoutTopics;
  return title.length > 52 ? `${title.slice(0, 51)}…` : title;
}

function displayTitle(raw, entry, noteId) {
  const candidates = [raw.title, entry.tools?.[0], raw.description, entry.summary];
  for (const candidate of candidates) {
    const title = titleFromText(candidate);
    if (title) return title;
  }
  const author = titleFromText(raw.author);
  return author ? `${author}的收藏` : `收藏条目 · ${noteId.slice(-6)}`;
}

const STABLE_NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;

async function loadDiandianSummary(directory, noteId) {
  if (!STABLE_NOTE_ID.test(noteId)) return null;
  const base = resolve(directory);
  const target = resolve(base, `${noteId}.json`);
  if (dirname(target) !== base) return null;
  try {
    const metadata = await stat(target);
    if (!metadata.isFile() || metadata.size > 512 * 1024) return null;
    const record = JSON.parse(await readFile(target, "utf8"));
    if (
      !record
      || typeof record !== "object"
      || Array.isArray(record)
      || record.version !== 1
      || record.provider !== "xiaohongshu-diandian"
      || record.prompt !== "总结"
      || record.note_id !== noteId
      || containsCredentialShape(record)
    ) return null;
    const summary = String(record.summary || "").replace(/\r\n?/g, "\n").trim();
    if (!summary || summary.length > 200_000) return null;
    return {
      summary,
      sha256: createHash("sha256").update(summary, "utf8").digest("hex")
    };
  } catch {
    return null;
  }
}

function acceptsDiandianEvidence(review, summary, curationEntry) {
  const methods = Array.isArray(review?.evidence_methods) ? review.evidence_methods : [];
  const tools = Array.isArray(curationEntry?.tools) ? curationEntry.tools : [];
  return String(review?.status || "").trim() === "accepted"
    && /^\d{4}-\d{2}-\d{2}$/.test(String(review?.reviewed_at || "").trim().slice(0, 10))
    && review?.comments_checked === true
    && review?.claims_supported === true
    && Array.isArray(review?.unresolved_facts)
    && review.unresolved_facts.length === 0
    && methods.includes("comments")
    && methods.includes("diandian_summary")
    && (tools.length ? review.resource_status === "verified" : ["not_applicable", "unresolved"].includes(review?.resource_status))
    && /^[a-f0-9]{64}$/.test(String(review?.diandian_summary_sha256 || ""))
    && review.diandian_summary_sha256 === summary?.sha256;
}

function publicSourceUrl(title, author) {
  const params = new URLSearchParams({
    keyword: [title, author].filter(Boolean).join(" "),
    source: "web_search_result_notes"
  });
  return `https://www.xiaohongshu.com/search_result?${params.toString()}`;
}

const field = (value, path) => String(path || "").split(".").filter(Boolean).reduce((current, key) => current?.[key], value);
const rawResources = resourceRegistry[resourceIndex.collection || "resources"] || [];
const resources = rawResources.map((raw, index) => {
  const mapping = resourceIndex.mapping || {};
  const name = String(field(raw, mapping.name || "name") || "").trim();
  if (!name) throw new Error(`Resource ${index + 1} is missing a name.`);
  const actions = (resourceIndex.actions || []).map((action) => ({
    label: action.label,
    url: String(field(raw, action.field) || "")
  })).filter((action) => action.url);
  const attributes = (resourceIndex.fields || []).map((attribute) => ({
    label: String(attribute.label || ""),
    value: String(field(raw, attribute.field) || "")
  })).filter((attribute) => attribute.label && attribute.value);
  const rawMetricNumeric = field(raw, mapping.metric_numeric || "metric_numeric");
  const metricNumeric = rawMetricNumeric !== null
    && rawMetricNumeric !== undefined
    && String(rawMetricNumeric).trim() !== ""
    && Number.isFinite(Number(rawMetricNumeric))
    ? Number(rawMetricNumeric)
    : null;
  return {
    id: `resource-${index + 1}`,
    name,
    aliases: field(raw, mapping.aliases || "aliases") || [],
    type: String(field(raw, mapping.type || "type") || "未分类"),
    description: String(field(raw, mapping.description || "description") || ""),
    metric: String(field(raw, mapping.metric || "metric") || ""),
    metricNumeric,
    metricIcon: String(field(raw, mapping.metric_icon || "metric_icon") || ""),
    attributes,
    actions
  };
});
const resourceByAlias = new Map();
for (const resource of resources) {
  for (const alias of [resource.name, ...(resource.aliases || [])]) {
    resourceByAlias.set(String(alias).toLocaleLowerCase("zh-CN"), resource);
  }
}

function resourceForTool(tool) {
  return resourceByAlias.get(String(tool).toLocaleLowerCase("zh-CN")) || null;
}

function classify(entry, matchedResources) {
  const allowedKinds = new Set(Object.keys(profile.content_kinds || {}));
  if (entry.kind !== undefined) {
    if (!allowedKinds.has(entry.kind)) {
      throw new Error(`Invalid content kind: ${entry.kind}. Expected one of: ${[...allowedKinds].join(", ")}.`);
    }
    return entry.kind;
  }
  const text = `${entry.summary} ${entry.action} ${entry.themes.join(" ")}`;
  const resourceTypes = matchedResources.map((resource) => resource.type).join(" ");
  for (const rule of profile.classification?.rules || []) {
    const source = ["resource_type", "project_type"].includes(rule.source) ? resourceTypes : text;
    if (new RegExp(rule.pattern, "i").test(source)) return rule.kind;
  }
  return profile.classification.default;
}

function fallbackEntry(raw) {
  const text = [raw.title, raw.description, raw.tags].filter(Boolean).join(" ");
  let category = profile.fallback?.default_category || "未分类";
  let kind = profile.fallback?.default_kind
    || profile.classification.default;
  for (const rule of profile.fallback?.rules || []) {
    if (new RegExp(rule.pattern, "i").test(text)) {
      category = rule.category;
      break;
    }
  }
  const fallbackKindRules = profile.fallback?.kind_rules?.length
    ? profile.fallback.kind_rules
    : (profile.classification?.rules || []).filter((rule) => !["resource_type", "project_type"].includes(rule.source));
  for (const rule of fallbackKindRules) {
    if (new RegExp(rule.pattern, "i").test(text)) {
      kind = rule.kind;
      break;
    }
  }
  if (!Object.hasOwn(profile.content_kinds || {}, kind)) {
    throw new Error(`Invalid fallback content kind: ${kind}`);
  }
  const excerpt = String(raw.description || raw.title || "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    category,
    themes: [],
    summary: excerpt
      ? excerpt.slice(0, 240)
      : "这条收藏已收录，完整内容尚未解读。",
    action: "",
    tools: [],
    kind
  };
}

const rawNotes = Object.fromEntries(
  Object.entries(catalog.notes || {})
);
const diandianById = new Map((await Promise.all(
  Object.keys(rawNotes).map(async (noteId) => [noteId, await loadDiandianSummary(paths.diandian, noteId)])
)).filter(([, summary]) => summary));
const evidenceStats = await collectVideoEvidenceStats(paths.videoAnalysis, config.public_stats, Object.keys(rawNotes));
const frameVerifiedNoteIds = new Set(evidenceStats.verifiedNoteIds);
const notes = Object.entries(rawNotes).map(([noteId, raw], index) => {
  const isCurated = Object.hasOwn(curation, noteId)
    && isPublishableCuration(
      noteId,
      raw,
      curation,
      curationQuality,
      curationAudit,
      curationBaselineIds,
      curationBaselineRevisions,
      { config, resources: resourceRegistry }
    );
  const isFrameVerified = frameVerifiedNoteIds.has(noteId);
  const entry = isCurated ? curation[noteId] : fallbackEntry(raw);
  const acceptedAuditIsCurrent = isCurated && hasCompleteAcceptedAudit(
    noteId,
    raw,
    entry,
    curationAudit,
    { config, resources: resourceRegistry }
  );
  const categoryPolicy = resolveCategoryPolicy({
    entry,
    note: raw,
    config,
    profile,
    entryOrigin: isCurated ? "curation" : "content_rule"
  });
  const matchedResources = [...new Map(
    (entry.tools || []).map(resourceForTool).filter(Boolean).map((resource) => [resource.name, resource])
  ).values()];
  const title = displayTitle(raw, entry, noteId);
  const diandian = diandianById.get(noteId);
  const auditEntry = curationAudit?.notes?.[noteId];
  const aiEvidenceAccepted = acceptsDiandianEvidence(auditEntry, diandian, entry);
  const publicDiandian = isCurated && aiEvidenceAccepted ? diandian : null;

  return {
    id: noteId,
    number: index + 1,
    title,
    author: raw.author || "",
    sourceUrl: publicSourceUrl(title, raw.author || ""),
    publishedAt: raw.published_at || "",
    likes: raw.liked_count || "",
    collections: raw.collected_count || "",
    mediaType: raw.type || "视频",
    category: categoryPolicy.category,
    categorySource: categoryPolicy.categorySource,
    categoryReason: categoryPolicy.categoryReason,
    suggestedCategory: categoryPolicy.suggestedCategory,
    sourceBoards: categoryPolicy.sourceBoards,
    themes: categoryPolicy.themes,
    summary: entry.summary,
    deepSummary: publicDiandian?.summary || entry.summary,
    deepSummarySource: publicDiandian ? "xiaohongshu-diandian" : (isCurated ? "curation" : "source-metadata"),
    curationRevision: isCurated ? curationRevision(entry) : "",
    action: String(entry.action || "").trim(),
    tools: entry.tools || [],
    kind: classify(entry, matchedResources),
    resources: matchedResources.map((resource) => resource.name),
    evidence: publicEvidenceStatus(noteId, curationAudit, isFrameVerified, acceptedAuditIsCurrent)
  };
});

const categories = [...new Set(notes.map((note) => note.category))].map((name) => ({
  name,
  count: notes.filter((note) => note.category === name).length
}));
const sourceBoards = [...new Set(notes.flatMap((note) => note.sourceBoards || []))];
const fallbackBoard = config.boards.find((board) => board.id === config.legacy_source_board_id)
  || config.boards.find((board) => board.enabled);
const visibleBoards = sourceBoards.length ? sourceBoards : [fallbackBoard?.name].filter(Boolean);
const frameEvidenceCount = evidenceStats.frameEvidenceCount;
const verifiedNoteCount = notes.filter((note) => note.evidence.locallyAvailable).length;

const output = {
  meta: {
    title: profile.presentation?.title || "小红书收藏知识工作台",
    description: profile.presentation?.description || "把收藏转成可搜索、可核验、可行动的知识资产。",
    generatedAt: new Date().toISOString(),
    source: "xiaohongshu",
    sourceBoards: visibleBoards,
    sourceBoard: visibleBoards.join("、"),
    profileId: profile.id,
    profileLabel: profile.label,
    categoryStrategy: profile.classification?.category_strategy || "source-board-first",
    hero: profile.presentation?.hero || {},
    noteCount: notes.length,
    verifiedNoteCount,
    categoryCount: categories.length,
    resourceCount: resources.length,
    resourceIndexEnabled: Boolean(profile.features?.resource_index),
    resourcesVerifiedAt: resourceRegistry.verified_at || "",
    resourceIndex,
    frameEvidenceCount,
    evidenceStatsAutoUpdated: evidenceStats.derivedFromLocalEvidence,
    videoMethod: `${verifiedNoteCount} 条收藏已完成视频内容核验；其余条目目前按原帖公开文字展示`,
    kindLabels: profile.content_kinds || {}
  },
  categories,
  notes,
  resources
};

const serialized = `${JSON.stringify(output, null, 2)}\n`;
const normalizedSerialized = normalizeSensitiveText(serialized);
const forbidden = [
  /xsec_token\s*=/i,
  /\/user\/profile\//i,
  /author_id/i,
  /["']?(?:cookie|cookies)["']?\s*[:=]\s*["'][^"']+/i
];
for (const pattern of forbidden) {
  if (pattern.test(normalizedSerialized)) throw new Error(`Public data safety check failed: ${pattern}`);
}

const privateIdentifiers = new Set([
  config.legacy_source_board_id,
  ...(config.boards || []).map((board) => board?.id),
]);
try {
  const profileUrl = new URL(String(config.profile_url || ""));
  const profileId = profileUrl.pathname.match(/^\/user\/profile\/([^/]+)$/)?.[1];
  if (profileId) privateIdentifiers.add(profileId);
} catch { /* an invalid profile URL is validated by the collection workflow */ }
for (const identifier of privateIdentifiers) {
  const privateValue = String(identifier || "").trim();
  if (privateValue && normalizedSerialized.includes(normalizeSensitiveText(privateValue))) {
    throw new Error("Public data safety check failed: private source identifier");
  }
}

await atomicWriteTextFile(paths.output, serialized);
console.log(JSON.stringify({ ok: true, notes: notes.length, resources: resources.length, output: paths.output }, null, 2));
