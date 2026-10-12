#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadCurationAudit, loadFormalPointSummary } from "./curation-quality.mjs";
import { judgePublicNote, validateContentKindProfile } from "./public-judgement.mjs";
import { worktreeBase } from "./worktree-base.mjs";

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
  const base = worktreeBase(current, root);
  const relative = path.relative(base, path.resolve(output));
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Knowledge base output must stay inside the Git worktree");
  assertPlainOutputAncestors(base, output);
  const gitPrefix = ["-c", `safe.directory=${root}`, "-C", root];
  const tracked = spawnSync("git", [...gitPrefix, "ls-files", "--error-unmatch", "--", relative], { encoding: "utf8", windowsHide: true });
  if (tracked.status === 0) throw new Error("Knowledge base output is tracked by Git; remove it from the index before rebuilding");
  const ignored = spawnSync("git", [...gitPrefix, "check-ignore", "--quiet", "--no-index", "--", relative], { encoding: "utf8", windowsHide: true });
  if (ignored.status !== 0) throw new Error("Knowledge base output is not ignored by Git; add it to .gitignore before rebuilding");
  return root;
}

function pathExists(target) {
  try { fs.lstatSync(target); return true; }
  catch (error) { if (error?.code === "ENOENT") return false; throw error; }
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
content_kind: ${yaml(c.kind)}
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
- 内容形态：${md(c.kind)}
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
  // Only the snapshot step writes the live knowledge base; a direct run builds into a new directory.
  const output = path.resolve(options.output);
  if (pathExists(output)) {
    throw new Error("Knowledge base output already exists; only a new directory can be written, and the live knowledge base is written only by the snapshot step (只能写到新目录；正式知识库只由快照步骤写入)");
  }
  const catalog = readJson(options.catalog, "catalog");
  const config = readJson(options.config, "config");
  const curated = readJson(options.curation, "curation");
  const sealedCandidates = options.candidates ? readJson(options.candidates, "sealed candidates") : {};
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
  const expectedPromptVersion = String(options["diandian-prompt-version"] || "");
  if (expectedPromptVersion && !/^[a-f0-9]{64}$/.test(expectedPromptVersion)) {
    throw new Error("DianDian prompt version is invalid");
  }
  const buildVersion = String(options["build-version"] || "");
  if (buildVersion && !/^[a-f0-9]{64}$/.test(buildVersion)) throw new Error("--build-version must be a 64-character lowercase SHA-256");
  const effectiveDate = String(options["effective-date"] || new Date().toISOString().slice(0, 10));
  const effectiveDateValue = new Date(`${effectiveDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || Number.isNaN(effectiveDateValue.getTime()) || effectiveDateValue.toISOString().slice(0, 10) !== effectiveDate) throw new Error("--effective-date must be a real YYYY-MM-DD");
  validateContentKindProfile(profile);
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
    const verdict = judgePublicNote({
      noteId: id,
      note,
      curation: curated,
      sealedCandidates,
      quality: {
        policy: curationQuality,
        audit: curationAudit,
        baselineIds: curationBaselineIds,
        baselineRevisions: curationBaselineRevisions
      },
      point: loadFormalPointSummary(diandianDirectory, id, expectedPromptVersion),
      resourceRegistry,
      config,
      profile,
      effectiveDate,
      promptVersion: expectedPromptVersion
    });
    return {
      id,
      note,
      title: verdict.entry.title || inferredTitle(note),
      curation: {
        category: verdict.category,
        categorySource: verdict.categorySource,
        suggestedCategory: verdict.suggestedCategory,
        categoryReason: verdict.categoryReason,
        themes: verdict.themes,
        summary: verdict.summary,
        action: verdict.action,
        tools: verdict.tools,
        kind: verdict.kind
      },
      sourceBoards: verdict.sourceBoards,
      deepSummary: verdict.summarySource === "point" ? verdict.deepSummary : null,
      skillResource: verdict.skillResource,
    };
  }).sort((a, b) => (a.curation.category + a.title).localeCompare(b.curation.category + b.title, "zh-CN"));
  const safeNoteIds = new Map(notes.map((item) => [item.id, safeFileSegment(item.id, "note id")]));
  const safeCategories = new Map(notes.map((item) => [item.curation.category, safeFileSegment(item.curation.category, "category")]));
  requirePrivateOutput(output);
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

  const confirmedSkills = notes.filter((item) => item.skillResource);
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
  process.stdout.write(JSON.stringify({ ok: true, notes: notes.length, categories: categories.size, tools: allTools.size, output }, null, 2) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try { main(); } catch (error) { process.stderr.write(`knowledge-base-builder: ${error.message}\n`); process.exitCode = 1; }
}
