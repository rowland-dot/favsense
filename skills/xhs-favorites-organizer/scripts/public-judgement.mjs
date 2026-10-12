// The one place that decides what is public about a note. Both formal builders (the Obsidian
// knowledge base and the web knowledge.json) hand a note's inputs to judgePublicNote and only
// lay the verdict out; neither judges on its own.

import { resolveCategoryPolicy } from "./category-policy.mjs";
import {
  currentFormalRevisions,
  formalContentKind,
  formalCurationDecision,
  isPublishableCuration,
  sealedCandidateFor,
} from "./curation-quality.mjs";
import { confirmedSkillResource, verificationMaxAgeDays } from "./resource-quality.mjs";

// Both builders check the profile once at start-up; the judgement relies on it being well formed.
export function validateContentKindProfile(value) {
  const allowedKinds = new Set(Object.keys(value.content_kinds || {}));
  if (!allowedKinds.size) throw new Error("domain_profile.content_kinds must not be empty");
  if (!value.classification || !String(value.classification.default || "").trim()) {
    throw new Error("domain_profile.classification.default is required");
  }
  const groups = [
    ["classification", value.classification?.default, value.classification?.rules || []],
    ["fallback", value.fallback?.default_kind, value.fallback?.kind_rules || []],
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

const field = (value, path) => String(path || "").split(".").filter(Boolean).reduce((current, key) => current?.[key], value);
const lowered = (value) => String(value).toLocaleLowerCase("zh-CN");

// Resources are found by name or alias, read through the profile's field mapping.
function resourceLookup(profile, registry) {
  const index = profile.resource_index || {};
  const mapping = index.mapping || {};
  const byAlias = new Map();
  for (const raw of registry?.[index.collection || "resources"] || []) {
    const resource = {
      raw,
      id: String(raw.id ?? ""),
      name: String(field(raw, mapping.name || "name") || "").trim(),
      type: String(field(raw, mapping.type || "type") || "未分类"),
    };
    for (const alias of [resource.name, ...(field(raw, mapping.aliases || "aliases") || [])]) {
      byAlias.set(lowered(alias), resource);
    }
  }
  return (tools) => (tools || []).map((tool) => byAlias.get(lowered(tool))).filter(Boolean);
}

function classify(profile, entry, matchedResources) {
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

// What the note says about itself, for a note that has no publishable reviewed entry.
function fallbackEntry(note, profile) {
  const text = [note.title, note.description, note.tags].filter(Boolean).join(" ");
  let category = profile.fallback?.default_category || "未分类";
  let kind = profile.fallback?.default_kind || profile.classification.default;
  for (const rule of profile.fallback?.rules || []) {
    if (new RegExp(rule.pattern, "i").test(text)) {
      category = rule.category;
      break;
    }
  }
  const kindRules = profile.fallback?.kind_rules?.length
    ? profile.fallback.kind_rules
    : (profile.classification?.rules || []).filter((rule) => !["resource_type", "project_type"].includes(rule.source));
  for (const rule of kindRules) {
    if (new RegExp(rule.pattern, "i").test(text)) {
      kind = rule.kind;
      break;
    }
  }
  if (!Object.hasOwn(profile.content_kinds || {}, kind)) {
    throw new Error(`Invalid fallback content kind: ${kind}`);
  }
  const excerpt = String(note.description || note.title || "").replace(/\s+/g, " ").trim();
  return {
    category,
    themes: [],
    summary: excerpt ? excerpt.slice(0, 240) : "这条收藏已收录，完整内容尚未解读。",
    action: "",
    tools: [],
    kind,
  };
}

export function judgePublicNote({
  noteId,
  note,
  curation,
  sealedCandidates,
  quality,
  point = null,
  resourceRegistry,
  config,
  profile,
  effectiveDate,
  promptVersion = "",
}) {
  // Resolved for every note, so a broken limit is reported whatever kind the note turns out to be.
  const maxAgeDays = verificationMaxAgeDays(profile);
  const matchResources = resourceLookup(profile, resourceRegistry);
  // The entry the note is judged from: its reviewed entry, else the candidate sealed for it, else
  // what the note says about itself.
  const candidateEntry = Object.hasOwn(curation, noteId)
    ? curation[noteId]
    : (sealedCandidateFor(sealedCandidates, noteId) ?? fallbackEntry(note, profile));
  const candidateResources = matchResources(candidateEntry.tools);
  const candidateKind = classify(profile, candidateEntry, candidateResources);
  const confirmedResource = candidateKind === "Skill"
    ? confirmedSkillResource(candidateResources.map((resource) => resource.raw), {
      today: effectiveDate,
      maxAgeDays,
    })
    : null;
  const currentRevisions = currentFormalRevisions(note, candidateEntry, confirmedResource, promptVersion);
  const curated = isPublishableCuration(
    noteId,
    note,
    curation,
    quality.policy,
    quality.audit,
    quality.baselineIds,
    quality.baselineRevisions,
    { config, resources: resourceRegistry, ...(currentRevisions ? { currentRevisions } : {}) }
  );
  // What may be shown: the reviewed entry when it is publishable, otherwise only what the note itself says.
  const entry = curated ? candidateEntry : fallbackEntry(note, profile);
  const categoryPolicy = resolveCategoryPolicy({
    entry,
    note,
    config,
    profile,
    entryOrigin: curated ? "curation" : "content_rule",
  });
  const matchedResources = [...new Map(matchResources(entry.tools).map((resource) => [resource.name, resource])).values()];
  const auditEntry = quality.audit?.notes?.[noteId];
  const decision = formalCurationDecision({
    publishable: curated,
    auditEntry,
    currentRevisions,
    point,
    kind: candidateKind,
    resource: confirmedResource,
  });
  const curationStatus = decision.accepted
    ? "accepted"
    : (auditEntry?.status === "rejected"
        ? "rejected"
        : (auditEntry?.status === "unavailable" ? "unavailable" : "pending_review"));
  const kind = formalContentKind(
    profile,
    candidateKind === "Skill" ? candidateKind : classify(profile, entry, matchedResources),
    decision.accepted && Boolean(confirmedResource)
  );
  const projectedResources = candidateKind === "Skill"
    ? matchedResources.filter((resource) => decision.resource_ids.includes(resource.id))
    : matchedResources;
  const summary = String(entry.summary || "");
  const pointSummary = decision.summary_source === "point" ? point?.summary : "";
  return {
    accepted: decision.accepted,
    reasonCode: decision.reason_code,
    curationStatus,
    curated,
    kind,
    candidateKind: candidateKind === "Skill" && kind !== "Skill" ? candidateKind : "",
    resourceIds: decision.resource_ids,
    resourceNames: projectedResources.map((resource) => resource.name),
    tools: candidateKind === "Skill" ? projectedResources.map((resource) => resource.name) : entry.tools || [],
    skillResource: decision.accepted ? confirmedResource : null,
    summarySource: pointSummary ? "point" : (curated ? "curation" : "metadata"),
    summary,
    deepSummary: pointSummary || summary,
    action: String(entry.action || "").trim(),
    category: categoryPolicy.category,
    categorySource: categoryPolicy.categorySource,
    categoryReason: categoryPolicy.categoryReason,
    suggestedCategory: categoryPolicy.suggestedCategory,
    sourceBoards: categoryPolicy.sourceBoards,
    themes: categoryPolicy.themes,
    entry,
  };
}
