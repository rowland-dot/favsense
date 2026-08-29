#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { contentRevision } from "./content-revision.mjs";

const ID_KEYS = ["note_id", "noteId", "id"];
const TITLE_KEYS = ["display_title", "displayTitle", "title", "name"];
const DESCRIPTION_KEYS = ["description", "desc", "content"];
const TAG_KEYS = ["tags", "tag_list", "tagList"];

function usage() {
  return `Usage:
  node organize.mjs --input <favorites.json|-> --catalog <catalog.json> [options]

Options:
  --output <report.md>       Write the Markdown report; otherwise print to stdout
  --date <YYYY-MM-DD>        Report date; defaults to the local date
  --baseline                 Record all input notes without treating them as new
  --dry-run                  Do not write the catalog or report
  --help                     Show this help
`;
}

function parseArgs(argv) {
  const options = { baseline: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--baseline") {
      options.baseline = true;
      continue;
    }
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (!["--input", "--catalog", "--output", "--date"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${argument}`);
    }
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function readText(inputPath) {
  if (inputPath === "-") {
    return fs.readFileSync(0, "utf8");
  }
  return fs.readFileSync(path.resolve(inputPath), "utf8");
}

function parseJson(text, label) {
  const cleaned = text.replace(/^\uFEFF/, "").trim();
  if (!cleaned) {
    throw new Error(`${label} is empty`);
  }
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function getPath(value, keys) {
  let current = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function noteBody(item) {
  if (!item || typeof item !== "object") return null;
  return item.note_card ?? item.noteCard ?? item.note ?? item;
}

function firstValue(object, keys) {
  if (!object || typeof object !== "object") return undefined;
  for (const key of keys) {
    const value = object[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function looksLikeNote(item) {
  const body = noteBody(item);
  if (!body) return false;
  const id = firstValue(item, ID_KEYS) ?? firstValue(body, ID_KEYS);
  const title = firstValue(body, TITLE_KEYS);
  return Boolean(id && (title || body.user || body.author || body.cover));
}

function hasNoteId(item) {
  const body = noteBody(item);
  return Boolean(body && (firstValue(item, ID_KEYS) ?? firstValue(body, ID_KEYS)));
}

function findNoteArray(payload) {
  if (Array.isArray(payload)) return payload;

  const preferredPaths = [
    ["notes"],
    ["items"],
    ["list"],
    ["data", "notes"],
    ["data", "items"],
    ["data", "list"],
    ["data"],
  ];
  for (const keys of preferredPaths) {
    const candidate = getPath(payload, keys);
    if (Array.isArray(candidate) && (candidate.length === 0 || candidate.some(hasNoteId))) {
      return candidate;
    }
  }

  const candidates = [];
  const visit = (value, depth) => {
    if (depth > 5 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      if (value.length > 0) {
        const matches = value.filter(looksLikeNote).length;
        if (matches > 0) candidates.push({ value, score: matches / value.length, matches });
      }
      return;
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(payload, 0);
  candidates.sort((left, right) => right.score - left.score || right.matches - left.matches);
  return candidates[0]?.value;
}

function cleanText(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function safeNoteId(value) {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function safeXhsUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const allowedHost = url.hostname === "www.xiaohongshu.com" || url.hostname === "xiaohongshu.com";
    const match = url.pathname.match(/^\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]{1,128})$/);
    return url.protocol === "https:" && allowedHost && match
      ? `https://www.xiaohongshu.com/explore/${match[1]}`
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeCount(value) {
  const text = cleanText(value);
  return text || undefined;
}

function normalizeCommentEvidence(value) {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.slice(0, 30).map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const text = cleanText(item.text).slice(0, 500);
    if (!text) return null;
    const result = { text, reply: item.reply === true };
    const likedCount = normalizeCount(item.liked_count ?? item.likedCount);
    if (likedCount !== undefined) result.liked_count = likedCount;
    return result;
  }).filter(Boolean);
  return normalized.length ? normalized : undefined;
}

function normalizeNote(item, seenAt) {
  const body = noteBody(item);
  const id = cleanText(firstValue(item, ID_KEYS) ?? firstValue(body, ID_KEYS));
  if (!safeNoteId(id)) return null;

  const user = body.user ?? body.author ?? item.user ?? item.author ?? {};
  const interaction = body.interact_info ?? body.interactInfo ?? body.interaction ?? {};
  const coverObject = body.cover ?? item.cover ?? {};
  const explicitUrl = safeXhsUrl(cleanText(
    firstValue(item, ["webUrl", "web_url", "url", "note_url", "noteUrl"]) ??
      firstValue(body, ["webUrl", "web_url", "url", "note_url", "noteUrl"]),
  ));
  const url = explicitUrl ?? `https://www.xiaohongshu.com/explore/${encodeURIComponent(id)}`;

  return {
    note_id: id,
    title: cleanText(firstValue(body, TITLE_KEYS)) || undefined,
    author: (typeof user === "string"
      ? cleanText(user)
      : cleanText(firstValue(user, ["nickname", "nick_name", "name", "display_name"]))) || undefined,
    author_id: cleanText(firstValue(body, ["author_id", "authorId"]) ?? firstValue(item, ["author_id", "authorId"])) || undefined,
    description: cleanText(firstValue(body, DESCRIPTION_KEYS)) || undefined,
    tags: (() => {
      const value = firstValue(body, TAG_KEYS);
      if (Array.isArray(value)) return value.map(cleanText).filter(Boolean).join(" ") || undefined;
      return cleanText(value) || undefined;
    })(),
    type: cleanText(firstValue(body, ["type", "note_type", "noteType"])) || undefined,
    url,
    cover: cleanText(firstValue(coverObject, ["url_default", "urlDefault", "url", "url_pre"])) || undefined,
    liked_count: normalizeCount(
      firstValue(interaction, ["liked_count", "likedCount"]) ?? firstValue(body, ["liked_count", "likedCount"]),
    ),
    collected_count: normalizeCount(
      firstValue(interaction, ["collected_count", "collectedCount"]) ??
        firstValue(body, ["collected_count", "collectedCount"]),
    ),
    published_at: cleanText(firstValue(body, ["published_at", "publishedAt"])) || undefined,
    fetch_error: cleanText(firstValue(body, ["fetch_error", "fetchError"])) || undefined,
    detail_fetched: body.detail_fetched === true || body.detailFetched === true,
    comment_evidence_checked: body.comment_evidence_checked === true || body.commentEvidenceChecked === true,
    comment_evidence: normalizeCommentEvidence(
      body.comment_evidence ?? body.commentEvidence ?? item.comment_evidence ?? item.commentEvidence,
    ),
    first_seen_at: seenAt,
    last_seen_at: seenAt,
  };
}

function localDate() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid --date value: ${value}`);
  }
  return value;
}

function loadCatalog(catalogPath) {
  const resolved = path.resolve(catalogPath);
  if (!fs.existsSync(resolved)) return { version: 1, updated_at: null, notes: {} };
  const catalog = parseJson(fs.readFileSync(resolved, "utf8"), "catalog");
  if (
    catalog.version !== 1 ||
    !catalog.notes ||
    typeof catalog.notes !== "object" ||
    Array.isArray(catalog.notes)
  ) {
    throw new Error("Unsupported catalog format; expected version 1 with a notes object");
  }
  return catalog;
}

function atomicWrite(filePath, content) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, content, "utf8");
    fs.renameSync(temporary, resolved);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function markdownText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\[\]]/g, "");
}

function truncationWarning(scanned) {
  return scanned >= 30
    ? "⚠️ 本次结果达到默认单页上限，可能仍有未扫描收藏；完整性未得到保证。"
    : undefined;
}

function noteEntryLines(note, index) {
  const title = markdownText(note.title || "无标题笔记");
  const author = markdownText(note.author || "未知作者");
  const type = markdownText(note.type || "unknown");
  const lines = [
    `### ${index}. [${title}](${note.url})`,
    "",
    `- 作者：${author}`,
    `- 类型：${type}`,
    `- 笔记 ID：\`${note.note_id}\``,
  ];
  if (note.tags) lines.push(`- 原始标签：${markdownText(note.tags)}`);
  if (note.description) {
    const description = note.description.length > 500
      ? `${note.description.slice(0, 500)}…`
      : note.description;
    lines.push(`- 原文描述：${markdownText(description)}`);
  }
  if (note.fetch_error) lines.push("- 详情状态：正文待补充");
  if (note.comment_evidence?.length) {
    lines.push(`- 评论区线索：已匿名收录 ${note.comment_evidence.length} 条（未经核实）`);
  }
  lines.push(
    "- 分类：`待分类`",
    "- 标签：",
    "- 一句话摘要：",
    "- 可执行事项：",
    "",
  );
  return lines;
}

