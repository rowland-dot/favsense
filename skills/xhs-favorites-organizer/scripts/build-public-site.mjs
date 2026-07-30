#!/usr/bin/env node

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectVideoEvidenceStats } from "./evidence-stats.mjs";
import { validateResourceIndex } from "../../../site/resource-utils.mjs";

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
  summaries: arg("summaries", resolve(workspace, "knowledge-base/05-Skills成果/Skills面板逐篇总结与总汇.md")),
  output: arg("output", resolve(workspace, "site/data/knowledge.json"))
};

const [catalog, curation] = await Promise.all([
  parseJson(paths.catalog),
  parseJson(paths.curation)
]);
const resourceRegistry = profile.features?.resource_index
  ? await parseJson(paths.resources)
  : { verified_at: "", resources: [] };

let summaryMarkdown = "";
try {
  summaryMarkdown = await readFile(paths.summaries, "utf8");
} catch {
  // The public repository ships generated data. A private Markdown vault is optional.
}

function plainText(markdown) {
  return markdown
    .replace(/\[([^\]]+)]\([^\)]+\)/g, "$1")
    .replace(/[*_`>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

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

function displayTitle(raw, entry, deepSummary, noteId) {
  const candidates = [raw.title, deepSummary?.heading, entry.tools?.[0], raw.description, entry.summary];
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

function extractDeepSummaries(markdown) {
  const sections = [];
  const pattern = /^## (\d{2})\.\s+([^\n]+)\n+([\s\S]*?)(?=^## \d{2}\.|^---$|^## 总汇：|(?![\s\S]))/gm;
  for (const match of markdown.matchAll(pattern)) {
    sections.push({ number: Number(match[1]), heading: plainText(match[2]), text: plainText(match[3]) });
  }
  return sections;
}

const deepSummaries = extractDeepSummaries(summaryMarkdown);
const curatedIds = Object.keys(curation);
const deepSummaryById = new Map(
  curatedIds.map((noteId, index) => [noteId, deepSummaries[index] || null])
);
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

const rawNotes = catalog.notes || {};
const evidenceStats = await collectVideoEvidenceStats(paths.videoAnalysis, config.public_stats, Object.keys(rawNotes));
const frameVerifiedNoteIds = new Set(evidenceStats.verifiedNoteIds);
const notes = Object.entries(rawNotes).map(([noteId, raw], index) => {
  const isCurated = Object.hasOwn(curation, noteId);
  const isFrameVerified = frameVerifiedNoteIds.has(noteId);
  const entry = isCurated ? curation[noteId] : fallbackEntry(raw);
  const matchedResources = [...new Map(
    (entry.tools || []).map(resourceForTool).filter(Boolean).map((resource) => [resource.name, resource])
  ).values()];
  const title = displayTitle(raw, entry, deepSummaryById.get(noteId), noteId);

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
    category: entry.category,
    themes: entry.themes || [],
    summary: entry.summary,
    deepSummary: deepSummaryById.get(noteId)?.text || entry.summary,
    action: String(entry.action || "").trim(),
    tools: entry.tools || [],
    kind: classify(entry, matchedResources),
    resources: matchedResources.map((resource) => resource.name),
    evidence: {
      method: isFrameVerified
        ? "已结合本地视频证据核验内容"
        : "目前依据原帖公开文字整理，视频内容尚未完整解读",
      locallyAvailable: isFrameVerified
    }
  };
});

const categories = [...new Set(notes.map((note) => note.category))].map((name) => ({
  name,
  count: notes.filter((note) => note.category === name).length
}));
const sourceBoards = [...new Set(notes.flatMap((note) => rawNotes[note.id]?.source_boards || []))];
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
const forbidden = [
  /xsec_token\s*=/i,
  /\/user\/profile\//i,
  /author_id/i,
  /["']?(?:cookie|cookies)["']?\s*[:=]\s*["'][^"']+/i
];
for (const pattern of forbidden) {
  if (pattern.test(serialized)) throw new Error(`Public data safety check failed: ${pattern}`);
}

await mkdir(dirname(paths.output), { recursive: true });
await writeFile(paths.output, serialized, "utf8");
console.log(JSON.stringify({ ok: true, notes: notes.length, resources: resources.length, output: paths.output }, null, 2));
