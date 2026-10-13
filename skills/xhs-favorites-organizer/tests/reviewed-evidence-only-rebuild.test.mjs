import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Snapshot: the builders are handed the sealed candidates of every note that is not accepted ---
// (A card no longer waits for a note to be accepted, but the add-on a sealed candidate carries still reaches the build.)

test("the snapshot freezes the sealed candidates of notes that are not accepted for the builders", async () => {
  const { unacceptedCandidates, materializeCapturedInputs } = await import("../scripts/build-organization-snapshot.mjs");
  const bundle = {
    schema_version: 1, outcome: "ready_for_safe_build", scope: { note_ids: ["kept", "waiting", "gone"] },
    curation: {
      kept: { review_status: "accepted", kind: "Note" },
      waiting: { review_status: "pending", kind: "Skill" },
      gone: { review_status: "unavailable", kind: "Note" },
    },
  };
  assert.deepEqual(unacceptedCandidates(bundle), {
    waiting: { review_status: "pending", kind: "Skill" },
    gone: { review_status: "unavailable", kind: "Note" },
  });
  const work = await mkdtemp(join(tmpdir(), "favsense-snapshot-candidates-"));
  try {
    const frozen = await materializeCapturedInputs(work, { inputs: [], config: {}, bundleSource: Buffer.from(JSON.stringify(bundle)) }, {});
    assert.deepEqual(JSON.parse(await readFile(frozen.candidates, "utf8")), unacceptedCandidates(bundle));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
