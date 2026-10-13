import test from "node:test";
import assert from "node:assert/strict";
import { judgePublicNote } from "../scripts/public-judgement.mjs";
import { TODAY, config, note, profile, skillResource } from "./public-judgement-fixtures.mjs";

// One module decides, for one note, which kind it is, which resources and tools belong to it and how it is
// categorised. It does not decide whether the card is shown in full. These tests drive it through its single
// entry point with in-memory inputs; public-judgement-builders.test.mjs runs the web builder.

const resource = skillResource();
const input = (changes = {}) => ({
  noteId: "n1", note: note(), addOn: null, resourceRegistry: { verified_at: TODAY, resources: [resource] },
  config, profile, effectiveDate: TODAY, ...changes,
});
const skillEntry = (changes = {}) => ({ category: "Synthetic", themes: ["testing"], tools: [resource.name], kind: "Skill", ...changes });

test("a Skill with a fresh official resource is a confirmed Skill with that resource and no unverified tool", () => {
  const verdict = judgePublicNote(input({ addOn: skillEntry() }));
  assert.equal(verdict.kind, "Skill");
  assert.deepEqual(verdict.resourceIds, [resource.id]);
  assert.deepEqual(verdict.resourceNames, [resource.name]);
  assert.deepEqual(verdict.tools, [resource.name]);
  assert.deepEqual(verdict.unverifiedTools, []);
  assert.equal(verdict.category, "Synthetic");
  assert.deepEqual(verdict.sourceBoards, ["Synthetic"]);
  assert.equal(verdict.postUnreachable, false);
});

test("a Skill whose resource check is more than 30 days old is shown as the neutral kind, with its tool marked unverified", () => {
  const stale = skillResource({ verified_at: "2026-09-01" });
  const verdict = judgePublicNote(input({ addOn: skillEntry({ tools: [stale.name] }), resourceRegistry: { verified_at: TODAY, resources: [stale] } }));
  assert.equal(verdict.kind, "Tool");
  assert.deepEqual(verdict.resourceIds, []);
  assert.deepEqual(verdict.resourceNames, []);
  // The tool is still named, because it is what the post is about; it is just not confirmed.
  assert.deepEqual(verdict.tools, [stale.name]);
  assert.deepEqual(verdict.unverifiedTools, [stale.name]);
});

test("a tool that matches a resource with an official link is verified, and one that matches nothing is not", () => {
  const website = { ...resource, id: "tool-1", name: "Some Tool", type: "开源项目", repo: "https://github.com/owner/tool" };
  const verdict = judgePublicNote(input({
    addOn: { category: "Synthetic", themes: [], tools: ["Some Tool", "Mystery Tool"], kind: "Tool" },
    resourceRegistry: { verified_at: TODAY, resources: [website] },
  }));
  assert.equal(verdict.kind, "Tool");
  assert.deepEqual(verdict.tools, ["Some Tool", "Mystery Tool"]);
  assert.deepEqual(verdict.unverifiedTools, ["Mystery Tool"]);
  assert.deepEqual(verdict.resourceNames, ["Some Tool"]);
});

test("a note with no add-on is sorted by the profile's fallback rules and carries no topics or tools", () => {
  const verdict = judgePublicNote(input({ note: note({ title: "Weekly review", description: `Weekly workflow review. ${"x".repeat(300)}` }) }));
  assert.equal(verdict.kind, "Workflow");
  assert.deepEqual(verdict.themes, []);
  assert.deepEqual(verdict.tools, []);
  assert.deepEqual(verdict.unverifiedTools, []);
});

test("an add-on that names no kind is classified by the profile's rules, and a Skill goes through resource confirmation", () => {
  const unkinded = { category: "Synthetic", themes: ["testing"], summary: "每周复盘的可复用工作流。", action: "Run it every week.", tools: [] };
  assert.equal(judgePublicNote(input({ addOn: unkinded })).kind, "Workflow");
  // By resource: the tool is a Skill resource, so the note is a Skill candidate and the resource is checked.
  const confirmed = judgePublicNote(input({ addOn: { ...unkinded, summary: "Something else.", tools: [resource.name] } }));
  assert.equal(confirmed.kind, "Skill");
  const expired = skillResource({ verified_at: "2026-09-01" });
  const stale = judgePublicNote(input({
    addOn: { ...unkinded, summary: "Something else.", tools: [expired.name] }, resourceRegistry: { resources: [expired] },
  }));
  assert.notEqual(stale.kind, "Skill");
  assert.deepEqual(stale.resourceIds, []);
});

test("an add-on that leaves fields out is used as it is: no topics, no tools, and no failure", () => {
  const verdict = judgePublicNote(input({ addOn: { category: "Synthetic", kind: "Note" } }));
  assert.equal(verdict.kind, "Note");
  assert.deepEqual(verdict.themes, []);
  assert.deepEqual(verdict.tools, []);
});

test("an add-on naming a kind the profile does not declare is refused", () => {
  assert.throws(() => judgePublicNote(input({ addOn: { category: "Synthetic", themes: [], tools: [], kind: "Gadget" } })), /Invalid content kind: Gadget/);
});

test("a post is unreachable when the audit lists it or its add-on says so, and not otherwise", () => {
  assert.equal(judgePublicNote(input({ unreachableIds: new Set(["n1"]) })).postUnreachable, true);
  assert.equal(judgePublicNote(input({ addOn: { ...skillEntry(), review_status: "unavailable" } })).postUnreachable, true);
  assert.equal(judgePublicNote(input({ unreachableIds: new Set(["other"]) })).postUnreachable, false);
  assert.equal(judgePublicNote(input({ addOn: { ...skillEntry(), review_status: "accepted" } })).postUnreachable, false);
});

test("the profile sets how many days a resource check stays fresh, and 30 when it says nothing", () => {
  const recent = skillResource({ verified_at: "2026-10-08" });
  const base = input({ addOn: skillEntry(), resourceRegistry: { verified_at: TODAY, resources: [recent] } });
  // Checked two days before the effective date: fresh under the default, stale when the profile allows one day.
  assert.equal(judgePublicNote(base).kind, "Skill");
  const strict = { ...profile, resource_index: { ...profile.resource_index, verification_max_age_days: 1 } };
  const verdict = judgePublicNote({ ...base, profile: strict });
  assert.notEqual(verdict.kind, "Skill");
  assert.deepEqual(verdict.resourceIds, []);
  // A Skill checked 30 days before is still fresh; 31 days is not.
  const days = (verifiedAt) => judgePublicNote(input({ addOn: skillEntry(), resourceRegistry: { verified_at: TODAY, resources: [skillResource({ verified_at: verifiedAt })] } })).kind;
  assert.equal(days("2026-09-10"), "Skill");
  assert.notEqual(days("2026-09-09"), "Skill");
});