function markdownFor({ date, now, scanned, additions, baseline }) {
  const lines = [
    "---",
    'source: "xiaohongshu-favorites"',
    `date: ${yamlString(date)}`,
    `generated_at: ${yamlString(now)}`,
    `scanned_count: ${scanned}`,
    `new_count: ${additions.length}`,
    `baseline: ${baseline}`,
    "---",
    "",
    `# 小红书收藏整理 | ${date}`,
    "",
  ];

  if (baseline) {
    lines.push(`已建立基线，共登记 ${scanned} 篇近期收藏；本次不标记为新增。`, "");
    const warning = truncationWarning(scanned);
    if (warning) lines.push(warning, "");
    return `${lines.join("\n")}\n`;
  }
  if (additions.length === 0) {
    lines.push("今天没有检测到新增收藏。", "");
    const warning = truncationWarning(scanned);
    if (warning) lines.push(warning, "");
    return `${lines.join("\n")}\n`;
  }

  lines.push(`本次扫描 ${scanned} 篇，检测到 ${additions.length} 篇新增收藏。`, "");
  const warning = truncationWarning(scanned);
  if (warning) lines.push(warning, "");
  lines.push(`## 待整理（${additions.length}）`, "");
  additions.forEach((note, index) => {
    lines.push(...noteEntryLines(note, index + 1));
  });
  return `${lines.join("\n")}\n`;
}

