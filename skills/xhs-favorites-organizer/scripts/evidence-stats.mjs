import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const NOTE_ID = /^[a-f0-9]{24}$/;
const IMAGE_FILE = /\.(?:jpe?g|png|webp)$/i;

async function countImages(directory) {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) count += await countImages(entryPath);
    else if (entry.isFile() && IMAGE_FILE.test(entry.name)) count += 1;
  }
  return count;
}

async function hasCompletionMarker(directory, noteId, legacyCompletedIds) {
  if (legacyCompletedIds.has(noteId)) return true;
  try {
    const manifest = JSON.parse(await readFile(resolve(directory, "analysis.json"), "utf8"));
    return manifest?.status === "complete";
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

export async function collectVideoEvidenceStats(directory, fallback = {}, allowedNoteIds = null) {
  const allowed = allowedNoteIds ? new Set(allowedNoteIds) : null;
  const legacyCompletedIds = new Set(fallback.frame_verified_note_ids || []);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const verifiedNoteIds = [...legacyCompletedIds].filter((noteId) => !allowed || allowed.has(noteId));
    return {
      frameEvidenceCount: verifiedNoteIds.length === legacyCompletedIds.size ? Number(fallback.frame_evidence_count || 0) : 0,
      verifiedNoteIds,
      derivedFromLocalEvidence: false
    };
  }

  const verifiedNoteIds = [];
  let frameEvidenceCount = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !NOTE_ID.test(entry.name) || (allowed && !allowed.has(entry.name))) continue;
    const noteDirectory = resolve(directory, entry.name);
    if (!await hasCompletionMarker(noteDirectory, entry.name, legacyCompletedIds)) continue;
    const imageCount = await countImages(noteDirectory);
    if (imageCount === 0) continue;
    verifiedNoteIds.push(entry.name);
    frameEvidenceCount += imageCount;
  }

  return { frameEvidenceCount, verifiedNoteIds, derivedFromLocalEvidence: true };
}
