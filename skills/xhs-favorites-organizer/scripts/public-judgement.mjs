// The one place that decides a note's category, content kind, resources and tools. The web builder
// (knowledge.json) hands a note's inputs to judgePublicNote and lays the verdict out. It does not decide
// whether a card is shown in full: every card is built from its own text (see card-content.mjs).

import { resolveCategoryPolicy } from "./category-policy.mjs";
import { formalContentKind } from "./curation-quality.mjs";
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
  const text = `${entry.summary ?? ""} ${entry.action ?? ""} ${(entry.themes || []).join(" ")}`;
  const resourceTypes = matchedResources.map((resource) => resource.type).join(" ");
  for (const rule of profile.classification?.rules || []) {
    const source = ["resource_type", "project_type"].includes(rule.source) ? resourceTypes : text;
    if (new RegExp(rule.pattern, "i").test(source)) return rule.kind;
  }
  return profile.classification.default;
}

/// What the note says about itself, for a note that has no add-on. Category and kind only: the card's text
// never comes from here.
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
  return { category, themes: [], summary: "", action: "", tools: [], kind };
}

// What the add-on (a reviewed curation entry, else the candidate sealed for the note) may say about a note: its
// content kind, category suggestion, topics and tools. Whether the card is shown in full is not decided here.
export function judgePublicNote({
  noteId,
  note,
  addOn = null,
  unreachableIds = new Set(),
  resourceRegistry,
  config,
  profile,
  effectiveDate,
}) {
  // Resolved for every note, so a broken limit is reported whatever kind the note turns out to be.
  const maxAgeDays = verificationMaxAgeDays(profile);
  const matchResources = resourceLookup(profile, resourceRegistry);
  const entry = addOn ?? fallbackEntry(note, profile);
  const matched = [...new Map(matchResources(entry.tools).map((resource) => [resource.name, resource])).values()];
  const candidateKind = classify(profile, entry, matched);
  // A Skill is only a Skill with exactly one current, complete, verified official resource.
  const confirmed = candidateKind === "Skill"
    ? confirmedSkillResource(matched.map((resource) => resource.raw), { today: effectiveDate, maxAgeDays })
    : null;
  const category = resolveCategoryPolicy({
    entry,
    note,
    config,
    profile,
    entryOrigin: addOn ? "curation" : "content_rule",
  });
  const actionFields = (profile.resource_index?.actions || []).map((action) => action.field);
  const hasOfficialSource = (resource) => actionFields.some((name) => String(field(resource.raw, name) || "").trim());
  // A tool is verified when it matches a resource with an official link; a Skill candidate only when it is
  // the one confirmed Skill resource.
  const verified = (tool) => {
    const found = matchResources([tool]);
    return candidateKind === "Skill"
      ? Boolean(confirmed) && found.some((resource) => resource.id === confirmed.id)
      : found.some(hasOfficialSource);
  };
  const tools = [...new Set((entry.tools || []).map((tool) => String(tool).trim()).filter(Boolean))];
  const shown = candidateKind === "Skill" ? matched.filter((resource) => confirmed && resource.id === confirmed.id) : matched;
  return {
    kind: formalContentKind(profile, candidateKind, Boolean(confirmed)),
    tools,
    unverifiedTools: tools.filter((tool) => !verified(tool)),
    resourceNames: shown.map((resource) => resource.name),
    resourceIds: shown.map((resource) => resource.id),
    category: category.category,
    categorySource: category.categorySource,
    categoryReason: category.categoryReason,
    suggestedCategory: category.suggestedCategory,
    sourceBoards: category.sourceBoards,
    themes: category.themes,
    // Only the source-line label reads this: the review audit's "unavailable" list, or an add-on that says so.
    postUnreachable: unreachableIds.has(noteId) || addOn?.review_status === "unavailable",
  };
}