function reportNoteIds(markdown) {
  const ids = new Set();
  const pattern = /- 笔记 ID：`([A-Za-z0-9_-]{1,128})`/g;
  for (const match of markdown.matchAll(pattern)) ids.add(match[1]);
  return ids;
}

function appendToReport(existing, additions, scanned) {
  const existingIds = reportNoteIds(existing);
  const lines = [
    `## 待整理补充（${additions.length}）`,
    "",
    `本次补充扫描 ${scanned} 篇。`,
    "",
  ];
  const warning = truncationWarning(scanned);
  if (warning) lines.push(warning, "");
  additions.forEach((note, index) => {
    lines.push(...noteEntryLines(note, existingIds.size + index + 1));
  });

  let combined = existing
    .replace(/^今天没有检测到新增收藏。\s*$/m, "")
    .trimEnd();
  combined += `\n\n${lines.join("\n").trimEnd()}\n`;
  const total = existingIds.size + additions.length;
  return combined
    .replace(/^new_count:\s*\d+\s*$/m, `new_count: ${total}`)
    .replace(/^baseline:\s*true\s*$/m, "baseline: false");
}

function ensureTruncationWarning(existing, scanned) {
  const warning = truncationWarning(scanned);
  if (!warning || existing.includes(warning)) return existing;
  return `${existing.trimEnd()}\n\n${warning}\n`;
}

function updateBaselineReport(existing, total, batchScanned) {
  let updated = existing
    .replace(/^scanned_count:\s*\d+\s*$/m, `scanned_count: ${total}`)
    .replace(/^new_count:\s*\d+\s*$/m, "new_count: 0")
    .replace(/^baseline:\s*(?:true|false)\s*$/m, "baseline: true")
    .replace(
      /^已建立基线，共登记 \d+ 篇(?:近期)?收藏；本次不标记为新增。\s*$/m,
      `已建立基线，共登记 ${total} 篇收藏；本次不标记为新增。`,
    );
  return ensureTruncationWarning(updated, batchScanned);
}

function canonicalizeReportLinks(markdown) {
  return markdown.replace(
    /https:\/\/(?:www\.)?xiaohongshu\.com\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]{1,128})(?:\?[^\s)]*)?/g,
    (_, noteId) => `https://www.xiaohongshu.com/explore/${noteId}`,
  );
}

