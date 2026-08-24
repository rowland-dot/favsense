#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveCategoryPolicy } from "./category-policy.mjs";
import {
  currentFormalRevisions,
  formalCurationDecision,
  formalContentKind,
  isPublishableCuration,
  loadCurationAudit,
  loadFormalPointSummary,
} from "./curation-quality.mjs";
import { confirmedSkillResource } from "./resource-quality.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const workspace = path.resolve(path.dirname(scriptPath), "../../..");

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`Invalid argument near ${key ?? "end"}`);
    options[key.slice(2)] = value;
  }
  for (const required of ["catalog", "config", "curation", "output"]) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  return options;
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(path.resolve(file), "utf8").replace(/^\uFEFF/, "")); }
  catch (error) { throw new Error(`${label} could not be read: ${error.message}`); }
}

function atomicWrite(file, content) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, content, "utf8"); fs.renameSync(temporary, resolved); }
  finally { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); }
}

function assertPlainOutputAncestors(base, output) {
  const root = path.resolve(base);
  const target = path.resolve(output);
  const relative = path.relative(root, target);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Knowledge base output escaped its verified root");
  }
  let current = root;
  const segments = relative ? relative.split(path.sep) : [];
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const metadata = fs.lstatSync(current);
    if (metadata.isSymbolicLink() || (index < segments.length - 1 && !metadata.isDirectory())) {
      throw new Error("Knowledge base output has a redirected or invalid ancestor");
    }
  }
}

export function requirePrivateOutput(output) {
  let current = path.resolve(output);
  while (!fs.existsSync(path.join(current, ".git"))) {
    const parent = path.dirname(current);
    if (parent === current) {
      assertPlainOutputAncestors(path.parse(path.resolve(output)).root, output);
      return null;
    }
    current = parent;
  }
  const repository = spawnSync("git", [
    "-c", `safe.directory=${current}`,
    "-C", current,
    "rev-parse", "--show-toplevel",
  ], { encoding: "utf8", windowsHide: true });
  if (repository.status !== 0) throw new Error("Git privacy status could not be verified");
  const root = path.resolve(repository.stdout.trim());
  const relative = path.relative(root, path.resolve(output));
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Knowledge base output must stay inside the Git worktree");
  assertPlainOutputAncestors(root, output);
  const gitPrefix = ["-c", `safe.directory=${root}`, "-C", root];
  const tracked = spawnSync("git", [...gitPrefix, "ls-files", "--error-unmatch", "--", relative], { encoding: "utf8", windowsHide: true });
  if (tracked.status === 0) throw new Error("Knowledge base output is tracked by Git; remove it from the index before rebuilding");
  const ignored = spawnSync("git", [...gitPrefix, "check-ignore", "--quiet", "--no-index", "--", relative], { encoding: "utf8", windowsHide: true });
  if (ignored.status !== 0) throw new Error("Knowledge base output is not ignored by Git; add it to .gitignore before rebuilding");
  return root;
}

export function privateTransactionDirectory(repositoryRoot, liveOutput) {
  if (repositoryRoot === null) {
    return path.join(path.dirname(liveOutput), ".favsense-private-transactions");
  }
  const toolsRoot = path.join(repositoryRoot, ".xhs-tools");
  const transactionRoot = path.join(toolsRoot, "knowledge-base-transactions");
  for (const candidate of [toolsRoot, transactionRoot]) {
    if (!fs.existsSync(candidate)) continue;
    const metadata = fs.lstatSync(candidate);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Knowledge base transaction storage must be a plain private directory");
    }
  }
  const ignored = spawnSync("git", [
    "-c", `safe.directory=${repositoryRoot}`,
    "-C", repositoryRoot,
    "check-ignore", "--quiet", "--no-index", "--",
    path.relative(repositoryRoot, path.join(transactionRoot, "privacy-probe")),
  ], { encoding: "utf8", windowsHide: true });
  if (ignored.status !== 0) {
    throw new Error("Knowledge base transaction storage is not protected by Git ignore rules");
  }
  return transactionRoot;
}

function removeEmptyDirectory(directory) {
  try { fs.rmdirSync(directory); return true; } catch { return false; }
}

export function knowledgeTransactionJournalPath(transactionRoot, liveOutput) {
  const identity = knowledgeOutputIdentity(liveOutput);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return path.join(path.resolve(transactionRoot), `transaction-${digest}.json`);
}

