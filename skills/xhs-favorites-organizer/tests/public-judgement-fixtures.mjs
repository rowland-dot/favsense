// Inputs shared by the public judgement tests: the module's own tests and the tests that run the
// web builder on the same notes.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expectedResourceRevisions } from "../scripts/resource-quality.mjs";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const hex = (character) => character.repeat(64);
export const profile = JSON.parse(await readFile(join(root, "config/domain-profiles/software.json"), "utf8"));
export const config = { boards: [{ id: "private-board-id", name: "Synthetic", enabled: true }] };

// Real DianDian replies, some of them refusals to read the note: the one table both copies of the refusal rule are held to.
export const diandianReplyCases = JSON.parse(
  await readFile(join(root, "skills/xhs-favorites-organizer/test-fixtures/diandian-refusal-cases.json"), "utf8")
).cases;
export const refusalReply = diandianReplyCases.find((entry) => entry.id === "refusal-cannot-open-link-asks-for-copy").text;
export const normalReply = diandianReplyCases.find((entry) => entry.id === "summary-starts-with-according-to-your-note").text;

// A fixed clock that is not the date the suite runs on, so a call site that forgets to pass it
// cannot pass by accident.
export const TODAY = "2026-10-10";

const sealResource = (resource) => Object.assign(resource, expectedResourceRevisions(resource));

export function skillResource(overrides = {}) {
  return sealResource({
    id: "github-owner-repo", name: "Official synthetic Skill", aliases: [], type: "Agent Skill",
    canonical_repo: "owner/repo", repo: "https://github.com/owner/repo",
    download: "https://github.com/owner/repo/archive/refs/heads/main.zip", stars: "4", stars_numeric: 4,
    license: "MIT", skill_manifest: "SKILL.md", compatibility: ["Codex"], compatibility_evidence: ["README.md"],
    verified_at: "2026-10-05", status: "verified", usage_note: "Synthetic verified fixture.", ...overrides,
  });
}

export const note = (overrides = {}) => ({
  note_id: "n1", title: "Official synthetic Skill", description: "Synthetic safe body",
  published_at: "2026-10-01", source_boards: ["Synthetic"], content_sha256: hex("c"), ...overrides,
});
