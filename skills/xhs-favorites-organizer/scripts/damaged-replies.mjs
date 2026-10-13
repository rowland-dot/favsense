#!/usr/bin/env node
// The frozen list of saved DianDian replies that lost text when we captured them (spec §4, last paragraph).
// The rule is the two signs the spec names and nothing more; it is not tuned to a target count.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFormalPointSummary } from "./curation-quality.mjs";
import { isBareLine } from "../../../site/diandian-text.mjs";

const INVISIBLE = /[​-‍﻿]/g;
// Same line only: a bullet on the NEXT line after a colon is ordinary formatting, not lost text.
const JOINED_LIST_ITEM = /[，,；;：:、][ \t]*[-•·][ \t]+\S/;
const HASHTAG_LINE = /^(?:#\S+\s*)+$/;
const COMMA_OR_COLON_END = /[，,：:]$/;
const HASH = /^[a-f0-9]{64}$/;
const NOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function damageSigns(reply) {
  const text = String(reply ?? "").replace(INVISIBLE, "").replace(/\r\n?/g, "\n");
  const signs = [];
  if (JOINED_LIST_ITEM.test(text)) signs.push("joined-list-items");
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  while (lines.length && HASHTAG_LINE.test(lines.at(-1))) lines.pop();
  const last = lines.at(-1) ?? "";
  if (COMMA_OR_COLON_END.test(last)) signs.push("ends-on-comma-or-colon");
  else if (last && isBareLine(last)) signs.push("ends-on-bare-heading");
  return signs;
}

// Only replies the saved-reply loader accepts are looked at: a refusal is not a summary.
export function findDamagedReplies({ diandianDir, noteIds }) {
  const entries = [];
  for (const noteId of [...noteIds].sort()) {
    const point = loadFormalPointSummary(diandianDir, noteId);
    const signs = point ? damageSigns(point.summary) : [];
    if (signs.length) entries.push({ note_id: noteId, summary_sha256: point.summary_sha256, signs });
  }
  return entries;
}

// note id -> hash of the damaged copy. A missing file means nothing is damaged; a malformed one is refused.
export function loadDamagedReplies(path) {
  let source;
  try { source = readFileSync(path, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  const list = JSON.parse(source.replace(/^﻿/, ""));
  if (!Array.isArray(list?.entries) || list.entries.some((entry) => !NOTE_ID.test(entry?.note_id) || !HASH.test(entry?.summary_sha256))) {
    throw new Error(`damaged reply list is malformed: ${path}`);
  }
  return new Map(list.entries.map((entry) => [entry.note_id, entry.summary_sha256]));
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`--${name} is required`);
  return resolve(process.argv[index + 1]);
}

function main() {
  const catalog = JSON.parse(readFileSync(option("catalog"), "utf8").replace(/^﻿/, ""));
  const entries = findDamagedReplies({ diandianDir: option("diandian-dir"), noteIds: Object.keys(catalog.notes || {}).filter((id) => NOTE_ID.test(id)) });
  const output = option("output");
  mkdirSync(dirname(output), { recursive: true });
  const staging = `${output}.${process.pid}.tmp`;
  writeFileSync(staging, `${JSON.stringify({ schema_version: 1, signs: ["joined-list-items", "ends-on-comma-or-colon", "ends-on-bare-heading"], entries }, null, 2)}\n`, "utf8");
  renameSync(staging, output);
  process.stdout.write(`${JSON.stringify({ count: entries.length, ids: entries.map((entry) => entry.note_id) })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