function knowledgeOutputIdentity(liveOutput) {
  const resolved = path.resolve(liveOutput);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function acquireKnowledgeBuildLock(
  transactionRoot,
  liveOutput,
  fileSystem = fs,
  { isProcessAlive = processIsAlive } = {},
) {
  const digest = createHash("sha256").update(knowledgeOutputIdentity(liveOutput)).digest("hex").slice(0, 24);
  const lockPath = path.join(path.resolve(transactionRoot), `build-${digest}.lock`);
  const owner = { version: 1, owner_pid: process.pid, owner_id: randomUUID() };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const claimPath = `${lockPath}.claim-${owner.owner_id}-${attempt}`;
    try {
      fileSystem.mkdirSync(claimPath);
      fileSystem.writeFileSync(path.join(claimPath, "owner.json"), `${JSON.stringify(owner)}\n`, "utf8");
      fileSystem.renameSync(claimPath, lockPath);
      return { lockPath, ownerId: owner.owner_id };
    } catch (error) {
      if (fileSystem.existsSync(claimPath)) {
        try { removePlainTransactionDirectory(claimPath, fileSystem); } catch { /* preserve unsafe claims */ }
      }
      if (!fileSystem.existsSync(lockPath)) {
        if (["EEXIST", "ENOTEMPTY", "EPERM", "ENOENT"].includes(error?.code)) continue;
        throw error;
      }
    }
    const metadata = fileSystem.lstatSync(lockPath);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Knowledge base build lock is redirected or invalid");
    }
    let existingOwner = null;
    try { existingOwner = JSON.parse(fileSystem.readFileSync(path.join(lockPath, "owner.json"), "utf8")); } catch { /* pre-atomic legacy lock */ }
    if (Number.isSafeInteger(existingOwner?.owner_pid) && isProcessAlive(existingOwner.owner_pid)) {
      throw new Error("A knowledge base build is already running; no files were changed");
    }
    const staleIdentity = (
      typeof existingOwner?.owner_id === "string"
      && /^[A-Za-z0-9-]{1,128}$/.test(existingOwner.owner_id)
    ) ? existingOwner.owner_id : "invalid";
    // Keep the deterministic tombstone. A delayed second reclaimer that read
    // this same owner can no longer rename a newer lock into the same path.
    const tombstone = `${lockPath}.stale-${staleIdentity}`;
    try { fileSystem.renameSync(lockPath, tombstone); }
    catch (error) {
      if (["ENOENT", "EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) continue;
      throw error;
    }
  }
  throw new Error("Knowledge base build lock could not be acquired safely");
}

export function releaseKnowledgeBuildLock(lock, fileSystem = fs) {
  if (!lock || !fileSystem.existsSync(lock.lockPath)) return;
  const metadata = fileSystem.lstatSync(lock.lockPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Knowledge base build lock changed while held");
  }
  let owner;
  try { owner = JSON.parse(fileSystem.readFileSync(path.join(lock.lockPath, "owner.json"), "utf8")); }
  catch { throw new Error("Knowledge base build lock ownership could not be verified"); }
  if (owner?.owner_id !== lock.ownerId) {
    throw new Error("Knowledge base build lock was replaced; it was preserved");
  }
  removePlainTransactionDirectory(lock.lockPath, fileSystem);
}

function transactionChild(transactionRoot, candidate, prefix) {
  if (typeof candidate !== "string" || !candidate) {
    throw new Error("Knowledge base transaction journal is incomplete");
  }
  const root = path.resolve(transactionRoot);
  const resolved = path.resolve(candidate);
  if (
    knowledgeOutputIdentity(path.dirname(resolved)) !== knowledgeOutputIdentity(root)
    || !path.basename(resolved).startsWith(prefix)
  ) {
    throw new Error("Knowledge base transaction journal contains an unsafe path");
  }
  return resolved;
}

function removePlainTransactionDirectory(directory, fileSystem = fs) {
  if (!fileSystem.existsSync(directory)) return;
  const metadata = fileSystem.lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Knowledge base transaction entry is redirected or invalid");
  }
  fileSystem.rmSync(directory, { recursive: true, force: true });
}

export function writeKnowledgeTransactionJournal({
  journalPath, transactionRoot, liveOutput, stagingOutput, backupOutput,
  ownerPid = process.pid, transactionId = randomUUID(),
}, fileSystem = fs) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || typeof transactionId !== "string" || !transactionId) {
    throw new Error("Knowledge base transaction ownership is invalid");
  }
  const record = {
    version: 2,
    phase: "building",
    transaction_id: transactionId,
    owner_pid: ownerPid,
    live_output: path.resolve(liveOutput),
    staging_output: transactionChild(transactionRoot, stagingOutput, "stage-"),
    backup_output: transactionChild(transactionRoot, backupOutput, ".favsense-backup-"),
  };
  const resolvedJournal = path.resolve(journalPath);
  const claimPath = `${resolvedJournal}.claim-${process.pid}-${randomUUID()}.tmp`;
  fileSystem.mkdirSync(path.dirname(resolvedJournal), { recursive: true });
  let descriptor;
  try {
    descriptor = fileSystem.openSync(claimPath, "wx", 0o600);
    fileSystem.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    fileSystem.linkSync(claimPath, resolvedJournal);
    const claimPrefix = `${path.basename(resolvedJournal)}.claim-`;
    const claimPattern = new RegExp(
      `^${claimPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+-[0-9a-f-]{36}\\.tmp$`,
    );
    for (const entry of fileSystem.readdirSync(path.dirname(resolvedJournal))) {
      if (!claimPattern.test(entry)) continue;
      const candidate = path.join(path.dirname(resolvedJournal), entry);
      try {
        const metadata = fileSystem.lstatSync(candidate);
        if (metadata.isFile() && !metadata.isSymbolicLink()) {
          fileSystem.rmSync(candidate, { force: true });
        }
      } catch {
        // The journal is already committed; a concurrently open claim may clean itself up.
      }
    }
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("A previous knowledge base transaction still requires recovery");
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
    if (fileSystem.existsSync(claimPath)) fileSystem.rmSync(claimPath, { force: true });
  }
  return record;
}

