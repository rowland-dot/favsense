#!/usr/bin/env node

import { open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSensitiveText } from "./sensitive-data.mjs";
import { collectVideoEvidenceStats } from "./evidence-stats.mjs";
import { curationRevision } from "./curation-revision.mjs";
import {
  loadFormalPointSummary,
  loadCurationAudit,
  publicEvidenceStatus
} from "./curation-quality.mjs";
import { judgePublicNote, validateContentKindProfile } from "./public-judgement.mjs";
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
  candidates: arg("candidates", ""),
  diandianReport: arg("diandian-report", resolve(workspace, ".xhs-favorites/diandian-rerun-report.json")),
  output: arg("output", resolve(workspace, "site/data/knowledge.json"))
};
const promptVersionIndex = process.argv.indexOf("--diandian-prompt-version");
const explicitPromptVersion = promptVersionIndex >= 0
  ? String(process.argv[promptVersionIndex + 1] || "")
  : "";
if (explicitPromptVersion && !/^[a-f0-9]{64}$/.test(explicitPromptVersion)) {
  throw new Error("DianDian prompt version is invalid");
}
const expectedPromptVersion = explicitPromptVersion;
const buildVersionIndex = process.argv.indexOf("--build-version");
const buildVersion = buildVersionIndex >= 0 ? String(process.argv[buildVersionIndex + 1] || "") : "";
if (buildVersion && !/^[a-f0-9]{64}$/.test(buildVersion)) throw new Error("--build-version must be a 64-character lowercase SHA-256");
const effectiveDateIndex = process.argv.indexOf("--effective-date");
const effectiveDate = effectiveDateIndex >= 0 ? String(process.argv[effectiveDateIndex + 1] || "") : new Date().toISOString().slice(0, 10);
const effectiveDateValue = new Date(`${effectiveDate}T00:00:00.000Z`);
if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || Number.isNaN(effectiveDateValue.getTime()) || effectiveDateValue.toISOString().slice(0, 10) !== effectiveDate) throw new Error("--effective-date must be a real YYYY-MM-DD");

