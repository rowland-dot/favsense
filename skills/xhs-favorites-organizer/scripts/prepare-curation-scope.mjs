import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument near ${key || "end"}`);
    result[key.slice(2)] = value;
  }
  for (const required of ["catalog", "baseline-knowledge", "baseline-output", "scope-output"]) {
    if (!result[required]) throw new Error(`--${required} is required`);
  }
  return result;
}

function readJson(filename, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filename), "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`${label} could not be read: ${error.message}`);
  }
}

function writePrivateJson(filename, value) {
  const output = path.resolve(filename);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function prepareScope(
  catalog,
  baselineKnowledge,
  createdAt = new Date().toISOString(),
  includedNoteIds = [],
  runOnly = false
) {
  const catalogIds = Object.keys(catalog.notes || catalog);
  const baselineSource = Array.isArray(baselineKnowledge.note_ids)
    ? baselineKnowledge.note_ids
    : (baselineKnowledge.notes || []).map((note) => note?.id);
  const baselineIds = [...new Set(baselineSource.map((value) => String(value || "").trim()).filter(Boolean))];
  const baselineSet = new Set(baselineIds);
  const snapshotHashes = Array.isArray(baselineKnowledge.notes)
    ? Object.fromEntries(baselineKnowledge.notes
      .map((note) => [String(note?.id || "").trim(), String(note?.curationRevision || "").trim()])
      .filter(([noteId, revision]) => noteId && /^[a-f0-9]{64}$/.test(revision)))
    : Object.fromEntries(Object.entries(baselineKnowledge.curation_hashes || {})
      .map(([noteId, revision]) => [String(noteId || "").trim(), String(revision || "").trim()])
      .filter(([noteId, revision]) => noteId && /^[a-f0-9]{64}$/.test(revision)));
  return {
    baseline: {
      version: 1,
      created_at: createdAt,
      source: "published-knowledge-snapshot",
      note_ids: baselineIds,
      curation_hashes: Object.fromEntries(
        baselineIds.filter((noteId) => snapshotHashes[noteId]).map((noteId) => [noteId, snapshotHashes[noteId]])
      )
    },
    scope: {
      version: 1,
      created_at: createdAt,
      mode: runOnly ? "explicit-run" : (includedNoteIds.length ? "baseline-difference-plus-explicit-run" : "baseline-difference"),
      baseline_count: baselineIds.length,
      note_ids: runOnly
        ? catalogIds.filter((noteId) => includedNoteIds.includes(noteId))
        : catalogIds.filter((noteId) => !baselineSet.has(noteId) || includedNoteIds.includes(noteId))
    }
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = readJson(options.catalog, "catalog");
  let includedNoteIds = [];
  if (options["include-run-report"]) {
    const report = readJson(options["include-run-report"], "run report");
    includedNoteIds = [
      ...(Array.isArray(report.succeeded_note_ids) ? report.succeeded_note_ids : []),
      ...(Array.isArray(report.unresolved) ? report.unresolved.map((item) => item?.note_id) : [])
    ].map((value) => String(value || "").trim()).filter(Boolean);
    if (new Set(includedNoteIds).size !== includedNoteIds.length) throw new Error("run report contains duplicate note IDs");
    const catalogIds = new Set(Object.keys(catalog.notes || catalog));
    if (includedNoteIds.some((noteId) => !/^[A-Za-z0-9_-]{1,128}$/.test(noteId) || !catalogIds.has(noteId))) {
      throw new Error("run report contains an unknown or invalid note ID");
    }
  }
  const result = prepareScope(
    catalog,
    readJson(options["baseline-knowledge"], "baseline knowledge"),
    new Date().toISOString(),
    includedNoteIds,
    options["run-only"] === "true"
  );
  writePrivateJson(options["baseline-output"], result.baseline);
  writePrivateJson(options["scope-output"], result.scope);
  process.stdout.write(`${JSON.stringify({ baseline: result.baseline.note_ids.length, scope: result.scope.note_ids.length })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
