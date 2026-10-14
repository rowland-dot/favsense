#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeSensitiveText } from "./sensitive-data.mjs";
import { collectVideoEvidenceStats } from "./evidence-stats.mjs";
import { loadFormalPointSummary, loadUnreachableNoteIds, sealedCandidateFor } from "./curation-quality.mjs";
import { judgePublicNote, validateContentKindProfile } from "./public-judgement.mjs";
import { cardCounts, cardText, cardTitle, postBody, replyState } from "./card-content.mjs";
import { loadExtractedText } from "./extracted-text.mjs";
import { loadDamagedReplies } from "./damaged-replies.mjs";
import { validateResourceIndex } from "../../../site/resource-utils.mjs";
import { PUBLIC_FORBIDDEN, atomicWriteTextFile } from "./public-tree-policy.mjs";

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
  // No default: a build that names no list treats no reply as damaged, so a test or a direct run never reads the private folder.
  damaged: arg("damaged-replies", ""),
  output: arg("output", resolve(workspace, "site/data/knowledge.json"))
};
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
// Only the audit's list of unreachable posts is read, and only to pick one source-line label.
const unreachableIds = loadUnreachableNoteIds(workspace, config);
const resourceRegistry = profile.features?.resource_index
  ? await parseJson(paths.resources)
  : { verified_at: "", resources: [] };

// The post itself, by its token-free address (spec LINK-02: the owner confirmed on 2026-10-14 that it opens the
// post). The signed share link is never public; the public-file check still refuses xsec_token.
const postUrl = (noteId) => `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`;

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
const damagedReplies = paths.damaged ? loadDamagedReplies(paths.damaged) : new Map();
const evidenceStats = await collectVideoEvidenceStats(paths.videoAnalysis, config.public_stats, Object.keys(rawNotes));
const notes = Object.entries(rawNotes).map(([noteId, raw], index) => {
  // The add-on: the reviewed curation entry, else the candidate sealed for the note. It never decides whether
  // the card shows in full or what its title and text are.
  const addOn = Object.hasOwn(curation, noteId) ? curation[noteId] : sealedCandidateFor(sealedCandidates, noteId);
  const verdict = judgePublicNote({ noteId, note: raw, addOn, unreachableIds, resourceRegistry, config, profile, effectiveDate });
  const body = postBody(raw.description);
  // The reply is read whatever prompt version saved it and whichever version of the post it was made for.
  const point = loadFormalPointSummary(paths.diandian, noteId);
  const state = replyState(noteId, point, damagedReplies);
  const text = cardText({ body, point, state, extracted: loadExtractedText(paths.videoAnalysis, noteId, raw.type) });
  const title = cardTitle({ title: raw.title, body, author: raw.author, noteId });

  return {
    id: noteId,
    number: index + 1,
    title,
    author: raw.author || "",
    sourceUrl: postUrl(noteId),
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
    mainText: text.mainText,
    mainSource: text.mainSource,
    replyDamaged: state === "damaged",
    postUnreachable: verdict.postUnreachable,
    extracted: text.extractedSection,
    tools: verdict.tools,
    unverifiedTools: verdict.unverifiedTools,
    kind: verdict.kind,
    resources: verdict.resourceNames,
    resourceIds: verdict.resourceIds
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
    ...cardCounts(notes),
    categoryCount: categories.length,
    resourceCount: resources.length,
    resourceIndexEnabled: Boolean(profile.features?.resource_index),
    resourcesVerifiedAt: resourceRegistry.verified_at || "",
    resourceIndex,
    frameEvidenceCount,
    evidenceStatsAutoUpdated: evidenceStats.derivedFromLocalEvidence,
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
  /["']?(?:cookie|cookies)["']?\s*[:=]\s*["'][^"']+/i,
  // Everything the publisher refuses in the data file too: the whole post text and the transcripts are public now,
  // so a build that passed here and was refused at publish time would waste the run's one publish.
  ...PUBLIC_FORBIDDEN
];

// Where the first match sits, so the person who has to fix it knows which note and field, without the matched text.
function locateUnsafe(pattern) {
  for (const note of notes) {
    for (const [key, value] of Object.entries(note)) {
      const texts = key === "extracted" && value ? [value.text] : Array.isArray(value) ? value : [value];
      if (texts.some((text) => typeof text === "string" && pattern.test(normalizeSensitiveText(text)))) {
        return ` (note ${note.id}, field ${key === "extracted" ? "extracted.text" : key})`;
      }
    }
  }
  return "";
}
for (const pattern of forbidden) {
  if (pattern.test(normalizedSerialized)) throw new Error(`Public data safety check failed: ${pattern}${locateUnsafe(pattern)}`);
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
    const where = notes.find((note) => JSON.stringify(note).includes(privateValue) || normalizeSensitiveText(JSON.stringify(note)).includes(normalizeSensitiveText(privateValue)));
    throw new Error(`Public data safety check failed: private source identifier${where ? ` (note ${where.id})` : ""}`);
  }
}

await atomicWriteTextFile(paths.output, serialized);
console.log(JSON.stringify({ ok: true, notes: notes.length, resources: resources.length, output: paths.output }, null, 2));