const [catalog, curation, sealedCandidates] = await Promise.all([
  parseJson(paths.catalog),
  parseJson(paths.curation),
  paths.candidates ? parseJson(paths.candidates) : {}
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

const TITLE_LIMIT = 52;

// The wording of a post's text before its topics, whole.
function cleanedPostText(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const beforeTopics = normalized.split("#")[0].trim();
  const withoutTopics = normalized
    .replace(/#[^#]*?\[话题\]#?/gi, " ")
    .replace(/\[[^\]]*话题[^\]]*\]/gi, " ")
    .replace(/#+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return beforeTopics || withoutTopics;
}

function titleFromText(value) {
  const title = cleanedPostText(value);
  return title.length > TITLE_LIMIT ? `${title.slice(0, TITLE_LIMIT - 1)}…` : title;
}

// What to type into the platform's search to find the original post: the post's own words, cut at the
// same limit as a title but without the ellipsis a title gets, since an ellipsis is not in the post.
function searchTextOf(raw) {
  return cleanedPostText(raw.title).slice(0, TITLE_LIMIT) || cleanedPostText(raw.description).slice(0, TITLE_LIMIT);
}

const tidySpaces = (value) => String(value || "").replace(/\s+/g, " ").trim();

function displayTitle(raw, verdict, noteId) {
  // A note shown from its reviewed entry shows the title the reviewer wrote, as written.
  const reviewedTitle = verdict.curated ? tidySpaces(verdict.entry.title) : "";
  if (reviewedTitle) return reviewedTitle;
  const candidates = [raw.title, raw.description, verdict.entry.summary];
  for (const candidate of candidates) {
    const title = titleFromText(candidate);
    if (title) return title;
  }
  const author = titleFromText(raw.author);
  return author ? `${author}的收藏` : `收藏条目 · ${noteId.slice(-6)}`;
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
  const type = String(field(raw, mapping.type || "type") || "未分类");
  const actions = (resourceIndex.actions || []).map((action) => ({
    label: action.label,
    url: String(field(raw, action.field) || "")
  })).filter((action) => action.url);
  const fieldsByType = resourceIndex.fields_by_type || {};
  const typeFields = Object.hasOwn(fieldsByType, type) ? fieldsByType[type] : [];
  if (!Array.isArray(typeFields)) throw new Error(`Resource fields for ${type} must be an array.`);
  const attributes = [...(resourceIndex.fields || []), ...typeFields].map((attribute) => ({
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
    id: String(raw.id || `resource-${index + 1}`),
    name,
    aliases: field(raw, mapping.aliases || "aliases") || [],
    type,
    description: String(field(raw, mapping.description || "description") || ""),
    metric: String(field(raw, mapping.metric || "metric") || ""),
    metricNumeric,
    metricIcon: String(field(raw, mapping.metric_icon || "metric_icon") || ""),
    attributes,
    actions
  };
});
const rawNotes = Object.fromEntries(
  Object.entries(catalog.notes || {})
);
async function loadDiandianRunStates(path, noteIds) {
  let handle;
  try {
    handle = await open(path, "r");
    const metadata = await handle.stat();
    if (metadata.size > 512 * 1024) throw new Error("DianDian rerun report is too large");
    const buffer = Buffer.alloc(metadata.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > metadata.size) throw new Error("DianDian rerun report changed while reading");
    const report = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, ""));
    const unresolved = Array.isArray(report?.unresolved)
      ? report.unresolved
      : Object.entries(report?.unresolved || {}).map(([note_id, entry]) => ({ ...entry, note_id }));
    if (unresolved.length > 5000) throw new Error("DianDian rerun report contains too many entries");
    const states = new Map();
    for (const entry of unresolved) {
      const noteId = String(entry?.note_id || "");
      if (!/^[a-f0-9]{24}$/.test(noteId) || !noteIds.has(noteId)) continue;
      const reason = String(entry?.reason || "");
      const summaryState = entry?.summary_status === "batch_aborted"
        || (!entry?.summary_status && ["batch-aborted", "summary-plan-abandoned"].includes(reason))
        ? "batch_aborted"
        : entry?.summary_status === "failed"
          ? "failed"
          : entry?.status === "unresolved"
            ? "stale"
            : "";
      if (!summaryState) continue;
      const summaryReasonCode = summaryState === "batch_aborted"
        ? "batch_aborted"
        : summaryState === "stale"
          ? "unknown_legacy"
        : reason === "transport-failed"
          ? "transport_failed"
          : reason === "safety-halt"
            ? "safety_signal"
            : "contract_invalid";
      states.set(noteId, { summaryState, summaryReasonCode });
    }
    return states;
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  } finally {
    await handle?.close();
  }
}
const diandianRunStateById = await loadDiandianRunStates(paths.diandianReport, new Set(Object.keys(rawNotes)));
const diandianById = new Map(Object.keys(rawNotes)
  .map((noteId) => [noteId, loadFormalPointSummary(paths.diandian, noteId, expectedPromptVersion)])
  .filter(([, summary]) => summary));
const evidenceStats = await collectVideoEvidenceStats(paths.videoAnalysis, config.public_stats, Object.keys(rawNotes));
const frameVerifiedNoteIds = new Set(evidenceStats.verifiedNoteIds);
const notes = Object.entries(rawNotes).map(([noteId, raw], index) => {
  const diandian = diandianById.get(noteId);
  const verdict = judgePublicNote({
    noteId,
    note: raw,
    curation,
    sealedCandidates,
    quality: {
      policy: curationQuality,
      audit: curationAudit,
      baselineIds: curationBaselineIds,
      baselineRevisions: curationBaselineRevisions
    },
    point: diandian,
    resourceRegistry,
    config,
    profile,
    effectiveDate,
    promptVersion: expectedPromptVersion
  });
  const isFrameVerified = frameVerifiedNoteIds.has(noteId);
  const title = displayTitle(raw, verdict, noteId);
  const auditEntry = curationAudit?.notes?.[noteId];
  const formalSummaryReasonCode = String(verdict.reasonCode || "");
  const runState = diandianRunStateById.get(noteId);
  const summaryState = runState?.summaryState || (diandian
    ? (["content_changed", "provider_changed", "prompt_changed", "summary_changed"].includes(formalSummaryReasonCode)
        ? "stale"
        : "captured")
    : "not_started");
  const summaryReasonCode = runState?.summaryReasonCode || formalSummaryReasonCode;
  const deepSummarySources = { point: "xiaohongshu-diandian", curation: "curation", metadata: "source-metadata" };

  return {
    id: noteId,
    number: index + 1,
    title,
    author: raw.author || "",
    sourceUrl: publicSourceUrl(searchTextOf(raw) || title, raw.author || ""),
    publishedAt: raw.published_at || "",
    likes: raw.liked_count || "",
    collections: raw.collected_count || "",
    mediaType: raw.type || "视频",
    category: verdict.category,
    categorySource: verdict.categorySource,
    categoryReason: verdict.categoryReason,
    suggestedCategory: verdict.suggestedCategory,
    sourceBoards: verdict.sourceBoards,
    themes: verdict.themes,
    summary: verdict.summary,
    deepSummary: verdict.deepSummary,
    deepSummarySource: deepSummarySources[verdict.summarySource],
    curationRevision: verdict.curated ? curationRevision(verdict.entry) : "",
    summaryStatus: verdict.curationStatus,
    curationStatus: verdict.curationStatus,
    summaryReason: verdict.reasonCode,
    summaryState,
    summaryReasonCode,
    ...(verdict.candidateKind ? { candidateKind: verdict.candidateKind } : {}),
    reviewedAt: verdict.accepted || auditEntry?.status === "unavailable"
      ? String(auditEntry?.reviewed_at || "")
      : "",
    action: verdict.action,
    tools: verdict.tools,
    kind: verdict.kind,
    resources: verdict.resourceNames,
    resourceIds: verdict.resourceIds,
    evidence: publicEvidenceStatus(noteId, curationAudit, isFrameVerified, verdict.accepted)
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
    buildVersion,
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
