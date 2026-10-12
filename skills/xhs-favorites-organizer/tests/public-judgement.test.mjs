import test from "node:test";
import assert from "node:assert/strict";
import { curationRevision } from "../scripts/curation-revision.mjs";
import { judgePublicNote } from "../scripts/public-judgement.mjs";
import { acceptedSkill, hex, note, profile, skillResource } from "./public-judgement-fixtures.mjs";

// Issue 6: one module decides, for one note, whether it is accepted, what kind it is, which
// resources belong to it, where its summary comes from and how it is categorised. The two
// formal builders only lay that verdict out. These tests drive the module through its single
// entry point with in-memory inputs; public-judgement-builders.test.mjs runs both builders.

test("an accepted Skill with a fresh official resource and a current point summary", () => {
  const { input, entry, resource, pointText } = acceptedSkill();
  const verdict = judgePublicNote(input);
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.reasonCode, "");
  assert.equal(verdict.curationStatus, "accepted");
  assert.equal(verdict.kind, "Skill");
  assert.equal(verdict.candidateKind, "");
  assert.deepEqual(verdict.resourceIds, [resource.id]);
  assert.deepEqual(verdict.resourceNames, [resource.name]);
  assert.deepEqual(verdict.tools, [resource.name]);
  assert.equal(verdict.skillResource.id, resource.id);
  assert.equal(verdict.summarySource, "point");
  assert.equal(verdict.summary, entry.summary);
  assert.equal(verdict.deepSummary, pointText);
  assert.equal(verdict.action, entry.action);
  assert.equal(verdict.category, "Synthetic");
  assert.deepEqual(verdict.sourceBoards, ["Synthetic"]);
});

test("a summary made under an older prompt is not accepted and shows only the note's own text", () => {
  const { input, entry } = acceptedSkill();
  // The audit and the point summary were made under another prompt version than the one now in force.
  const verdict = judgePublicNote({ ...input, promptVersion: hex("9") });
  assert.equal(verdict.accepted, false);
  assert.notEqual(verdict.curationStatus, "accepted");
  assert.equal(verdict.summarySource, "metadata");
  assert.equal(verdict.summary, "Synthetic safe body");
  assert.notEqual(verdict.summary, entry.summary);
  // A Skill that is not accepted shows as the profile's neutral kind, with the Skill kept as a candidate.
  assert.equal(verdict.kind, "Tool");
  assert.equal(verdict.candidateKind, "Skill");
  assert.deepEqual(verdict.tools, []);
});

test("an accepted Skill whose resource check is more than 30 days old is stale, not a confirmed Skill", () => {
  const { input } = acceptedSkill({ resource: skillResource({ verified_at: "2026-09-01" }) });
  const verdict = judgePublicNote(input);
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reasonCode, "resource_stale");
  assert.equal(verdict.kind, "Tool");
  assert.equal(verdict.candidateKind, "Skill");
  assert.equal(verdict.skillResource, null);
  assert.deepEqual(verdict.resourceIds, []);
});

test("a note with no reviewed entry shows only its own text, sorted by the profile's fallback rules", () => {
  const description = `Weekly workflow review. ${"x".repeat(300)}`;
  const verdict = judgePublicNote({
    ...acceptedSkill().input,
    note: note({ title: "Weekly review", description }),
    curation: {}, sealedCandidates: {},
  });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.curationStatus, "pending_review");
  assert.equal(verdict.reasonCode, "audit_pending");
  assert.equal(verdict.summarySource, "metadata");
  assert.equal(verdict.summary, description.slice(0, 240));
  assert.equal(verdict.kind, "Workflow");
  assert.deepEqual(verdict.themes, []);
  assert.deepEqual(verdict.tools, []);
});

test("a sealed candidate that is not accepted keeps its sealed kind and its own reason", () => {
  const { input, entry } = acceptedSkill({ resource: skillResource({ verified_at: "2026-09-01" }) });
  const verdict = judgePublicNote({ ...input, curation: {}, sealedCandidates: { n1: entry } });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reasonCode, "resource_stale");
  assert.equal(verdict.candidateKind, "Skill");
  assert.equal(verdict.summarySource, "metadata");
  assert.equal(verdict.summary, "Synthetic safe body");
  assert.notEqual(verdict.kind, "Skill");
});

test("an entry that names no kind is classified by the profile's rules, and a Skill goes through resource confirmation", () => {
  const resource = skillResource();
  const base = acceptedSkill({ resource }).input;
  const unkinded = { category: "Synthetic", themes: ["testing"], summary: "每周复盘的可复用工作流。", action: "Run it every week.", tools: [] };
  // By wording: no resource, so the profile's content rule decides.
  const byText = judgePublicNote({ ...base, quality: { ...base.quality, policy: {} }, curation: { n1: unkinded } });
  assert.equal(byText.kind, "Workflow");
  // By resource: the tool is a Skill resource, so the note is a Skill candidate and the resource is checked.
  const bySkillResource = judgePublicNote({ ...base, curation: { n1: { ...unkinded, summary: "Something else.", tools: [resource.name] } } });
  assert.equal(bySkillResource.candidateKind, "Skill");
  assert.notEqual(bySkillResource.kind, "Skill");
  const expired = skillResource({ verified_at: "2026-09-01" });
  const staleCandidate = judgePublicNote({
    ...base, resourceRegistry: { resources: [expired] }, curation: { n1: { ...unkinded, summary: "Something else.", tools: [expired.name] } },
  });
  assert.equal(staleCandidate.candidateKind, "Skill");
  assert.equal(staleCandidate.skillResource, null);
});

test("a reviewed entry that leaves a field blank is shown with that field blank, not filled from the note", () => {
  const base = acceptedSkill().input;
  const entry = { category: "Synthetic", summary: "Reviewed summary, written by hand.", tools: [], kind: "Note" };
  const verdict = judgePublicNote({
    ...base,
    curation: { n1: entry },
    quality: { ...base.quality, audit: { version: 2, notes: {} }, baselineIds: new Set(["n1"]), baselineRevisions: new Map([["n1", curationRevision(entry)]]) },
  });
  assert.equal(verdict.curated, true);
  assert.equal(verdict.summary, "Reviewed summary, written by hand.");
  assert.equal(verdict.action, "");
  assert.deepEqual(verdict.themes, []);
  assert.equal(verdict.kind, "Note");
});

test("an entry naming a kind the profile does not declare is refused, not shown", () => {
  const base = acceptedSkill().input;
  const entry = { category: "Synthetic", themes: ["testing"], summary: "Whatever.", action: "Whatever.", tools: [], kind: "Gadget" };
  assert.throws(() => judgePublicNote({ ...base, curation: { n1: entry } }), /Invalid content kind: Gadget/);
});

test("the profile sets how many days a resource check stays fresh, and 30 when it says nothing", () => {
  const { input } = acceptedSkill({ resource: skillResource({ verified_at: "2026-10-08" }) });
  // Checked two days before the effective date: fresh under the default, stale when the profile allows one day.
  assert.equal(judgePublicNote(input).accepted, true);
  const strict = { ...profile, resource_index: { ...profile.resource_index, verification_max_age_days: 1 } };
  const verdict = judgePublicNote({ ...input, profile: strict });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reasonCode, "resource_stale");
  // A Skill checked 30 days before is still fresh; 31 days is not.
  assert.equal(judgePublicNote(acceptedSkill({ resource: skillResource({ verified_at: "2026-09-10" }) }).input).accepted, true);
  assert.equal(judgePublicNote(acceptedSkill({ resource: skillResource({ verified_at: "2026-09-09" }) }).input).accepted, false);
});