function requireIgnoredPrivatePaths(catalogPath, outputPath) {
  const resolvedCatalog = path.resolve(catalogPath);
  const workspace = path.basename(path.dirname(resolvedCatalog)) === ".xhs-favorites"
    ? path.dirname(path.dirname(resolvedCatalog))
    : path.dirname(resolvedCatalog);
  let markerRoot = workspace;
  while (!fs.existsSync(path.join(markerRoot, ".git"))) {
    const parent = path.dirname(markerRoot);
    if (parent === markerRoot) return;
    markerRoot = parent;
  }

  const repository = spawnSync("git", [
    "-c", `safe.directory=${markerRoot}`,
    "-C", workspace,
    "rev-parse", "--show-toplevel",
  ], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (repository.error || repository.status !== 0) {
    throw new Error("A Git repository was detected, but its privacy status could not be verified. Fix Git access before retrying.");
  }
  const repositoryRoot = path.resolve(repository.stdout.trim());

  const targets = [resolvedCatalog, outputPath ? path.resolve(outputPath) : undefined].filter(Boolean);
  for (const target of targets) {
    const relativeTarget = path.relative(repositoryRoot, target);
    if (relativeTarget === "" || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
      throw new Error("Private output must stay inside the detected Git worktree.");
    }

    const gitPrefix = ["-c", `safe.directory=${repositoryRoot}`, "-C", repositoryRoot];
    const tracked = spawnSync("git", [...gitPrefix, "ls-files", "--error-unmatch", "--", relativeTarget], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (tracked.error || ![0, 1].includes(tracked.status)) {
      throw new Error("Git tracking status could not be verified for private output.");
    }
    if (tracked.status === 0) {
      throw new Error("Private output is already tracked by Git. Remove it from the index before retrying.");
    }

    const ignored = spawnSync("git", [...gitPrefix, "check-ignore", "--quiet", "--no-index", "--", relativeTarget], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (ignored.error || ![0, 1].includes(ignored.status)) {
      throw new Error("Git ignore status could not be verified for private output.");
    }
    if (ignored.status !== 0) {
      throw new Error(
        "Private output is inside a Git repository but is not ignored. Add .xhs-favorites/ and xhs-favorites/ to .gitignore, then retry.",
      );
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!options.input || !options.catalog) {
    throw new Error("--input and --catalog are required\n\n" + usage());
  }

  const now = new Date().toISOString();
  const date = validateDate(options.date ?? localDate());
  const payload = parseJson(readText(options.input), "favorites input");
  const items = findNoteArray(payload);
  if (!items) {
    throw new Error("Could not find a note array in the favorites JSON");
  }

  const normalized = [];
  const ids = new Set();
  for (const item of items) {
    const note = normalizeNote(item, now);
    if (note && !ids.has(note.note_id)) {
      ids.add(note.note_id);
      normalized.push(note);
    }
  }

  const catalog = loadCatalog(options.catalog);
  for (const [noteId, existing] of Object.entries(catalog.notes)) {
    if (!existing || typeof existing !== "object") continue;
    delete existing.xsec_token;
    const canonical = safeXhsUrl(existing.url);
    if (canonical) existing.url = canonical;
    else if (safeNoteId(noteId)) existing.url = `https://www.xiaohongshu.com/explore/${encodeURIComponent(noteId)}`;
  }
  const additions = options.baseline
    ? []
    : normalized.filter((note) => !Object.hasOwn(catalog.notes, note.note_id));

  for (const note of normalized) {
    const existing = catalog.notes[note.note_id];
    const merged = { ...existing };
    for (const [key, value] of Object.entries(note)) {
      if (value !== undefined && value !== "") merged[key] = value;
    }
    if (note.detail_fetched === true) delete merged.fetch_error;
    merged.first_seen_at = existing?.first_seen_at ?? note.first_seen_at;
    merged.last_seen_at = now;
    merged.content_sha256 = contentRevision(merged);
    catalog.notes[note.note_id] = merged;
  }
  catalog.updated_at = now;

  const existingReportRaw = options.output && fs.existsSync(path.resolve(options.output))
    ? fs.readFileSync(path.resolve(options.output), "utf8")
    : undefined;
  const existingReport = existingReportRaw === undefined
    ? undefined
    : canonicalizeReportLinks(existingReportRaw);
  const existingReportIds = existingReport ? reportNoteIds(existingReport) : new Set();
  const reportAdditions = additions.filter((note) => !existingReportIds.has(note.note_id));
  const markdown = existingReport
    ? (options.baseline
        ? updateBaselineReport(existingReport, Object.keys(catalog.notes).length, normalized.length)
        : reportAdditions.length > 0
        ? appendToReport(existingReport, reportAdditions, normalized.length)
        : ensureTruncationWarning(existingReport, normalized.length))
    : markdownFor({
        date,
        now,
        scanned: options.baseline ? Object.keys(catalog.notes).length : normalized.length,
        additions: reportAdditions,
        baseline: options.baseline,
      });
  const reportChanged = existingReportRaw === undefined || markdown !== existingReportRaw;

  if (!options.dryRun) {
    requireIgnoredPrivatePaths(options.catalog, options.output);
    if (options.output && reportChanged) atomicWrite(options.output, markdown);
    atomicWrite(options.catalog, `${JSON.stringify(catalog, null, 2)}\n`);
  }
  if (!options.output || options.dryRun) process.stdout.write(markdown);

  process.stderr.write(
    `${JSON.stringify({
      scanned: normalized.length,
      new: additions.length,
      appended_to_report: reportAdditions.length,
      possibly_truncated: normalized.length >= 30,
      baseline: options.baseline,
    })}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`xhs-favorites-organizer: ${error.message}\n`);
  process.exitCode = 1;
}