export function markKnowledgeTransactionPrepared(journalPath, record) {
  if (record?.phase !== "building") throw new Error("Knowledge base transaction is not in its building phase");
  const prepared = { ...record, phase: "prepared" };
  atomicWrite(journalPath, `${JSON.stringify(prepared)}\n`);
  return prepared;
}

export function markKnowledgeTransactionCommitted(journalPath, record) {
  if (record?.phase !== "prepared") throw new Error("Knowledge base transaction is not prepared for commit");
  const committed = { ...record, phase: "committed" };
  atomicWrite(journalPath, `${JSON.stringify(committed)}\n`);
  return committed;
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

export function recoverKnowledgeTransaction(
  liveOutput,
  transactionRoot,
  journalPath,
  fileSystem = fs,
  { expectedTransactionId = null, isProcessAlive = processIsAlive } = {},
) {
  if (!fileSystem.existsSync(journalPath)) return "none";
  const journalMetadata = fileSystem.lstatSync(journalPath);
  if (journalMetadata.isSymbolicLink() || !journalMetadata.isFile() || journalMetadata.size > 32 * 1024) {
    throw new Error("Knowledge base transaction journal is redirected or invalid");
  }
  let record;
  try { record = JSON.parse(fileSystem.readFileSync(journalPath, "utf8")); }
  catch { throw new Error("Knowledge base transaction journal is not valid JSON"); }
  const resolvedLive = path.resolve(liveOutput);
  if (
    record?.version !== 2
    || !["building", "prepared", "committed"].includes(record.phase)
    || typeof record.transaction_id !== "string"
    || !record.transaction_id
    || !Number.isSafeInteger(record.owner_pid)
    || record.owner_pid <= 0
    || knowledgeOutputIdentity(String(record.live_output || "")) !== knowledgeOutputIdentity(resolvedLive)
  ) {
    throw new Error("Knowledge base transaction journal does not match this output");
  }
  if (expectedTransactionId !== null && record.transaction_id !== expectedTransactionId) {
    throw new Error("Knowledge base transaction journal was replaced by another build; no files were changed");
  }
  if (expectedTransactionId === null && isProcessAlive(record.owner_pid)) {
    throw new Error("A knowledge base build is already running; no files were changed");
  }
  const stagingOutput = transactionChild(transactionRoot, record.staging_output, "stage-");
  const backupOutput = transactionChild(transactionRoot, record.backup_output, ".favsense-backup-");
  const hasLive = fileSystem.existsSync(resolvedLive);
  const hasStage = fileSystem.existsSync(stagingOutput);
  const hasBackup = fileSystem.existsSync(backupOutput);
  if (hasLive && hasStage && hasBackup) {
    throw new Error("Knowledge base transaction state is ambiguous; no files were changed");
  }
  let outcome = "discarded";
  if (record.phase === "building") {
    if (hasBackup) {
      throw new Error("A building knowledge base transaction unexpectedly contains a backup; no files were changed");
    }
    removePlainTransactionDirectory(stagingOutput, fileSystem);
  } else if (!hasLive && hasBackup) {
    const backupMetadata = fileSystem.lstatSync(backupOutput);
    if (backupMetadata.isSymbolicLink() || !backupMetadata.isDirectory()) {
      throw new Error("Knowledge base transaction backup is redirected or invalid");
    }
    fileSystem.renameSync(backupOutput, resolvedLive);
    removePlainTransactionDirectory(stagingOutput, fileSystem);
    outcome = "restored";
  } else if (hasLive) {
    if (record.phase === "prepared" && hasBackup) {
      throw new Error("An uncommitted knowledge base transaction conflicts with a replacement live directory; both copies were preserved");
    }
    removePlainTransactionDirectory(stagingOutput, fileSystem);
    removePlainTransactionDirectory(backupOutput, fileSystem);
    outcome = hasBackup ? "committed" : "discarded";
  } else {
    removePlainTransactionDirectory(stagingOutput, fileSystem);
  }
  fileSystem.rmSync(journalPath, { force: true });
  return outcome;
}

const GENERATED_KNOWLEDGE_FILES = new Set([
  "00-首页.md",
  "README.md",
  "03-工具雷达/工具索引.md",
  "04-行动与实验/行动清单.md",
  "04-行动与实验/使用建议.md",
  "05-Skills成果/GitHub-Skills核验清单.md",
  "90-来源索引/小红书面板.md",
  "99-模板/收藏卡片模板.md",
]);

function slashPath(value) {
  return value.split(path.sep).join("/");
}

function isGeneratedKnowledgeFile(relative, content) {
  if (GENERATED_KNOWLEDGE_FILES.has(relative)) return true;
  const marker = relative.startsWith("01-主题地图/")
    ? "type: moc"
    : relative.startsWith("02-知识卡片/")
      ? "type: xhs-knowledge-card"
      : "";
  return Boolean(marker) && content.subarray(0, 300).toString("utf8").includes(marker);
}

export function copyManualFilesNoLinks(source, destination, fileSystem = fs) {
  const root = path.resolve(source);
  const targetRoot = path.resolve(destination);
  const visit = (current) => {
    const metadata = fileSystem.lstatSync(current);
    if (metadata.isSymbolicLink()) throw new Error("Knowledge base output contains a redirected path");
    const relative = slashPath(path.relative(root, current));
    const target = relative ? path.join(targetRoot, ...relative.split("/")) : targetRoot;
    if (metadata.isDirectory()) {
      if (fileSystem.existsSync(target)) {
        const targetMetadata = fileSystem.lstatSync(target);
        if (targetMetadata.isSymbolicLink() || !targetMetadata.isDirectory()) {
          throw new Error(`Manual knowledge-base directory conflicts with generated output: ${relative || "."}`);
        }
      } else {
        fileSystem.mkdirSync(target, { recursive: true });
      }
      for (const name of [...fileSystem.readdirSync(current)].sort()) visit(path.join(current, name));
      return;
    }
    if (!metadata.isFile()) throw new Error("Knowledge base output contains an unsupported filesystem entry");
    const content = fileSystem.readFileSync(current);
    if (isGeneratedKnowledgeFile(relative, content)) return;
    if (fileSystem.existsSync(target)) {
      throw new Error(`Manual knowledge-base file conflicts with generated output: ${relative}`);
    }
    fileSystem.mkdirSync(path.dirname(target), { recursive: true });
    fileSystem.linkSync(current, target);
  };
  visit(root);
}

export function publishStagedDirectory(
  liveOutput,
  stagingOutput,
  fileSystem = fs,
  prepareMovedLive = null,
  backupOutput = null,
  markCommitted = null,
) {
  const backup = backupOutput || path.join(
    path.dirname(stagingOutput),
    `.favsense-backup-${path.basename(liveOutput)}-${process.pid}-${Date.now()}`,
  );
  if (fileSystem.existsSync(backup)) throw new Error("Knowledge base transaction backup already exists");
  const hadLiveOutput = fileSystem.existsSync(liveOutput);
  let movedLiveOutput = false;
  let stagedPublished = false;
  try {
    if (hadLiveOutput) {
      fileSystem.renameSync(liveOutput, backup);
      movedLiveOutput = true;
      if (prepareMovedLive) prepareMovedLive(backup, stagingOutput);
    }
    fileSystem.renameSync(stagingOutput, liveOutput);
    stagedPublished = true;
    if (markCommitted) markCommitted();
  } catch (error) {
    if (movedLiveOutput && fileSystem.existsSync(backup)) {
      if (stagedPublished && fileSystem.existsSync(liveOutput) && !fileSystem.existsSync(stagingOutput)) {
        fileSystem.renameSync(liveOutput, stagingOutput);
      }
      if (!fileSystem.existsSync(liveOutput)) {
        fileSystem.renameSync(backup, liveOutput);
        movedLiveOutput = false;
      }
    }
    throw error;
  } finally {
    if (fileSystem.existsSync(stagingOutput)) {
      fileSystem.rmSync(stagingOutput, { recursive: true, force: true });
    }
  }
  let cleanupWarning = "";
  if (movedLiveOutput && fileSystem.existsSync(backup)) {
    try {
      fileSystem.rmSync(backup, { recursive: true, force: true });
    } catch {
      cleanupWarning = "The new knowledge base was published, but its private backup could not be removed because another process is using it";
    }
  }
  return { cleanupWarning, retainedBackup: cleanupWarning ? backup : "" };
}

function clean(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function normalizedDate(value, label) {
  const date = clean(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  return date;
}
function yaml(value) { return JSON.stringify(clean(value)); }
function md(value) { return clean(value).replace(/([\\`*_[\]<>])/g, "\\$1"); }
function mdBody(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .split("\n")
    .map((line) => line.replace(/([\\`*_[\]<>])/g, "\\$1"))
    .join("\n");
}
function publicSourceUrl(title, author) {
  const params = new URLSearchParams({
    keyword: [title, author].filter(Boolean).join(" "),
    source: "web_search_result_notes"
  });
  return `https://www.xiaohongshu.com/search_result?${params.toString()}`;
}
function safeFileSegment(value, label) {
  const segment = clean(value);
  if (
    !segment
    || segment === "."
    || segment === ".."
    || /[\u0000-\u001f<>:"/\\|?*]/.test(segment)
    || /[. ]$/.test(segment)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)
  ) {
    throw new Error(`${label} is not safe for a generated filename: ${segment || "<empty>"}`);
  }
  return segment;
}

function containedFile(directory, filename) {
  const base = path.resolve(directory);
  const target = path.resolve(base, filename);
  if (path.dirname(target) !== base) throw new Error(`generated file escaped its output directory: ${filename}`);
  return target;
}
function inferredTitle(note) {
  if (clean(note.title)) return clean(note.title);
  const plain = clean(note.description).replace(/#[^#]+\[话题\]#/g, "").replace(/#[^\s#]+/g, "").trim();
  return plain ? `${plain.slice(0, 42)}${plain.length > 42 ? "…" : ""}` : `无标题笔记 ${note.note_id}`;
}

function fallback(note, profile) {
  const haystack = `${note.title ?? ""} ${note.description ?? ""} ${note.tags ?? ""}`;
  const match = (profile.fallback?.rules || []).find((rule) => new RegExp(rule.pattern, "i").test(haystack));
  const category = match?.category || profile.fallback?.default_category || "待分类";
  const summary = clean(note.description).replace(/#[^#]+\[话题\]#/g, "").slice(0, 90) || "正文信息待补充。";
  return {
    category,
    themes: [category],
    summary,
    action: "",
    tools: []
  };
}

function related(notes, current) {
  const currentThemes = new Set(current.curation.themes);
  return notes.filter((item) => item.id !== current.id).map((item) => ({
    item,
    score: item.curation.themes.filter((theme) => currentThemes.has(theme)).length + (item.curation.category === current.curation.category ? 1 : 0),
  })).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title, "zh-CN")).slice(0, 3).map(({ item }) => item);
}

function noteMarkdown(item, relatedItems) {
  const note = item.note;
  const c = item.curation;
  const sourceBoards = item.sourceBoards;
  const original = clean(note.description);
  const excerpt = original.length > 700 ? `${original.slice(0, 700)}…` : original;
  const commentEvidence = Array.isArray(note.comment_evidence)
    ? note.comment_evidence.filter((item) => item && clean(item.text)).slice(0, 12)
    : [];
  return `---
type: xhs-knowledge-card
note_id: ${yaml(item.id)}
title: ${yaml(item.title)}
author: ${yaml(note.author || "未知作者")}
source: xiaohongshu
source_boards: [${sourceBoards.map(yaml).join(", ")}]
category: ${yaml(c.category)}
category_source: ${yaml(c.categorySource)}
suggested_category: ${yaml(c.suggestedCategory || "")}
themes: [${c.themes.map(yaml).join(", ")}]
content_kind: ${yaml(c.kind || "自动判断")}
published_at: ${yaml(note.published_at || "")}
last_seen_at: ${yaml(note.last_seen_at || "")}
---

# ${md(item.title)}

> [!summary] 一句话结论
> ${md(c.summary)}

${item.deepSummary ? `## 点点 AI 深度总结

${mdBody(item.deepSummary)}

` : ""}${item.skillResource ? `## Skill 核验

- 资源 ID：${md(item.skillResource.id)}
- 官方名称：${md(item.skillResource.name)}
- 类型：${md(item.skillResource.type)}
- 官方仓库：${md(item.skillResource.repo)}
- 下载 ZIP：${md(item.skillResource.download)}
- Stars：${md(item.skillResource.stars ?? item.skillResource.stars_numeric)}
- 核验日期：${md(item.skillResource.verified_at)}
- 许可证：${md(item.skillResource.license)}
- Skill manifest：${md(item.skillResource.skill_manifest)}
- 兼容性：${md((item.skillResource.compatibility || []).join("、"))}
- 核验状态：${md(item.skillResource.status)}

` : ""}## 为什么值得看

- 主题：${c.themes.map((v) => `#${md(v)}`).join(" ")}
- 内容形态：${md(c.kind || "自动判断")}
- 来源面板：${sourceBoards.map(md).join("、")}
${c.suggestedCategory ? `- 内容建议分类：${md(c.suggestedCategory)}（主分类仍按收藏夹归档）` : ""}

${c.action ? `## 怎么用

- ${md(c.action)}

` : ""}## 涉及工具

${c.tools.length ? c.tools.map((tool) => `- [[03-工具雷达/工具索引#${md(tool)}|${md(tool)}]]`).join("\n") : "- 待确认"}

## 关联卡片

${relatedItems.length ? relatedItems.map((other) => `- [[02-知识卡片/${other.id}|${md(other.title)}]]`).join("\n") : "- 暂无"}

## 来源摘录

${excerpt ? md(excerpt) : "正文待补充。"}

## 评论区线索

${commentEvidence.length
    ? `${commentEvidence.map((item) => `- ${item.reply ? "回复：" : ""}${md(clean(item.text))}${item.liked_count ? `（${md(item.liked_count)} 赞）` : ""}`).join("\n")}\n\n> 评论内容仅作补充线索，未经事实核验；评论者身份未保存。`
    : "- 本轮未取得可用的评论区线索。"}

## 原始来源

- 作者：${md(note.author || "未知作者")}
- [在小红书搜索原帖](${publicSourceUrl(item.title, note.author || "")})
`;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const catalog = readJson(options.catalog, "catalog");
  const config = readJson(options.config, "config");
  const curated = readJson(options.curation, "curation");
  const profilePath = options.profile
    ? path.resolve(options.profile)
    : path.resolve(workspace, config.domain_profile || "config/domain-profiles/software.json");
  const profile = readJson(profilePath, "domain profile");
  const resourceRegistry = profile.features?.resource_index
    ? readJson(
      options.resources
        ? path.resolve(options.resources)
        : path.resolve(workspace, profile.resource_index?.registry_file
          || "skills/xhs-favorites-organizer/references/software-resources.json"),
      "resource registry"
    )
    : { resources: [] };
  const diandianDirectory = options["diandian-dir"]
    ? path.resolve(options["diandian-dir"])
    : path.resolve(workspace, ".xhs-favorites/diandian-summaries");
  const buildVersion = String(options["build-version"] || "");
  if (buildVersion && !/^[a-f0-9]{64}$/.test(buildVersion)) throw new Error("--build-version must be a 64-character lowercase SHA-256");
  const rawResources = resourceRegistry[profile.resource_index?.collection || "resources"] || [];
  const resourceByAlias = new Map();
  for (const resource of rawResources) {
    for (const alias of [resource.name, ...(resource.aliases || [])]) {
      resourceByAlias.set(clean(alias).toLocaleLowerCase("zh-CN"), resource);
    }
  }
  const {
    policy: curationQuality,
    audit: curationAudit,
    baselineIds: curationBaselineIds,
    baselineRevisions: curationBaselineRevisions
  } = loadCurationAudit(workspace, config);
  const publishedSince = config.published_since
    ? normalizedDate(config.published_since, "published_since")
    : "";
  const notes = Object.entries(catalog.notes ?? {}).map(([id, note]) => {
    const hasCuration = Object.hasOwn(curated, id);
    const candidateEntry = hasCuration ? curated[id] : fallback(note, profile);
    const candidateKind = clean(candidateEntry.kind || profile.fallback?.default_kind || profile.classification?.default || "Note");
    const matchingResources = (candidateEntry.tools || [])
      .map((tool) => resourceByAlias.get(clean(tool).toLocaleLowerCase("zh-CN"))).filter(Boolean);
    const skillResource = candidateKind === "Skill"
      ? confirmedSkillResource(matchingResources, { today: new Date().toISOString().slice(0, 10), maxAgeDays: 30 })
      : null;
    const currentRevisions = currentFormalRevisions(note, candidateEntry, skillResource);
    const isCurated = hasCuration
      && isPublishableCuration(
        id,
        note,
        curated,
        curationQuality,
        curationAudit,
        curationBaselineIds,
        curationBaselineRevisions,
        { config, resources: resourceRegistry, ...(currentRevisions ? { currentRevisions } : {}) }
      );
    const entry = { ...fallback(note, profile), ...(isCurated ? curated[id] : {}) };
    const categoryPolicy = resolveCategoryPolicy({
      entry,
      note,
      config,
      profile,
      entryOrigin: isCurated ? "curation" : "content_rule"
    });
    const curation = {
      ...entry,
      category: categoryPolicy.category,
      categorySource: categoryPolicy.categorySource,
      suggestedCategory: categoryPolicy.suggestedCategory,
      categoryReason: categoryPolicy.categoryReason,
      themes: categoryPolicy.themes
    };
    const point = loadFormalPointSummary(diandianDirectory, id);
    const formalDecision = formalCurationDecision({
      publishable: isCurated,
      auditEntry: curationAudit?.notes?.[id],
      currentRevisions,
      point,
      kind: candidateKind,
      resource: skillResource,
    });
    const projectedCuration = candidateKind === "Skill"
      ? {
          ...curation,
          kind: formalContentKind(profile, candidateKind, formalDecision.accepted && Boolean(skillResource)),
          tools: formalDecision.accepted && skillResource ? [skillResource.name] : [],
        }
      : curation;
    return {
      id,
      note,
      title: entry.title || inferredTitle(note),
      curation: projectedCuration,
      sourceBoards: categoryPolicy.sourceBoards,
      deepSummary: formalDecision.summary_source === "point" ? point?.summary || null : null,
      formalDecision,
      candidateKind,
      skillResource: formalDecision.accepted ? skillResource : null,
    };
  }).sort((a, b) => (a.curation.category + a.title).localeCompare(b.curation.category + b.title, "zh-CN"));
  const safeNoteIds = new Map(notes.map((item) => [item.id, safeFileSegment(item.id, "note id")]));
  const safeCategories = new Map(notes.map((item) => [item.curation.category, safeFileSegment(item.curation.category, "category")]));
  const liveOutput = path.resolve(options.output);
  const repositoryRoot = requirePrivateOutput(liveOutput);
  const transactionRoot = privateTransactionDirectory(repositoryRoot, liveOutput);
  fs.mkdirSync(transactionRoot, { recursive: true });
  if (fs.lstatSync(transactionRoot).isSymbolicLink()) {
    throw new Error("Knowledge base transaction storage must not be redirected");
  }
  const journalPath = knowledgeTransactionJournalPath(transactionRoot, liveOutput);
  const buildLock = acquireKnowledgeBuildLock(transactionRoot, liveOutput);
  try {
  recoverKnowledgeTransaction(liveOutput, transactionRoot, journalPath);
  const stagingOutput = path.join(
    transactionRoot,
    `stage-${path.basename(liveOutput)}-${process.pid}-${Date.now()}`,
  );
  if (fs.existsSync(stagingOutput)) {
    throw new Error("Knowledge base staging path already exists");
  }
  const backupOutput = path.join(
    transactionRoot,
    `.favsense-backup-${path.basename(liveOutput)}-${process.pid}-${Date.now()}`,
  );
  let activeTransaction = null;
  try {
    activeTransaction = writeKnowledgeTransactionJournal({
      journalPath,
      transactionRoot,
      liveOutput,
      stagingOutput,
      backupOutput,
    });
    fs.mkdirSync(stagingOutput, { recursive: true });
    const output = stagingOutput;
    const now = new Date().toISOString();

  const cardsDirectory = path.join(output, "02-知识卡片");
  for (const item of notes) {
    const noteId = safeNoteIds.get(item.id);
    atomicWrite(containedFile(cardsDirectory, `${noteId}.md`), noteMarkdown(item, related(notes, item)));
  }

  const categories = new Map();
  for (const item of notes) {
    if (!categories.has(item.curation.category)) categories.set(item.curation.category, []);
    categories.get(item.curation.category).push(item);
  }
  for (const [category, items] of [...categories].sort(([a], [b]) => a.localeCompare(b, "zh-CN"))) {
    const body = `---\ntype: moc\ncategory: ${yaml(category)}\nupdated_at: ${yaml(now)}\n---\n\n# ${md(category)}\n\n共 ${items.length} 张知识卡片。\n\n${items.map((item) => `- [[02-知识卡片/${item.id}|${md(item.title)}]] — ${md(item.curation.summary)}`).join("\n")}\n`;
    const categoryName = safeCategories.get(category);
    atomicWrite(containedFile(path.join(output, "01-主题地图"), `${categoryName}.md`), body);
  }

  const allTools = new Map();
  for (const item of notes) for (const tool of item.curation.tools) {
    if (!allTools.has(tool)) allTools.set(tool, []);
    allTools.get(tool).push(item);
  }
  const toolBody = `# 工具雷达\n\n> 自动汇集收藏中明确出现的工具；使用前请通过官方来源确认权限、许可证和适用范围。\n\n${[...allTools].sort(([a], [b]) => a.localeCompare(b, "zh-CN")).map(([tool, items]) => `## ${md(tool)}\n\n- 来自：${items.map((item) => `[[02-知识卡片/${item.id}|${md(item.title)}]]`).join("、")}\n`).join("\n")}\n`;
  atomicWrite(path.join(output, "03-工具雷达", "工具索引.md"), toolBody);

  const suggestions = [...categories]
    .sort(([a], [b]) => a.localeCompare(b, "zh-CN"))
    .map(([category, items]) => [category, items.filter((item) => item.curation.action)])
    .filter(([, items]) => items.length)
    .map(([category, items]) => `## ${md(category)}\n\n${items.map((item) => `- ${md(item.curation.action)} — [[02-知识卡片/${item.id}|${md(item.title)}]]`).join("\n")}`)
    .join("\n\n");
  atomicWrite(path.join(output, "04-行动与实验", "使用建议.md"), `# 使用建议\n\n> 系统从收藏中自动提取的应用方式，不是需要逐项完成的任务。需要时查阅即可。\n\n${suggestions}\n`);

  const confirmedSkills = notes.filter((item) => item.formalDecision.accepted && item.skillResource);
  const skillRows = confirmedSkills.map((item) => {
    const resource = item.skillResource;
    return `| ${md(resource.name)} | ${md(resource.type)} | ${md(resource.repo)} | ${md(resource.download)} | ${md(resource.stars ?? resource.stars_numeric)} | ${md(resource.verified_at)} | ${md(resource.license)} | ${md(resource.skill_manifest)} | ${md((resource.compatibility || []).join("、"))} | ${md(resource.status)} |`;
  }).join("\n");
  atomicWrite(path.join(output, "05-Skills成果", "GitHub-Skills核验清单.md"), `# GitHub Skills 核验清单\n\n> 仅列出已审核、当前且具有唯一新鲜官方资源证据的 Skill。候选项不会生成猜测链接。\n\n| 名称 | 类型 | 官方仓库 | 下载 ZIP | Stars | 核验日期 | 许可证 | Skill manifest | 兼容性 | 状态 |\n|---|---|---|---|---:|---|---|---|---|---|\n${skillRows || "| 暂无已确认 Skill | - | - | - | - | - | - | - | - | pending |"}\n`);

  const boards = config.boards.map((board) => {
    const state = board.enabled ? "纳入同步" : `排除（${board.reason ?? "未启用"}）`;
    const captured = notes.filter((item) => item.sourceBoards.includes(board.name)).length;
    return `| ${md(board.name)} | ${state} | ${board.advertised_count ?? "-"} | ${captured} |`;
  }).join("\n");
  atomicWrite(path.join(output, "90-来源索引", "小红书面板.md"), `# 小红书面板索引\n\n| 面板 | 状态 | 页面显示 | 已入库 |\n|---|---:|---:|---:|\n${boards}\n\n> 页面显示数量只用于完整性检查；小红书可能因加载和风控只提供部分可见条目。\n`);

  const categoryLinks = [...categories].sort(([a], [b]) => a.localeCompare(b, "zh-CN")).map(([category, items]) => `- [[01-主题地图/${category}|${md(category)}]]（${items.length}）`).join("\n");
  const excludedBoards = config.boards.filter((board) => !board.enabled).map((board) => board.name);
  const exclusionNote = excludedBoards.length ? `；已排除：${excludedBoards.map(md).join("、")}` : "";
  atomicWrite(path.join(output, "00-首页.md"), `---\ntype: dashboard\ndomain_profile: ${yaml(profile.id)}\ngenerated_at: ${yaml(now)}\n---\n\n# ${md(profile.presentation?.title || "小红书知识库")}\n\n> 灵感在小红书发生，沉淀在知识工作台完成；收藏的终点不是归档，而是可检索、可关联、可复用。\n\n## 知识库概览\n\n- 已整理：**${notes.length}** 篇\n${publishedSince ? `- 深度处理范围：**${publishedSince} 起发布**\n` : ""}- 来源面板：**${config.boards.filter((board) => board.enabled).length}** 个${exclusionNote}\n- [[04-行动与实验/使用建议|查看使用建议]]\n- [[03-工具雷达/工具索引|查看工具雷达]]\n- [[90-来源索引/小红书面板|查看同步完整性]]\n\n## 主题地图\n\n${categoryLinks}\n\n## 自动整理流程\n\n1. 新收藏进入本地 catalog。\n2. 构建器保留 catalog 中的历史知识卡片；发布日期下限只控制新增内容的深度媒体处理。默认以收藏夹建立主分类，内容识别负责补充主题与分类建议。\n3. 系统提取可实践建议；需要时查阅，不生成待办。\n`);
  atomicWrite(path.join(output, "99-模板", "收藏卡片模板.md"), `# {{title}}\n\n> [!summary] 一句话结论\n+> \n+\n## 为什么值得看\n+\n+## 怎么用\n+\n+\n+## 关联卡片\n+\n+## 原始来源\n+`);
    atomicWrite(path.join(output, "README.md"), `# 小红书知识库\n\n请在 Obsidian 中把本目录作为 Vault 打开，从 [[00-首页]] 开始。知识卡片文件名使用稳定的小红书 note ID，标题显示在笔记内部和双链别名中。\n`);
    activeTransaction = markKnowledgeTransactionPrepared(journalPath, activeTransaction);
    const publishResult = publishStagedDirectory(
      liveOutput,
      stagingOutput,
      fs,
      (movedLiveOutput, stagedOutput) => copyManualFilesNoLinks(movedLiveOutput, stagedOutput),
      backupOutput,
      () => { activeTransaction = markKnowledgeTransactionCommitted(journalPath, activeTransaction); },
    );
    if (publishResult.cleanupWarning) process.stderr.write(`knowledge-base-builder warning: ${publishResult.cleanupWarning}\n`);
    else {
      fs.rmSync(journalPath, { force: true });
      activeTransaction = null;
      removeEmptyDirectory(transactionRoot);
    }
    process.stdout.write(JSON.stringify({ ok: true, notes: notes.length, categories: categories.size, tools: allTools.size, output: liveOutput }, null, 2) + "\n");
  } catch (error) {
    if (activeTransaction !== null) {
      try {
        recoverKnowledgeTransaction(liveOutput, transactionRoot, journalPath, fs, {
          expectedTransactionId: activeTransaction.transaction_id,
        });
      }
      catch {
        throw new Error("Knowledge base build failed and its private transaction could not be recovered automatically");
      }
    } else if (fs.existsSync(stagingOutput)) {
      removePlainTransactionDirectory(stagingOutput);
    }
    removeEmptyDirectory(transactionRoot);
    throw error;
  }
  } finally {
    releaseKnowledgeBuildLock(buildLock);
    removeEmptyDirectory(transactionRoot);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try { main(); } catch (error) { process.stderr.write(`knowledge-base-builder: ${error.message}\n`); process.exitCode = 1; }
}
