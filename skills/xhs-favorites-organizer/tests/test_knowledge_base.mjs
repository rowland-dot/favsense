import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { curationRevision } from "../scripts/curation-revision.mjs";
import {
  acquireKnowledgeBuildLock,
  copyManualFilesNoLinks,
  knowledgeTransactionJournalPath,
  markKnowledgeTransactionCommitted,
  markKnowledgeTransactionPrepared,
  privateTransactionDirectory,
  publishStagedDirectory,
  recoverKnowledgeTransaction,
  releaseKnowledgeBuildLock,
  requirePrivateOutput,
  writeKnowledgeTransactionJournal,
} from "../scripts/build-knowledge-base.mjs";

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "xhs-kb-test-"));
try {
  const catalogPath = path.join(temporary, "catalog.json");
  const configPath = path.join(temporary, "config.json");
  const curationPath = path.join(temporary, "curation.json");
  const diandianPath = path.join(temporary, "diandian-summaries");
  const output = path.join(temporary, "knowledge-base");
  fs.writeFileSync(catalogPath, JSON.stringify({ version: 1, notes: {
    note_a: { note_id: "note_a", title: "Alpha", author: "A", description: "搜索工具", published_at: "2026-03-01_10:00:00", url: "https://www.xiaohongshu.com/explore/note_a" },
    note_b: { note_id: "note_b", title: "Beta", author: "B", description: "知识图谱", published_at: "2026-01-01_00:00:00", url: "https://www.xiaohongshu.com/explore/note_b" },
    note_old: { note_id: "note_old", title: "Old", author: "C", description: "旧收藏", published_at: "2025-12-31_23:59:59", source_board_ids: ["skills"], url: "https://www.xiaohongshu.com/explore/note_old" },
    note_other_old: { note_id: "note_other_old", title: "Other old", author: "D", description: "其他收藏夹旧内容", published_at: "2025-12-31_23:59:59", source_board_ids: ["other"], url: "https://www.xiaohongshu.com/explore/note_other_old" },
  } }), "utf8");
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, published_since: "2026-01-01", knowledge_base: "knowledge-base", legacy_source_board_id: "skills", boards: [
    { id: "skills", name: "Skills", enabled: true, advertised_count: 2 },
    { id: "other", name: "其他收藏", enabled: true, advertised_count: 1 },
    { id: "cooking", name: "烹饪", enabled: false, reason: "用户明确排除", advertised_count: 1 },
  ] }), "utf8");
  fs.writeFileSync(curationPath, JSON.stringify({
    note_a: { category: "信息采集与搜索", category_override: true, category_reason: "测试显式覆盖", themes: ["搜索"], summary: "搜索摘要", action: "验证搜索", tools: ["SearchTool"] },
    note_b: { category: "知识管理与记忆", category_override: true, category_reason: "测试显式覆盖", themes: ["知识图谱"], summary: "知识摘要", action: "验证知识", tools: [] },
  }), "utf8");
  fs.mkdirSync(diandianPath);
  fs.writeFileSync(path.join(diandianPath, "note_b.json"), JSON.stringify({
    version: 1,
    provider: "xiaohongshu-diandian",
    prompt: "总结",
    note_id: "note_b",
    title: "Beta",
    summary: "点点 AI 已完整读取这篇笔记，并生成这段深度总结。",
  }), "utf8");
  const run = () => spawnSync("node", [
    path.join(skill, "scripts", "build-knowledge-base.mjs"),
    "--catalog", catalogPath,
    "--config", configPath,
    "--curation", curationPath,
    "--diandian-dir", diandianPath,
    "--output", output,
  ], { encoding: "utf8", windowsHide: true });
  let result;

  const qualityConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const baselinePath = path.join(temporary, "curation-baseline.json");
  const auditPath = path.join(temporary, "curation-audit.json");
  qualityConfig.curation_quality = {
    publish_only_accepted: true,
    audit_file: auditPath,
    baseline_file: baselinePath,
  };
  fs.writeFileSync(configPath, JSON.stringify(qualityConfig), "utf8");
  const currentCuration = JSON.parse(fs.readFileSync(curationPath, "utf8"));
  fs.writeFileSync(baselinePath, JSON.stringify({
    version: 1,
    note_ids: ["note_a", "note_b"],
    curation_hashes: {
      note_a: curationRevision(currentCuration.note_a),
      note_b: curationRevision(currentCuration.note_b),
    },
  }), "utf8");
  fs.writeFileSync(auditPath, JSON.stringify({ version: 1, notes: {} }), "utf8");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  const baselineNoteA = fs.readFileSync(path.join(output, fs.readdirSync(output).find((name) => name.startsWith("02-")), "note_a.md"), "utf8");
  assert.match(baselineNoteA, /SearchTool/);

  fs.writeFileSync(path.join(diandianPath, "note_a.json"), JSON.stringify({
    version: 1,
    provider: "xiaohongshu-diandian",
    prompt: "总结",
    note_id: "note_b",
    title: "Alpha",
    summary: "这份摘要的稳定笔记 ID 不匹配，不应进入 Alpha 卡片。",
    xsec_token: "credential-shaped-value",
  }), "utf8");

  result = run();
  assert.equal(result.status, 0, result.stderr);
  const home = fs.readFileSync(path.join(output, "00-首页.md"), "utf8");
  assert.match(home, /已整理：\*\*4\*\*/);
  assert.match(home, /深度处理范围：\*\*2026-01-01 起发布\*\*/);
  assert.match(home, /已排除：烹饪/);
  assert.match(home, /domain_profile: "software"/);
  assert.equal(fs.readdirSync(path.join(output, "02-知识卡片")).length, 4);
  assert.equal(fs.existsSync(path.join(output, "02-知识卡片", "note_old.md")), true);
  assert.equal(fs.existsSync(path.join(output, "02-知识卡片", "note_other_old.md")), true);
  const noteB = fs.readFileSync(path.join(output, "02-知识卡片", "note_b.md"), "utf8");
  assert.doesNotMatch(noteB, /^(?:priority|status):/m);
  assert.doesNotMatch(noteB, /- \[ \]/);
  assert.match(noteB, /https:\/\/www\.xiaohongshu\.com\/search_result\?keyword=Beta\+B&source=web_search_result_notes/);
  assert.doesNotMatch(noteB, /\/explore\/|\/discovery\/item\//);
  assert.doesNotMatch(noteB, /## 点点 AI 深度总结|点点 AI 已完整读取这篇笔记/);
  const noteA = fs.readFileSync(path.join(output, "02-知识卡片", "note_a.md"), "utf8");
  assert.doesNotMatch(noteA, /## 点点 AI 深度总结|稳定笔记 ID 不匹配|credential-shaped-value/);
  assert.equal(fs.existsSync(path.join(output, "04-行动与实验", "行动清单.md")), false);
  assert.equal(fs.existsSync(path.join(output, "04-行动与实验", "使用建议.md")), true);
  const manualFile = path.join(output, "我的人工笔记.md");
  fs.writeFileSync(manualFile, "manual content", "utf8");
  for (const file of fs.readdirSync(path.join(output, "02-知识卡片"))) {
    assert.doesNotMatch(fs.readFileSync(path.join(output, "02-知识卡片", file), "utf8"), /xsec_token/i);
  }

  fs.writeFileSync(path.join(diandianPath, "note_a.json"), JSON.stringify({
    version: 1,
    provider: "xiaohongshu-diandian",
    prompt: "总结",
    note_id: "note_a",
    title: "Alpha",
    summary: "Encoded %78%73%65%63%5f%74%6f%6b%65%6e%3dsecret must stay out of Markdown.",
  }), "utf8");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(manualFile, "utf8"), "manual content");
  assert.equal(
    fs.readdirSync(temporary).some((name) => name.startsWith(".knowledge-base.favsense-")),
    false,
  );
  assert.equal(fs.existsSync(path.join(temporary, ".favsense-private-transactions")), false);
  const generatedCardsDir = fs.readdirSync(output).find((name) => name.startsWith("02-"));
  assert.ok(generatedCardsDir);
  const encodedNoteA = fs.readFileSync(path.join(output, generatedCardsDir, "note_a.md"), "utf8");
  assert.doesNotMatch(encodedNoteA, /Encoded|xsec_token/);

  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  delete catalog.notes.note_b;
  fs.writeFileSync(catalogPath, JSON.stringify(catalog), "utf8");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    fs.readdirSync(path.join(output, "02-知识卡片")).sort(),
    ["note_a.md", "note_old.md", "note_other_old.md"]
  );
  assert.equal(fs.existsSync(path.join(output, "01-主题地图", "知识管理与记忆.md")), false);

  const transactionLive = path.join(temporary, "transaction-live");
  const transactionStage = path.join(temporary, "transaction-stage");
  fs.mkdirSync(transactionLive);
  fs.mkdirSync(transactionStage);
  fs.writeFileSync(path.join(transactionLive, "generation.txt"), "old", "utf8");
  fs.writeFileSync(path.join(transactionStage, "generation.txt"), "new", "utf8");
  const failingFileSystem = {
    existsSync: fs.existsSync,
    rmSync: fs.rmSync,
    renameSync(source, destination) {
      if (source === transactionStage && destination === transactionLive) {
        throw new Error("injected publish failure");
      }
      fs.renameSync(source, destination);
    },
  };
  assert.throws(
    () => publishStagedDirectory(transactionLive, transactionStage, failingFileSystem),
    /injected publish failure/,
  );
  assert.equal(fs.readFileSync(path.join(transactionLive, "generation.txt"), "utf8"), "old");
  assert.equal(fs.existsSync(transactionStage), false);
  assert.equal(
    fs.readdirSync(temporary).some((name) => name.startsWith(".favsense-backup-transaction-live-")),
    false,
  );

  const concurrentLive = path.join(temporary, "concurrent-live");
  const concurrentStage = path.join(temporary, "concurrent-stage");
  fs.mkdirSync(concurrentLive);
  fs.mkdirSync(concurrentStage);
  fs.writeFileSync(path.join(concurrentLive, "我的人工笔记.md"), "v1", "utf8");
  fs.writeFileSync(path.join(concurrentLive, "00-首页.md"), "old generation", "utf8");
  fs.writeFileSync(path.join(concurrentStage, "00-首页.md"), "new generation", "utf8");
  fs.writeFileSync(path.join(concurrentLive, "我的人工笔记.md"), "v2", "utf8");
  publishStagedDirectory(
    concurrentLive,
    concurrentStage,
    fs,
    (movedLive, stagedOutput) => copyManualFilesNoLinks(movedLive, stagedOutput),
  );
  assert.equal(fs.readFileSync(path.join(concurrentLive, "我的人工笔记.md"), "utf8"), "v2");
  assert.equal(fs.readFileSync(path.join(concurrentLive, "00-首页.md"), "utf8"), "new generation");
  assert.equal(fs.existsSync(concurrentStage), false);

  const lateEditLive = path.join(temporary, "late-edit-live");
  const lateEditStage = path.join(temporary, "late-edit-stage");
  fs.mkdirSync(lateEditLive);
  fs.mkdirSync(lateEditStage);
  fs.writeFileSync(path.join(lateEditLive, "我的人工笔记.md"), "v1", "utf8");
  fs.writeFileSync(path.join(lateEditStage, "00-首页.md"), "new generation", "utf8");
  const lateEditFileSystem = Object.create(fs);
  lateEditFileSystem.linkSync = (source, destination) => {
    fs.linkSync(source, destination);
    if (path.basename(source) === "我的人工笔记.md") fs.writeFileSync(source, "v2", "utf8");
  };
  publishStagedDirectory(
    lateEditLive,
    lateEditStage,
    lateEditFileSystem,
    (movedLive, stagedOutput) => copyManualFilesNoLinks(movedLive, stagedOutput, lateEditFileSystem),
  );
  assert.equal(fs.readFileSync(path.join(lateEditLive, "我的人工笔记.md"), "utf8"), "v2");

  const collisionLive = path.join(temporary, "collision-live");
  const collisionStage = path.join(temporary, "collision-stage");
  fs.mkdirSync(path.join(collisionLive, "02-知识卡片"), { recursive: true });
  fs.mkdirSync(path.join(collisionStage, "02-知识卡片"), { recursive: true });
  fs.writeFileSync(path.join(collisionLive, "02-知识卡片", "note.md"), "manual draft", "utf8");
  fs.writeFileSync(path.join(collisionStage, "02-知识卡片", "note.md"), "---\ntype: xhs-knowledge-card\n---\n", "utf8");
  assert.throws(
    () => publishStagedDirectory(
      collisionLive,
      collisionStage,
      fs,
      (movedLive, stagedOutput) => copyManualFilesNoLinks(movedLive, stagedOutput),
    ),
    /conflicts with generated output/,
  );
  assert.equal(fs.readFileSync(path.join(collisionLive, "02-知识卡片", "note.md"), "utf8"), "manual draft");

  const cleanupLive = path.join(temporary, "cleanup-live");
  const cleanupStage = path.join(temporary, "cleanup-stage");
  fs.mkdirSync(cleanupLive);
  fs.mkdirSync(cleanupStage);
  fs.writeFileSync(path.join(cleanupLive, "generation.txt"), "old", "utf8");
  fs.writeFileSync(path.join(cleanupStage, "generation.txt"), "new", "utf8");
  const cleanupFailureFileSystem = {
    existsSync: fs.existsSync,
    renameSync: fs.renameSync,
    rmSync(target, options) {
      if (String(target).includes(".favsense-backup-cleanup-live-")) throw new Error("locked backup");
      fs.rmSync(target, options);
    },
  };
  const cleanupResult = publishStagedDirectory(cleanupLive, cleanupStage, cleanupFailureFileSystem);
  assert.match(cleanupResult.cleanupWarning, /could not be removed/);
  assert.equal(fs.readFileSync(path.join(cleanupLive, "generation.txt"), "utf8"), "new");
  assert.equal(fs.existsSync(cleanupResult.retainedBackup), true);
  assert.equal(path.dirname(cleanupResult.retainedBackup), path.dirname(cleanupStage));

  const privacyRepo = path.join(temporary, "privacy-repo");
  fs.mkdirSync(privacyRepo);
  fs.writeFileSync(path.join(privacyRepo, ".gitignore"), ".xhs-tools/\nknowledge-base/\n.private/\n", "utf8");
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: privacyRepo }).status, 0);
  const privateTransactions = privateTransactionDirectory(
    privacyRepo,
    path.join(privacyRepo, "knowledge-base"),
  );
  assert.equal(privateTransactions, path.join(privacyRepo, ".xhs-tools", "knowledge-base-transactions"));
  assert.equal(
    spawnSync("git", ["check-ignore", "--quiet", "--no-index", path.join(privateTransactions, "probe")], { cwd: privacyRepo }).status,
    0,
  );
  const redirectedTarget = path.join(privacyRepo, "public-target");
  const redirectedPrivate = path.join(privacyRepo, ".private");
  fs.mkdirSync(redirectedTarget);
  fs.symlinkSync(redirectedTarget, redirectedPrivate, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => requirePrivateOutput(path.join(redirectedPrivate, "leak")),
    /redirected|invalid ancestor/i,
  );
  assert.equal(fs.existsSync(path.join(redirectedTarget, "leak")), false);

  const crashRoot = path.join(temporary, "crash-transactions");
  fs.mkdirSync(crashRoot, { recursive: true });
  const crashLive = path.join(temporary, "crash-live");
  const crashStage = path.join(crashRoot, "stage-crash-live-fixture");
  const crashBackup = path.join(crashRoot, ".favsense-backup-crash-live-fixture");
  fs.mkdirSync(crashStage, { recursive: true });
  fs.mkdirSync(crashBackup, { recursive: true });
  fs.writeFileSync(path.join(crashStage, "00-首页.md"), "new generation", "utf8");
  fs.writeFileSync(path.join(crashBackup, "我的人工笔记.md"), "survives crash", "utf8");
  const crashJournal = knowledgeTransactionJournalPath(crashRoot, crashLive);

  const firstBuildLock = acquireKnowledgeBuildLock(crashRoot, crashLive, fs, { isProcessAlive: () => true });
  assert.throws(
    () => acquireKnowledgeBuildLock(crashRoot, crashLive, fs, { isProcessAlive: () => true }),
    /already running/i,
  );
  releaseKnowledgeBuildLock(firstBuildLock);

  let competingBuildLock;
  let injectedCompetition = false;
  const atomicClaimFileSystem = Object.create(fs);
  atomicClaimFileSystem.renameSync = (source, destination) => {
    if (!injectedCompetition && String(source).includes(".lock.claim-") && destination.endsWith(".lock")) {
      injectedCompetition = true;
      competingBuildLock = acquireKnowledgeBuildLock(
        crashRoot, crashLive, fs, { isProcessAlive: () => true },
      );
    }
    return fs.renameSync(source, destination);
  };
  assert.throws(
    () => acquireKnowledgeBuildLock(
      crashRoot, crashLive, atomicClaimFileSystem, { isProcessAlive: () => true },
    ),
    /already running/i,
  );
  assert.ok(competingBuildLock);
  releaseKnowledgeBuildLock(competingBuildLock);

  if (process.platform === "win32") {
    const caseAlias = crashLive.replace(/^([a-z]):/i, (_match, drive) => `${drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()}:`);
    const caseLock = acquireKnowledgeBuildLock(crashRoot, crashLive, fs, { isProcessAlive: () => true });
    assert.throws(
      () => acquireKnowledgeBuildLock(crashRoot, caseAlias, fs, { isProcessAlive: () => true }),
      /already running/i,
    );
    assert.equal(
      knowledgeTransactionJournalPath(crashRoot, crashLive),
      knowledgeTransactionJournalPath(crashRoot, caseAlias),
    );
    releaseKnowledgeBuildLock(caseLock);

    const caseRecoveryLive = path.join(temporary, "case-recovery-live");
    const caseRecoveryAlias = caseRecoveryLive.replace(/^([a-z]):/i, (_match, drive) => `${drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()}:`);
    const caseRecoveryStage = path.join(crashRoot, "stage-case-recovery");
    const caseRecoveryBackup = path.join(crashRoot, ".favsense-backup-case-recovery");
    fs.mkdirSync(caseRecoveryStage);
    fs.mkdirSync(caseRecoveryBackup);
    fs.writeFileSync(path.join(caseRecoveryBackup, "manual.md"), "case-safe", "utf8");
    const caseRecoveryJournal = knowledgeTransactionJournalPath(crashRoot, caseRecoveryLive);
    const caseRecoveryRecord = writeKnowledgeTransactionJournal({
      journalPath: caseRecoveryJournal,
      transactionRoot: crashRoot,
      liveOutput: caseRecoveryLive,
      stagingOutput: caseRecoveryStage,
      backupOutput: caseRecoveryBackup,
    });
    markKnowledgeTransactionPrepared(caseRecoveryJournal, caseRecoveryRecord);
    assert.equal(
      recoverKnowledgeTransaction(
        caseRecoveryAlias,
        crashRoot.toUpperCase(),
        caseRecoveryJournal,
        fs,
        { isProcessAlive: () => false },
      ),
      "restored",
    );
    assert.equal(fs.readFileSync(path.join(caseRecoveryLive, "manual.md"), "utf8"), "case-safe");
  }

  const staleBuildLockPath = firstBuildLock.lockPath;
  fs.mkdirSync(staleBuildLockPath);
  fs.writeFileSync(path.join(staleBuildLockPath, "owner.json"), JSON.stringify({
    version: 1, owner_pid: 999999999, owner_id: "stale",
  }), "utf8");
  const reclaimedBuildLock = acquireKnowledgeBuildLock(crashRoot, crashLive, fs, { isProcessAlive: () => false });
  assert.equal(fs.readdirSync(crashRoot).some((name) => name.endsWith(".stale-stale")), true);
  releaseKnowledgeBuildLock(reclaimedBuildLock);
  const crashRecord = writeKnowledgeTransactionJournal({
    journalPath: crashJournal,
    transactionRoot: crashRoot,
    liveOutput: crashLive,
    stagingOutput: crashStage,
    backupOutput: crashBackup,
  });
  markKnowledgeTransactionPrepared(crashJournal, crashRecord);
  assert.equal(
    recoverKnowledgeTransaction(crashLive, crashRoot, crashJournal, fs, { isProcessAlive: () => false }),
    "restored",
  );
  assert.equal(fs.readFileSync(path.join(crashLive, "我的人工笔记.md"), "utf8"), "survives crash");
  assert.equal(fs.existsSync(crashStage), false);
  assert.equal(fs.existsSync(crashJournal), false);

  const committedStage = path.join(crashRoot, "stage-committed-fixture");
  const committedBackup = path.join(crashRoot, ".favsense-backup-committed-fixture");
  fs.mkdirSync(committedBackup, { recursive: true });
  fs.writeFileSync(path.join(committedBackup, "old.md"), "old", "utf8");
  const committedJournal = knowledgeTransactionJournalPath(crashRoot, crashLive);
  let committedRecord = writeKnowledgeTransactionJournal({
    journalPath: committedJournal,
    transactionRoot: crashRoot,
    liveOutput: crashLive,
    stagingOutput: committedStage,
    backupOutput: committedBackup,
  });
  committedRecord = markKnowledgeTransactionPrepared(committedJournal, committedRecord);
  markKnowledgeTransactionCommitted(committedJournal, committedRecord);
  assert.equal(
    recoverKnowledgeTransaction(crashLive, crashRoot, committedJournal, fs, { isProcessAlive: () => false }),
    "committed",
  );
  assert.equal(fs.existsSync(committedBackup), false);
  assert.equal(fs.existsSync(committedJournal), false);

  const conflictLive = path.join(temporary, "conflict-live");
  const conflictStage = path.join(crashRoot, "stage-conflict-fixture");
  const conflictBackup = path.join(crashRoot, ".favsense-backup-conflict-fixture");
  fs.mkdirSync(conflictLive, { recursive: true });
  fs.mkdirSync(conflictStage, { recursive: true });
  fs.writeFileSync(path.join(conflictLive, "manual.md"), "original manual", "utf8");
  fs.writeFileSync(path.join(conflictStage, "00-首页.md"), "new generation", "utf8");
  const conflictJournal = knowledgeTransactionJournalPath(crashRoot, conflictLive);
  const conflictRecord = writeKnowledgeTransactionJournal({
    journalPath: conflictJournal,
    transactionRoot: crashRoot,
    liveOutput: conflictLive,
    stagingOutput: conflictStage,
    backupOutput: conflictBackup,
  });
  markKnowledgeTransactionPrepared(conflictJournal, conflictRecord);
  assert.throws(
    () => publishStagedDirectory(
      conflictLive,
      conflictStage,
      fs,
      (movedLive) => {
        fs.mkdirSync(conflictLive, { recursive: true });
        fs.writeFileSync(path.join(conflictLive, "replacement.md"), "external replacement", "utf8");
        copyManualFilesNoLinks(movedLive, conflictStage);
      },
      conflictBackup,
    ),
  );
  assert.throws(
    () => recoverKnowledgeTransaction(conflictLive, crashRoot, conflictJournal, fs, {
      expectedTransactionId: conflictRecord.transaction_id,
    }),
    /uncommitted.*conflicts/i,
  );
  assert.equal(fs.readFileSync(path.join(conflictBackup, "manual.md"), "utf8"), "original manual");
  assert.equal(fs.readFileSync(path.join(conflictLive, "replacement.md"), "utf8"), "external replacement");

  const partialLive = path.join(temporary, "partial-live");
  const partialStage = path.join(crashRoot, "stage-partial-fixture");
  const partialBackup = path.join(crashRoot, ".favsense-backup-partial-fixture");
  fs.mkdirSync(partialLive, { recursive: true });
  fs.mkdirSync(partialStage, { recursive: true });
  fs.writeFileSync(path.join(partialLive, "manual.md"), "live manual", "utf8");
  fs.writeFileSync(path.join(partialStage, "partial.md"), "partial generation", "utf8");
  const partialJournal = knowledgeTransactionJournalPath(crashRoot, partialLive);
  writeKnowledgeTransactionJournal({
    journalPath: partialJournal,
    transactionRoot: crashRoot,
    liveOutput: partialLive,
    stagingOutput: partialStage,
    backupOutput: partialBackup,
  });
  assert.equal(
    recoverKnowledgeTransaction(partialLive, crashRoot, partialJournal, fs, { isProcessAlive: () => false }),
    "discarded",
  );
  assert.equal(fs.readFileSync(path.join(partialLive, "manual.md"), "utf8"), "live manual");
  assert.equal(fs.existsSync(partialStage), false);
  assert.equal(fs.existsSync(partialJournal), false);

  const failedClaimLive = path.join(temporary, "failed-claim-live");
  const failedClaimStage = path.join(crashRoot, "stage-failed-claim");
  const failedClaimBackup = path.join(crashRoot, ".favsense-backup-failed-claim");
  const failedClaimJournal = knowledgeTransactionJournalPath(crashRoot, failedClaimLive);
  const writeFailureFileSystem = Object.create(fs);
  writeFailureFileSystem.writeFileSync = () => { throw new Error("injected journal write failure"); };
  assert.throws(
    () => writeKnowledgeTransactionJournal({
      journalPath: failedClaimJournal,
      transactionRoot: crashRoot,
      liveOutput: failedClaimLive,
      stagingOutput: failedClaimStage,
      backupOutput: failedClaimBackup,
    }, writeFailureFileSystem),
    /injected journal write failure/,
  );
  assert.equal(fs.existsSync(failedClaimJournal), false);
  assert.equal(
    fs.readdirSync(crashRoot).some((name) => name.startsWith(`${path.basename(failedClaimJournal)}.claim-`)),
    false,
  );

  const orphanClaimLive = path.join(temporary, "orphan-claim-live");
  const orphanClaimStage = path.join(crashRoot, "stage-orphan-claim");
  const orphanClaimBackup = path.join(crashRoot, ".favsense-backup-orphan-claim");
  const orphanClaimJournal = knowledgeTransactionJournalPath(crashRoot, orphanClaimLive);
  const orphanClaim = `${orphanClaimJournal}.claim-999999-00000000-0000-4000-8000-000000000000.tmp`;
  fs.writeFileSync(orphanClaim, "{\"partial\":", "utf8");
  writeKnowledgeTransactionJournal({
    journalPath: orphanClaimJournal,
    transactionRoot: crashRoot,
    liveOutput: orphanClaimLive,
    stagingOutput: orphanClaimStage,
    backupOutput: orphanClaimBackup,
  });
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(orphanClaimJournal, "utf8")));
  assert.equal(fs.existsSync(orphanClaim), false);
  assert.equal(
    recoverKnowledgeTransaction(orphanClaimLive, crashRoot, orphanClaimJournal, fs, { isProcessAlive: () => false }),
    "discarded",
  );

  const activeLive = path.join(temporary, "active-live");
  const activeStage = path.join(crashRoot, "stage-active-fixture");
  const activeBackup = path.join(crashRoot, ".favsense-backup-active-fixture");
  fs.mkdirSync(activeLive, { recursive: true });
  fs.mkdirSync(activeStage, { recursive: true });
  const activeJournal = knowledgeTransactionJournalPath(crashRoot, activeLive);
  writeKnowledgeTransactionJournal({
    journalPath: activeJournal,
    transactionRoot: crashRoot,
    liveOutput: activeLive,
    stagingOutput: activeStage,
    backupOutput: activeBackup,
  });
  assert.throws(
    () => recoverKnowledgeTransaction(activeLive, crashRoot, activeJournal, fs, { isProcessAlive: () => true }),
    /already running/i,
  );
  assert.equal(fs.existsSync(activeStage), true);
  assert.equal(fs.existsSync(activeJournal), true);
  assert.equal(
    recoverKnowledgeTransaction(activeLive, crashRoot, activeJournal, fs, { isProcessAlive: () => false }),
    "discarded",
  );

  const replacedLive = path.join(temporary, "replaced-live");
  const replacedStageA = path.join(crashRoot, "stage-replaced-a");
  const replacedStageB = path.join(crashRoot, "stage-replaced-b");
  const replacedBackupA = path.join(crashRoot, ".favsense-backup-replaced-a");
  const replacedBackupB = path.join(crashRoot, ".favsense-backup-replaced-b");
  fs.mkdirSync(replacedLive, { recursive: true });
  fs.mkdirSync(replacedStageA, { recursive: true });
  fs.mkdirSync(replacedStageB, { recursive: true });
  const replacedJournal = knowledgeTransactionJournalPath(crashRoot, replacedLive);
  const replacedRecordA = writeKnowledgeTransactionJournal({
    journalPath: replacedJournal,
    transactionRoot: crashRoot,
    liveOutput: replacedLive,
    stagingOutput: replacedStageA,
    backupOutput: replacedBackupA,
  });
  fs.rmSync(replacedJournal, { force: true });
  writeKnowledgeTransactionJournal({
    journalPath: replacedJournal,
    transactionRoot: crashRoot,
    liveOutput: replacedLive,
    stagingOutput: replacedStageB,
    backupOutput: replacedBackupB,
  });
  assert.throws(
    () => recoverKnowledgeTransaction(replacedLive, crashRoot, replacedJournal, fs, {
      expectedTransactionId: replacedRecordA.transaction_id,
    }),
    /replaced by another build/i,
  );
  assert.equal(fs.existsSync(replacedStageB), true);
  assert.equal(fs.existsSync(replacedJournal), true);
  assert.equal(
    recoverKnowledgeTransaction(replacedLive, crashRoot, replacedJournal, fs, { isProcessAlive: () => false }),
    "discarded",
  );

  const malicious = JSON.parse(fs.readFileSync(curationPath, "utf8"));
  malicious.note_a.category = "../../README";
  fs.writeFileSync(curationPath, JSON.stringify(malicious), "utf8");
  const maliciousBaseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  maliciousBaseline.curation_hashes.note_a = curationRevision(malicious.note_a);
  fs.writeFileSync(baselinePath, JSON.stringify(maliciousBaseline), "utf8");
  const previousHome = fs.readFileSync(path.join(output, "00-首页.md"), "utf8");
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not safe for a generated filename/);
  assert.equal(fs.existsSync(path.join(temporary, "README.md")), false);
  assert.equal(fs.readFileSync(path.join(output, "00-首页.md"), "utf8"), previousHome);
  assert.equal(fs.readFileSync(manualFile, "utf8"), "manual content");
  process.stdout.write("knowledge base tests passed\n");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
