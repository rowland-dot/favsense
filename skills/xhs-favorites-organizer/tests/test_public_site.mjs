import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash, webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import { resourceGroup, resourceSortsForGroup, sortResources, validateResourceIndex } from "../../../site/resource-utils.mjs";
import { hasHuggingFaceMiniHeader, resolveHuggingFaceHeaderLayout } from "../../../site/huggingface-layout.mjs";
import { diandianBlocks, stripDiandianOpener } from "../../../site/diandian-text.mjs";
import { assertPrivateDataset, repositoryIsMissing, repositoryWriteConflict } from "../../../site/hf-sync-guard.mjs";
import { collectVideoEvidenceStats } from "../scripts/evidence-stats.mjs";
import { resolveCategoryPolicy, sourceBoardNames } from "../scripts/category-policy.mjs";
import { containsCredentialShape } from "../scripts/sensitive-data.mjs";
import { assertPublicTextSafe, validatePublicTree } from "../scripts/public-tree-policy.mjs";
import {
  normalizeLocalBridgeDiagnostic,
  validateLocalBridgeBoards,
  validateLocalBridgeConfig,
  validateLocalNoteOrganizationStatus,
  validateLocalBridgeSession,
  validateLocalBridgeSyncStatus
} from "../../../site/local-bridge-utils.mjs";
import {
  loadPersonalData,
  mergePersonalData,
  normalizePersonalData,
  relatedResourceNames,
  serializePersonalData,
  validatePersonalDataPayload
} from "../../../site/personal-store.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const TEST_DIANDIAN_CONTRACT = {
  enabled: true,
  ...JSON.parse(await read("skills/xhs-diandian-summarize-note/runtime/browser-contract.json"))
};
const ORGANIZATION_STATUS_CONTRACT = JSON.parse(await read("site/organization-status-contract.json"));

function sourceSlice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function renderUserscriptTemplate(template, contract = TEST_DIANDIAN_CONTRACT) {
  return template
    .replaceAll(
      "__DIANDIAN_MATCH_LINE__",
      contract.cdp_enabled === true ? "" : `// @match        ${contract.ai_chat_url}*`
    )
    .replaceAll("__PORT__", "47631")
    .replaceAll("__TOKEN__", "a".repeat(64))
    .replaceAll("__INSTALL_CAPABILITY__", "b".repeat(64))
    .replaceAll("__BOARDS__", "{}")
    .replaceAll("__DIANDIAN_CONTRACT__", JSON.stringify(contract));
}

test("knowledge cards default to recently published first", async () => {
  const [app, html] = await Promise.all([read("site/app.js"), read("site/index.html")]);
  const stateSource = app.slice(app.indexOf("const state = {"), app.indexOf("function bookmarkIcon"));
  assert.match(stateSource, /sort:\s*"newest"/);

  const sortOptions = html.match(/<select id="sort-select"[^>]*>([\s\S]*?)<\/select>/)?.[1]?.trim() || "";
  assert.match(sortOptions, /^<option value="newest">最近发布<\/option>/);

  const filteredStart = app.indexOf("function filteredNotes()");
  const filteredEnd = app.indexOf("\nfunction renderCategories", filteredStart);
  const filteredSource = app.slice(filteredStart, filteredEnd);
  assert.ok(filteredSource);
  const context = {
    state: {
      query: "",
      category: "all",
      kind: "all",
      bookmarksOnly: false,
      bookmarks: new Set(),
      sort: "newest",
      data: {
        notes: [
          { id: "older", title: "Older", author: "", category: "A", suggestedCategory: "", summary: "", action: "", themes: [], tools: [], kind: "Tool", publishedAt: "2026-01-01", number: 1 },
          { id: "newer", title: "Newer", author: "", category: "A", suggestedCategory: "", summary: "", action: "", themes: [], tools: [], kind: "Tool", publishedAt: "2026-08-01", number: 2 }
        ]
      }
    },
    noteDescription: (note) => note.summary,
    parseMetric: () => 0,
    result: null
  };
  runInNewContext(`${filteredSource}\nresult = filteredNotes().map((note) => note.id);`, context);
  assert.deepEqual([...context.result], ["newer", "older"]);
});

test("personal state is exposed only after browser storage accepts the write", async () => {
  const app = await read("site/app.js");
  const personalFunctions = sourceSlice(app, "function validNoteIds()", "function noteDescription");
  const bookmarkFunction = sourceSlice(app, "function toggleBookmark(noteId)", "function exportPersonalData()");
  const messages = [];
  const context = {
    PERSONAL_DATA_VERSION: 2,
    state: {
      data: { notes: [{ id: "note-a" }] },
      knowledgeReady: true,
      personalStoreReady: true,
      bookmarks: new Set(),
      bookmarkStates: {},
      descriptionOverrides: {},
      cloud: { ready: false, authenticated: false }
    },
    elements: { dialogContent: { dataset: {} }, dialog: { open: false } },
    localStorage: {},
    savePersonalData() { throw new Error("quota exceeded"); },
    renderPersonalControls() {},
    queueCloudSave() {},
    renderNotes() {},
    renderResources() {},
    renderDetail() {},
    showToast(message) { messages.push(message); },
    result: null
  };
  const failingContext = { ...context, messages, result: null };
  runInNewContext(`${personalFunctions}\n${bookmarkFunction}\ntoggleBookmark("note-a");\nresult = { bookmarked: state.bookmarks.has("note-a"), messages: [...messages] };`, failingContext);
  assert.equal(failingContext.result.bookmarked, false);
  assert.equal(failingContext.result.messages.some((message) => /已添加书签/.test(message)), false);
  assert.equal(failingContext.result.messages.some((message) => /无法保存个人数据/.test(message)), true);

  failingContext.savePersonalData = (_storage, candidate) => candidate;
  failingContext.messages.length = 0;
  runInNewContext(`toggleBookmark("note-a");\nresult = { bookmarked: state.bookmarks.has("note-a"), messages: [...messages] };`, failingContext);
  assert.equal(failingContext.result.bookmarked, true);
  assert.equal(failingContext.result.messages.some((message) => /已添加书签/.test(message)), true);

  let saveCalls = 0;
  failingContext.state.knowledgeReady = false;
  failingContext.savePersonalData = (_storage, candidate) => { saveCalls += 1; return candidate; };
  failingContext.messages.length = 0;
  runInNewContext(`toggleBookmark("note-a");\nresult = { bookmarked: state.bookmarks.has("note-a"), messages: [...messages] };`, failingContext);
  assert.equal(failingContext.result.bookmarked, true);
  assert.equal(saveCalls, 0);
  assert.equal(failingContext.result.messages.some((message) => /尚未就绪|尚未加载/.test(message)), true);
});

test("a card shows its own main text; a saved reply loses only its opening line; a personal revision wins", async () => {
  const app = await read("site/app.js");
  const source = sourceSlice(
    app,
    "function noteDescription(note)",
    "\nfunction renderPersonalControls"
  );
  const context = {
    stripDiandianOpener,
    state: {
      descriptionOverrides: {
        personal: { description: "Personal approved wording", deleted: false },
        deleted: { description: "Deleted personal wording", deleted: true }
      }
    },
    result: null
  };

  runInNewContext(`${source}
    result = {
      postText: noteDescription({ id: "post", mainSource: "post-text", mainText: "The post's own words" }),
      transcript: noteDescription({ id: "transcript", mainSource: "video-transcript", mainText: "Spoken words" }),
      reply: noteDescription({ id: "reply", mainSource: "diandian", mainText: "根据你引用的笔记，这是一篇分享。以下是核心总结：\\n\\n核心故事\\n\\n正文" }),
      personal: noteDescription({ id: "personal", mainSource: "diandian", mainText: "Saved reply" }),
      deletedPersonal: noteDescription({ id: "deleted", mainSource: "post-text", mainText: "Post text after personal deletion" }),
      repliesShown: [
        showsDianDianReply({ mainSource: "diandian", mainText: "x" }),
        showsDianDianReply({ mainSource: "diandian", mainText: "  " }),
        showsDianDianReply({ mainSource: "post-text", mainText: "x" })
      ]
    };
  `, context);

  assert.deepEqual({ ...context.result, repliesShown: [...context.result.repliesShown] }, {
    postText: "The post's own words",
    transcript: "Spoken words",
    reply: "核心故事\n\n正文",
    personal: "Personal approved wording",
    deletedPersonal: "Post text after personal deletion",
    repliesShown: [true, false, false]
  });
});

test("personal backup controls fail closed until knowledge IDs are available", async () => {
  const app = await read("site/app.js");
  const personalFunctions = sourceSlice(app, "function validNoteIds()", "function noteDescription");
  const transferFunctions = sourceSlice(app, "function exportPersonalData()", "function bindEvents()");
  const messages = [];
  let fileReads = 0;
  let saveCalls = 0;
  const context = {
    state: {
      data: { notes: [] },
      knowledgeReady: false,
      bookmarks: new Set(["note-a"]),
      bookmarkStates: { "note-a": { bookmarked: true } },
      descriptionOverrides: {}
    },
    localStorage: {},
    savePersonalData() { saveCalls += 1; },
    showToast(message) { messages.push(message); },
    testFile: { size: 2, async text() { fileReads += 1; return "{}"; } },
    resultPromise: null
  };
  runInNewContext(`${personalFunctions}\n${transferFunctions}\nexportPersonalData();\nresultPromise = importPersonalData(testFile);`, context);
  await assert.rejects(context.resultPromise, /尚未就绪|尚未加载/);
  assert.equal(fileReads, 0);
  assert.equal(saveCalls, 0);
  assert.equal(messages.some((message) => /无法安全导出/.test(message)), true);
});

test("knowledge payload failures keep a recoverable shell with accurate guidance", async () => {
  const app = await read("site/app.js");
  const recoveryFunctions = sourceSlice(app, "function emptyKnowledgeData()", "const elements = {");
  const context = { validateResourceIndex, result: null };
  runInNewContext(`${recoveryFunctions}
    let malformedRejected = false;
    try { validateKnowledgeData({ meta: {}, notes: {} }); } catch { malformedRejected = true; }
    let unsafeResourceRejected = false;
    const unsafeResource = emptyKnowledgeData();
    unsafeResource.resources = [{ name: "broken", type: "site", description: "broken", aliases: [], actions: [null], attributes: [null] }];
    try { validateKnowledgeData(unsafeResource); } catch { unsafeResourceRejected = true; }
    const card = (id, changes = {}) => ({
      id, title: id, category: "A", kind: "Note", publishedAt: "2026-01-01", themes: [], tools: [], unverifiedTools: [], resources: [],
      mainText: "text", mainSource: "post-text", replyDamaged: false, postUnreachable: false, extracted: null, ...changes
    });
    const refuses = (note) => {
      const data = emptyKnowledgeData();
      data.notes = [note];
      try { validateKnowledgeData(data); return false; } catch { return true; }
    };
    const withoutPostUnreachable = card("note-e");
    delete withoutPostUnreachable.postUnreachable;
    const invalidDateRejected = refuses(card("note-a", { publishedAt: 123 }));
    const missingDate = emptyKnowledgeData();
    missingDate.notes = [card("note-b", { publishedAt: "" })];
    const newFieldsRefused = {
      extractedKind: refuses(card("note-c", { extracted: { kind: "x", text: "a" } })),
      extractedText: refuses(card("note-c2", { extracted: { kind: "video-transcript", text: 1 } })),
      replyDamaged: refuses(card("note-d", { replyDamaged: "no" })),
      postUnreachableMissing: refuses(withoutPostUnreachable),
      mainSource: refuses(card("note-f", { mainSource: "curation" })),
      mainText: refuses(card("note-g", { mainText: null })),
      unverifiedTools: refuses(card("note-h", { unverifiedTools: "none" }))
    };
    const goodCards = (() => {
      const data = emptyKnowledgeData();
      data.notes = [
        card("g1", { extracted: { kind: "video-transcript", text: "t" } }),
        card("g2", { mainSource: "diandian", replyDamaged: true, postUnreachable: true, mainText: "" })
      ];
      return validateKnowledgeData(data).notes.length;
    })();
    result = {
      malformedRejected,
      unsafeResourceRejected,
      invalidDateRejected,
      newFieldsRefused,
      goodCards,
      missingDateAccepted: validateKnowledgeData(missingDate).notes.length,
      validEmpty: validateKnowledgeData(emptyKnowledgeData()).notes.length,
      unavailable: knowledgeLoadErrorMessage(new Error("HTTP 503"), { protocol: "https:" }),
      broken: knowledgeLoadErrorMessage(new SyntaxError("bad JSON"), { protocol: "https:" })
    };`, context);
  assert.equal(context.result.malformedRejected, true);
  assert.equal(context.result.unsafeResourceRejected, true);
  assert.equal(context.result.invalidDateRejected, true);
  assert.deepEqual({ ...context.result.newFieldsRefused }, {
    extractedKind: true, extractedText: true, replyDamaged: true, postUnreachableMissing: true, mainSource: true, mainText: true, unverifiedTools: true
  });
  assert.equal(context.result.goodCards, 2);
  assert.equal(context.result.missingDateAccepted, 1);
  assert.equal(context.result.validEmpty, 0);
  assert.match(context.result.unavailable, /HTTP 503/);
  assert.match(context.result.unavailable, /同步设置/);
  assert.doesNotMatch(context.result.unavailable, /双击 HTML|本地 HTTP 服务/);
  assert.match(context.result.broken, /格式|损坏/);

  const initSource = sourceSlice(app, "async function init()", "\ninit();");
  assert.ok(initSource.indexOf("bindEvents();") < initSource.indexOf("await fetch(DATA_URL"));
  assert.ok(initSource.indexOf("initBoardManager()") < initSource.indexOf("await fetch(DATA_URL"));
  assert.match(initSource, /renderKnowledgeLoadError\(error\)/);
  assert.match(initSource, /state\.knowledgeReady = false/);
  assert.match(initSource, /personalExport[\s\S]*disabled = true/);
});

test("navigation, filters and search expose synchronized accessible names and states", async () => {
  const [app, html, css] = await Promise.all([
    read("site/app.js"),
    read("site/index.html"),
    read("site/styles.css")
  ]);
  assert.match(html, /class="brand"[^>]*href="#notes"[^>]*data-home-link/);
  assert.match(html, /data-view="notes"[^>]*aria-current="page"/);
  assert.match(html, /id="search-input"[^>]*aria-label="搜索知识卡"/);
  assert.match(html, /id="resource-search"[^>]*aria-label="搜索资源"/);
  assert.match(app, /data-home-link[\s\S]*setView\("notes"\)/);
  assert.match(app, /setAttribute\("aria-current",\s*"page"\)/);
  assert.match(app, /removeAttribute\("aria-current"\)/);
  assert.match(app, /class="category-button[^`]*aria-pressed="\$\{state\.category === item\.name\}"/);
  assert.match(app, /class="kind-button[^`]*aria-pressed="\$\{state\.kind === item\.value\}"/);

  const mobileRules = sourceSlice(css, "@media (max-width: 840px)", "@media (max-width: 580px)");
  assert.doesNotMatch(mobileRules, /\.sidebar-heading,\s*\.sidebar-section\s*\{[^}]*display:\s*none/);
  assert.match(mobileRules, /\.sidebar-heading\s*\{[^}]*display:\s*none/);
  assert.match(mobileRules, /\.sidebar-section\s*\{[^}]*display:\s*block/);
});

test("public JSON validation rejects malformed documents", () => {
  assert.throws(
    () => assertPublicTextSafe('{"notes":', "data/knowledge.json"),
    /invalid JSON|malformed JSON|valid JSON/i
  );
});

test("public tree excludes private local roots case-insensitively and rejects homoglyph paths", async () => {
  const work = await mkdtemp(resolve(root, ".public-path-policy-test-"));
  try {
    await writeFile(resolve(work, "index.html"), "<!doctype html><title>ok</title>", "utf8");
    await mkdir(resolve(work, ".LOCAL"));
    await writeFile(resolve(work, ".LOCAL", "private.json"), '{"xsec_token":"secret"}', "utf8");
    await validatePublicTree(work);
    await mkdir(resolve(work, ".locаl")); // Cyrillic а.
    await writeFile(resolve(work, ".locаl", "bridge.json"), "{}", "utf8");
    await assert.rejects(() => validatePublicTree(work), /printable ASCII/);
    // The publisher's own .local exclusion is asserted by behaviour (a real publish) in
    // publisher-local-exclusion.test.mjs and test_huggingface_publish.mjs, not by source text.
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("public data output uses same-directory atomic replacement", async () => {
  const policy = await import("../scripts/public-tree-policy.mjs");
  assert.equal(typeof policy.atomicWriteTextFile, "function");
  const work = await mkdtemp(resolve(root, ".atomic-public-write-test-"));
  const target = resolve(work, "knowledge.json");
  try {
    await writeFile(target, "old\n");
    await policy.atomicWriteTextFile(target, "new\n");
    assert.equal(await readFile(target, "utf8"), "new\n");
    assert.deepEqual(await readdir(work), ["knowledge.json"]);

    const builder = await read("skills/xhs-favorites-organizer/scripts/build-public-site.mjs");
    assert.match(builder, /atomicWriteTextFile\(paths\.output, serialized\)/);
    assert.doesNotMatch(builder, /writeFile\(paths\.output,/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

async function buildProfileFixture(profileFile, options = {}) {
  const work = await mkdtemp(resolve(root, ".resource-index-test-"));
  const noteId = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const configPath = resolve(work, "config.json");
  const catalogPath = resolve(work, "catalog.json");
  const curationPath = resolve(work, "curation.json");
  const outputPath = resolve(work, "knowledge.json");
  const diandianPath = resolve(work, "diandian-summaries");
  const fixtureCuration = options.curation ?? (options.uncurated ? {} : {
    [noteId]: {
      category: "Fixture", themes: ["Fixture"],
      summary: "这是一条用于确定性编译的测试摘要，写清了对象、工作方式与限制，长度足够通过质量门。",
      action: "先核对配置的资源及其官方证据，再决定是否采用，并记录适用边界。",
      tools: [], kind: "Note"
    }
  });
  const contentSha256 = "c".repeat(64);
  const diandianFixtureRecord = options.diandianRecord || (options.diandianSummary ? (() => {
    const summary = String(options.diandianSummary).replace(/\r\n?/g, "\n").trim();
    return {
      version: 2,
      provider: "xiaohongshu-diandian",
      prompt: "总结",
      prompt_version: "9".repeat(64),
      note_id: noteId,
      title: "Fixture note",
      summary,
      content_sha256: contentSha256,
      request_sha256: "8".repeat(64),
      summary_sha256: createHash("sha256").update(summary, "utf8").digest("hex"),
      captured_at: "2026-08-23T00:00:00.000Z"
    };
  })() : null);
  const catalogNote = {
    ...(options.note || { title: "Fixture note", description: "Fixture description", source_boards: ["Fixture"] }),
    ...(options.diandianSummary ? { content_sha256: contentSha256 } : {})
  };
  await Promise.all([
    writeFile(configPath, JSON.stringify({
      version: 1,
      domain_profile: `config/domain-profiles/${profileFile}`,
      curation_file: curationPath,
      public_stats: {},
      ...(options.publishedSince ? { published_since: options.publishedSince } : {}),
      boards: options.boards || [{ id: "bbbbbbbbbbbbbbbbbbbbbbbb", name: "Fixture", enabled: true }]
    })),
    writeFile(catalogPath, JSON.stringify({ notes: { [noteId]: catalogNote } })),
    writeFile(curationPath, JSON.stringify(fixtureCuration))
  ]);
  if (diandianFixtureRecord) {
    await mkdir(diandianPath, { recursive: true });
    await writeFile(resolve(diandianPath, `${noteId}.json`), JSON.stringify(diandianFixtureRecord));
  }
  const args = [
    resolve(root, "skills/xhs-favorites-organizer/scripts/build-public-site.mjs"),
    "--config", configPath,
    "--catalog", catalogPath,
    "--curation", curationPath,
    "--profile", resolve(root, `config/domain-profiles/${profileFile}`),
    "--video-analysis", resolve(work, "video-analysis"),
    "--output", outputPath
  ];
  args.push("--diandian-dir", diandianPath);
  if (options.resources) args.push("--resources", options.resources);
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(await readFile(outputPath, "utf8"));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

test("public site ships complete, structured knowledge data", async () => {
  const data = JSON.parse(await read("site/data/knowledge.json"));
  assert.ok(data.notes.length >= 32);
  assert.equal(data.meta.noteCount, data.notes.length);
  assert.ok(data.resources.length >= 30);
  assert.equal(data.meta.resourceCount, data.resources.length);
  assert.equal(data.meta.resourceIndexEnabled, true);
  assert.equal(data.meta.categoryStrategy, "source-board-first");
  assert.ok(data.categories.length >= 8);

  for (const note of data.notes) {
    assert.match(note.id, /^[a-f0-9]{24}$/);
    assert.ok(note.title.length > 0);
    // Every card carries its own text; a card with none is the one case the data allows to be empty.
    assert.equal(typeof note.mainText, "string");
    assert.match(note.mainSource, /^(diandian|post-text|video-transcript|image-text)$/);
    assert.equal(typeof note.replyDamaged, "boolean");
    assert.equal(typeof note.postUnreachable, "boolean");
    assert.ok(Array.isArray(note.unverifiedTools));
    assert.equal(note.sourceUrl, `https://www.xiaohongshu.com/explore/${note.id}`);
    assert.equal(Object.hasOwn(note, "priority"), false);
    assert.equal(Object.hasOwn(note, "risk"), false);
    assert.match(note.kind, /^(Note|Tool|Skill|Workflow|Product)$/);
    assert.equal(note.categorySource, "source_board");
    assert.ok(Array.isArray(note.sourceBoards) && note.sourceBoards.length > 0);
    assert.equal(Object.keys(note).some((key) => /board.*id/i.test(key)), false);
  }

  assert.equal(Object.hasOwn(data.meta, "priorityLabels"), false);
  assert.ok(data.meta.sourceBoards.includes("Skills"));
  assert.equal(data.notes.some((note) => note.title === "未命名收藏"), false);
  // The old gate's fields are gone, and the home counts are what the cards show.
  for (const note of data.notes) {
    for (const gone of ["summary", "deepSummary", "deepSummarySource", "summaryStatus", "curationStatus", "summaryState", "candidateKind", "action", "evidence"]) {
      assert.equal(Object.hasOwn(note, gone), false, `${note.id}.${gone}`);
    }
  }
  assert.equal(data.meta.replyCount, data.notes.filter((note) => note.mainSource === "diandian" && !note.replyDamaged).length);
  assert.equal(data.meta.transcriptCount, data.notes.filter((note) => note.mainSource === "video-transcript" || note.extracted?.kind === "video-transcript").length);
  assert.equal(Object.hasOwn(data.meta, "verifiedNoteCount"), false);
  assert.equal(Object.hasOwn(data.meta, "videoMethod"), false);
});

test("missing titles are inferred and public source navigation links the post without any session token", async () => {
  const data = await buildProfileFixture("software.json", {
    uncurated: true,
    note: {
      title: "",
      description: "国产“爱死机”《丧尸清道夫》创作思路分享#AI视频[话题]#",
      author: "创作者",
      source_boards: ["Fixture"]
    }
  });
  const note = data.notes[0];
  assert.equal(note.title, "国产“爱死机”《丧尸清道夫》创作思路分享");
  assert.equal(note.category, "Fixture");
  assert.equal(note.suggestedCategory, "AI设计与多媒体");
  assert.equal(note.categorySource, "source_board");
  assert.equal(note.sourceUrl, `https://www.xiaohongshu.com/explore/${note.id}`);
  assert.doesNotMatch(note.sourceUrl, /xsec_token|search_result/);
});

test("a saved DianDian reply becomes the card's main text without leaking source links", async () => {
  const data = await buildProfileFixture("software.json", {
    diandianSummary: "这是点点 AI 对图文或视频内容生成的完整深度总结。"
  });
  assert.equal(data.notes[0].mainText, "这是点点 AI 对图文或视频内容生成的完整深度总结。");
  assert.equal(data.notes[0].mainSource, "diandian");
  assert.equal(data.notes[0].replyDamaged, false);
  assert.doesNotMatch(JSON.stringify(data), /xsec_token|source_url/i);
});

test("knowledge cards disclose where their text came from and format it safely", async () => {
  const [app, css] = await Promise.all([read("site/app.js"), read("site/styles.css")]);
  const helperStart = app.indexOf("function escapeHtml(value = \"\")");
  const helperEnd = app.indexOf("function safeUrl", helperStart);
  const helperSource = helperStart >= 0 && helperEnd > helperStart
    ? app.slice(helperStart, helperEnd).trim()
    : "";
  assert.ok(helperSource, "summary formatting helpers must be part of the production app");

  const card = (changes) => ({ mainText: "正文", mainSource: "post-text", replyDamaged: false, postUnreachable: false, ...changes });
  const result = runInNewContext(`${helperSource}\n({
    reply: summarySourcePresentation(${JSON.stringify(card({ mainSource: "diandian", mainText: "根据你引用的笔记，这是一篇分享：\n\n核心故事\n\n正文" }))}),
    replyNoOpener: summarySourcePresentation(${JSON.stringify(card({ mainSource: "diandian", mainText: "核心故事\n\n正文" }))}),
    replyOnlyText: summarySourcePresentation(${JSON.stringify(card({ mainSource: "diandian", replyDamaged: true }))}),
    postDamaged: summarySourcePresentation(${JSON.stringify(card({ replyDamaged: true }))}),
    postNoReply: summarySourcePresentation(${JSON.stringify(card({}))}),
    transcript: summarySourcePresentation(${JSON.stringify(card({ mainSource: "video-transcript" }))}),
    transcriptDamaged: summarySourcePresentation(${JSON.stringify(card({ mainSource: "video-transcript", replyDamaged: true }))}),
    pictureText: summarySourcePresentation(${JSON.stringify(card({ mainSource: "image-text" }))}),
    unreachable: summarySourcePresentation(${JSON.stringify(card({ mainSource: "diandian", postUnreachable: true }))}),
    post: formatPostHtml("第一段\\n\\n\\n第二段\\n第三行 <script>alert(1)</script>"),
    formatted: formatSummaryHtml("执行步骤：\\n1，先找参考图\\n2，再洗素材\\n\\n**补充说明**\\n补充说明。<script>alert(1)</script>"),
    longPlainText: formatSummaryHtml("这是没有原始换行的长总结句子。".repeat(48)),
    pointStyle: formatSummaryHtml("核心逻辑 先判断需求。 三步实操方法 1. 收集证据 2. 验证结果 案例与价值 用真实数据复核。 补充提醒 不要把假设当结论。")
  })`, { stripDiandianOpener, diandianBlocks });

  const damagedOpening = "保存的点点回复缺了内容（是我们采集出错），下一轮重新获取；";
  assert.equal(result.reply.label, "点点 AI 深度总结");
  assert.match(result.reply.explanation, /^点点 AI 的完整回复，原文未改动，共 \d+ 字；只去掉开头的对话语句，按小标题与列表排版。$/);
  assert.doesNotMatch(result.replyNoOpener.explanation, /只去掉开头/);
  assert.equal(result.replyOnlyText.label, "点点 AI 深度总结");
  assert.equal(result.replyOnlyText.explanation, `${damagedOpening}原帖只有话题标签、没有正文，所以先显示已保存的那部分点点回复。`);
  assert.equal(result.postDamaged.label, "原帖公开文字");
  assert.equal(result.postDamaged.explanation, `${damagedOpening}在那之前先显示原帖自己的文字。`);
  assert.equal(result.postNoReply.label, "原帖公开文字");
  assert.equal(result.postNoReply.explanation, "这篇没有点点总结；先显示原帖自己的文字。");
  assert.equal(result.transcript.label, "视频转写与画面文字");
  assert.equal(result.transcript.explanation, "这篇没有点点总结；原帖只有话题标签、没有正文，所以这里是视频里说的话和画面上的字，未经 AI 改写。");
  assert.equal(result.transcriptDamaged.explanation, `${damagedOpening}原帖只有话题标签、没有正文，所以这里是视频里说的话和画面上的字，未经 AI 改写。`);
  assert.equal(result.pictureText.label, "图片文字");
  assert.match(result.pictureText.explanation, /所以这里是图片上的字，未经 AI 改写。$/);
  // An unreachable post keeps its own label whatever the text is.
  assert.equal(result.unreachable.label, "已完成（原帖不可访问）");
  assert.equal(result.unreachable.explanation, "原帖可能已被作者隐藏或删除；已保留现有记录并结束补证，不作为正式核验结果发布。");
  // No label or sentence speaks of review, failure or waiting any more.
  for (const presentation of Object.values({ ...result }).filter((item) => item?.label)) {
    assert.doesNotMatch(`${presentation.label}${presentation.explanation}`, /证据未补齐|暂不发布|审核|失败|未尝试|需重新核验|尚未开始/);
  }

  assert.equal(result.post, "<p>第一段</p><p>第二段<br />第三行 &lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.match(result.formatted, /<h4>执行步骤<\/h4>/);
  assert.match(result.formatted, /<h4>补充说明<\/h4>/);
  assert.match(result.formatted, /<ol[^>]*>\s*<li>先找参考图<\/li>\s*<li>再洗素材<\/li>\s*<\/ol>/);
  assert.match(result.formatted, /<p>补充说明。&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/);
  assert.doesNotMatch(result.formatted, /<script>/);
  assert.ok((result.longPlainText.match(/<p>/g) || []).length >= 3, "long unstructured summaries must not render as one text wall");
  assert.match(result.pointStyle, /<h4>核心逻辑<\/h4>/);
  assert.match(result.pointStyle, /<h4>三步实操方法<\/h4>/);
  assert.match(result.pointStyle, /<h4>案例与价值<\/h4>/);
  assert.match(result.pointStyle, /<h4>补充提醒<\/h4>/);

  // The grid and the detail view draw the same source line and text from the same functions; the browser
  // cases for every state are in site/e2e/faithful-cards.spec.mjs.
  assert.ok(app.includes('class="card-summary-source card-summary-source--${summarySource.tone}"'));
  assert.ok(app.includes('class="card-summary structured-summary structured-summary--card"'));
  assert.ok(css.indexOf(".structured-summary.structured-summary--card") > css.indexOf(".structured-summary {"));
  assert.match(app, /\$\{descriptionHtml\(note\)\}/);
  assert.match(app, /summarySourcePresentation\(note\)/);
  assert.match(css, /\.structured-summary\s*\{[^}]*display:\s*grid[^}]*gap:/);
  assert.match(css, /\.summary-provenance--diandian/);
  assert.match(css, /\.card-summary-source--evidence/);
});

test("detail dialog locks the background and restores its exact scroll position", async () => {
  const app = await read("site/app.js");
  const helperStart = app.indexOf("let dialogScrollLock = null;");
  const helperEnd = app.indexOf("\nfunction configureHostLayout", helperStart);
  const helperSource = helperStart >= 0 && helperEnd > helperStart
    ? app.slice(helperStart, helperEnd).trim()
    : "";
  assert.ok(helperSource, "dialog scroll-lock helpers must be part of the production app");

  const makeClassList = () => {
    const values = new Set();
    return {
      add(value) { values.add(value); },
      remove(value) { values.delete(value); },
      contains(value) { return values.has(value); }
    };
  };
  const documentElement = { classList: makeClassList() };
  const body = { classList: makeClassList(), style: { top: "7px" } };
  const scrollCalls = [];
  const window = {
    scrollY: 640,
    scrollTo(options) { scrollCalls.push(options); }
  };

  const result = runInNewContext(`${helperSource}
    lockDialogBackground();
    const locked = {
      root: document.documentElement.classList.contains("dialog-scroll-lock"),
      body: document.body.classList.contains("dialog-scroll-lock"),
      top: document.body.style.top
    };
    window.scrollY = 999;
    lockDialogBackground();
    unlockDialogBackground();
    ({
      locked,
      rootUnlocked: !document.documentElement.classList.contains("dialog-scroll-lock"),
      bodyUnlocked: !document.body.classList.contains("dialog-scroll-lock"),
      restoredTop: document.body.style.top,
      scrollCalls
    });
  `, { document: { documentElement, body }, window, scrollCalls });

  assert.equal(result.locked.root, true);
  assert.equal(result.locked.body, true);
  assert.equal(result.locked.top, "-640px");
  assert.equal(result.rootUnlocked, true);
  assert.equal(result.bodyUnlocked, true);
  assert.equal(result.restoredTop, "7px");
  assert.equal(JSON.stringify(result.scrollCalls), JSON.stringify([{ left: 0, top: 640, behavior: "instant" }]));
});

test("the production detail open and close path wires the scroll lock", async () => {
  const app = await read("site/app.js");
  const helperStart = app.indexOf("let dialogScrollLock = null;");
  const helperEnd = app.indexOf("\nfunction configureHostLayout", helperStart);
  const openStart = app.indexOf("function openNote(noteId, updateHash = true)");
  const openEnd = app.indexOf("\nfunction clearFilters", openStart);
  const helperSource = helperStart >= 0 && helperEnd > helperStart
    ? app.slice(helperStart, helperEnd).trim()
    : "";
  const openCloseSource = openStart >= 0 && openEnd > openStart
    ? app.slice(openStart, openEnd).trim()
    : "";
  assert.ok(helperSource && openCloseSource, "production detail open/close functions must be testable");

  const makeClassList = () => {
    const values = new Set();
    return {
      add(value) { values.add(value); },
      remove(value) { values.delete(value); },
      contains(value) { return values.has(value); }
    };
  };
  const documentElement = { classList: makeClassList() };
  const body = { classList: makeClassList(), style: { top: "" } };
  const dialog = {
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; }
  };
  const historyUrls = [];
  const scrollCalls = [];
  const metrics = { renderCount: 0 };

  const result = runInNewContext(`${helperSource}\n${openCloseSource}
    openNote("note-a");
    const opened = {
      dialog: elements.dialog.open,
      rootLocked: document.documentElement.classList.contains("dialog-scroll-lock"),
      bodyLocked: document.body.classList.contains("dialog-scroll-lock"),
      bodyTop: document.body.style.top
    };
    closeDialog();
    ({
      opened,
      dialogClosed: !elements.dialog.open,
      rootUnlocked: !document.documentElement.classList.contains("dialog-scroll-lock"),
      bodyUnlocked: !document.body.classList.contains("dialog-scroll-lock"),
      renderCount: metrics.renderCount,
      historyUrls,
      scrollCalls
    });
  `, {
    document: { documentElement, body },
    window: {
      scrollY: 480,
      scrollTo(options) { scrollCalls.push(options); }
    },
    state: { data: { notes: [{ id: "note-a" }] }, editingDescriptionId: "note-a", expandedSummaries: new Set() },
    elements: { dialog },
    renderDetail() { metrics.renderCount += 1; },
    settleSummaryFolds() {},
    history: { replaceState(_state, _title, url) { historyUrls.push(url); } },
    location: { pathname: "/", search: "" },
    metrics,
    historyUrls,
    scrollCalls
  });

  assert.equal(result.opened.dialog, true);
  assert.equal(result.opened.rootLocked, true);
  assert.equal(result.opened.bodyLocked, true);
  assert.equal(result.opened.bodyTop, "-480px");
  assert.equal(result.dialogClosed, true);
  assert.equal(result.rootUnlocked, true);
  assert.equal(result.bodyUnlocked, true);
  assert.equal(result.renderCount, 1);
  assert.equal(JSON.stringify(result.historyUrls), JSON.stringify(["#note=note-a", "/"]));
  assert.equal(JSON.stringify(result.scrollCalls), JSON.stringify([{ left: 0, top: 480, behavior: "instant" }]));
});

test("local original is located by the bridge in the shared SOP scanner browser", async () => {
  const app = await read("site/app.js");
  const readyStart = app.indexOf("function sopBrowserReady()");
  const readyEnd = app.indexOf("\nfunction bookmarkIcon", readyStart);
  const readySource = readyStart >= 0 && readyEnd > readyStart ? app.slice(readyStart, readyEnd).trim() : "";
  assert.ok(readySource, "the SOP browser readiness guard must be registered");
  const listenerStart = app.indexOf('elements.dialogContent.addEventListener("click", async (event) => {');
  const listenerEnd = app.indexOf('\n  elements.dialogContent.addEventListener("submit"', listenerStart);
  assert.ok(listenerStart >= 0 && listenerEnd > listenerStart, "the production click handler must be registered");
  const listenerSource = app.slice(listenerStart, listenerEnd).trim();
  const outcomes = JSON.parse(await runInNewContext(`
    let clickHandler;
    let mode = "success";
    let events = [];
    let sourceButton;
    const elements = {
      dialogContent: {
        dataset: {},
        addEventListener(type, handler) { if (type === "click") clickHandler = handler; }
      }
    };
    const window = {};
    async function localBridgeRequest(path, options) {
      events.push(["request", path, options.method, options.body]);
      if (mode === "failure") throw new Error("bridge unavailable");
      return { ok: true, browser: "favsense-dedicated" };
    }
    function showToast(message) { events.push(["toast", message]); }
    function toggleBookmark() { throw new Error("wrong click branch"); }
    function renderDetail() { throw new Error("wrong click branch"); }
    function persistPersonalData() { throw new Error("wrong click branch"); }
    function renderNotes() { throw new Error("wrong click branch"); }
    const state = {
      localBridge: { browserSession: { owner: "sop-cdp", ready: true } },
      data: { notes: [] },
      descriptionOverrides: {}
    };
    const location = { origin: "http://127.0.0.1:8766", pathname: "/", search: "" };
    const navigator = { clipboard: { writeText() { throw new Error("wrong click branch"); } } };
    ${readySource}
    ${listenerSource}
    async function runScenario(nextMode) {
      mode = nextMode;
      events = [];
      sourceButton = { disabled: false, dataset: { openSourceNote: "note-a" } };
      const event = {
        target: {
          closest(selector) { return selector === "[data-open-source-note]" ? sourceButton : null; }
        }
      };
      await clickHandler(event);
      return {
        mode,
        events,
        disabled: sourceButton.disabled
      };
    }
    (async () => JSON.stringify([
      await runScenario("success"),
      await runScenario("failure")
    ]))()
  `, { URL }));

  const [success, failure] = outcomes;
  assert.deepEqual(success.events, [
    ["request", "/notes/open", "POST", JSON.stringify({ note_id: "note-a" })],
    ["toast", "已在 SOP 扫描浏览器中定位原帖"]
  ]);
  assert.equal(success.disabled, false);
  assert.equal(failure.disabled, false);
  assert.deepEqual(failure.events, [
    ["request", "/notes/open", "POST", JSON.stringify({ note_id: "note-a" })],
    ["toast", "没有打开原帖：bridge unavailable"]
  ]);
  assert.doesNotMatch(app, /window\.open\("about:blank", "_blank"\)/);
});

test("local actions stay inert until the SOP scanner browser becomes ready, then recover through the full state arc", async () => {
  const app = await read("site/app.js");
  const readyStart = app.indexOf("function sopBrowserReady()");
  const readyEnd = app.indexOf("\nfunction bookmarkIcon", readyStart);
  const renderSyncStart = app.indexOf("function manualSyncRunning(");
  const renderSyncEnd = app.indexOf("\nasync function refreshManualSyncStatus", renderSyncStart);
  const manualStart = app.indexOf("async function startManualSync()");
  const manualEnd = app.indexOf("\nasync function startSingleNoteSync", manualStart);
  const singleStart = app.indexOf("async function startSingleNoteSync(noteId)");
  const singleEnd = app.indexOf("\nasync function initBoardManager", singleStart);
  const detailStart = app.indexOf("function renderDetail(note)");
  const detailEnd = app.indexOf("\nfunction openNote", detailStart);
  const listenerStart = app.indexOf('elements.dialogContent.addEventListener("click", async (event) => {');
  const listenerEnd = app.indexOf('\n  elements.dialogContent.addEventListener("submit"', listenerStart);
  for (const [name, start, end] of [
    ["SOP readiness helper", readyStart, readyEnd],
    ["manual sync renderer", renderSyncStart, renderSyncEnd],
    ["manual sync action", manualStart, manualEnd],
    ["single-note action", singleStart, singleEnd],
    ["detail renderer", detailStart, detailEnd],
    ["detail click handler", listenerStart, listenerEnd]
  ]) assert.ok(start >= 0 && end > start, `${name} must be available for the mounted state-arc test`);

  const source = [
    app.slice(readyStart, readyEnd).trim(),
    app.slice(renderSyncStart, renderSyncEnd).trim(),
    app.slice(manualStart, manualEnd).trim(),
    app.slice(singleStart, singleEnd).trim(),
    app.slice(detailStart, detailEnd).trim(),
    app.slice(listenerStart, listenerEnd).trim()
  ].join("\n");
  const result = JSON.parse(await runInNewContext(`
    let clickHandler;
    let requests = [];
    let toasts = [];
    const makeTextNode = () => ({ textContent: "", disabled: false });
    const dialogContent = {
      dataset: {},
      innerHTML: "",
      querySelector() { return null; },
      addEventListener(type, handler) { if (type === "click") clickHandler = handler; }
    };
    const elements = {
      manualSyncControl: { classList: { toggle() {} } },
      manualSyncStart: makeTextNode(),
      manualSyncClearStop: makeTextNode(),
      manualSyncLocalRebuild: makeTextNode(),
      manualSyncTitle: makeTextNode(),
      manualSyncDetail: makeTextNode(),
      dialog: { style: { setProperty() {} } },
      dialogContent
    };
    const state = {
      data: { notes: [], meta: { resourceIndex: {} } },
      localBridge: {
        baseUrl: "http://127.0.0.1:47631",
        diandianAvailable: true,
        browserSession: { owner: "sop-cdp", ready: false }
      },
      manualSync: { state: "idle" },
      manualSyncStartedHere: false,
      manualSyncPoll: 0,
      boards: [],
      bookmarks: new Set(),
      descriptionOverrides: {}
    };
    const note = {
      id: "note-a", title: "Fixture", author: "Author", publishedAt: "2026-08-01",
      category: "Fixture", kind: "Note", action: "", resources: [], themes: [], tools: [],
      evidence: { method: "Fixture evidence" }, sourceUrl: "#"
    };
    async function localBridgeRequest(path, options = {}) {
      requests.push([path, options.method || "GET", options.body || ""]);
      return { ok: true, state: "running" };
    }
    function validateLocalBridgeSyncStatus(value) { return value; }
    function normalizeLocalBridgeDiagnostic(value) { return typeof value === "string" ? value.trim() : ""; }
    function showToast(message) { toasts.push(message); }
    function watchManualSync() {}
    function resourceMap() { return new Map(); }
    function categoryAccent() { return "#000"; }
    function escapeHtml(value) { return String(value ?? ""); }
    function safeUrl() { return "#"; }
    function formatDate() { return "2026-08-01"; }
    function descriptionSection() { return ""; }
    function settleSummaryFolds() {}
    function bookmarkIcon() { return ""; }
    function isLocalWorkbenchLocation() { return true; }
    function toggleBookmark() {}
    function persistPersonalData() {}
    function renderNotes() {}
    ${source}
    (async () => {
      renderManualSync({ state: "idle" });
      renderDetail(note);
      const unavailable = {
        startDisabled: elements.manualSyncStart.disabled,
        title: elements.manualSyncTitle.textContent,
        detail: elements.manualSyncDetail.textContent,
        detailHtml: elements.dialogContent.innerHTML
      };
      await startManualSync();
      await startSingleNoteSync("note-a");
      const staleSourceButton = { disabled: false, dataset: { openSourceNote: "note-a" } };
      await clickHandler({ target: { closest(selector) {
        return selector === "[data-open-source-note]" ? staleSourceButton : null;
      } } });
      const unavailableRequests = requests.slice();

      requests = [];
      toasts = [];
      state.localBridge.browserSession.ready = true;
      state.manualSync = { state: "idle" };
      renderManualSync(state.manualSync);
      renderDetail(note);
      const ready = {
        startDisabled: elements.manualSyncStart.disabled,
        detailHtml: elements.dialogContent.innerHTML
      };
      await startManualSync();
      state.manualSync = { state: "idle" };
      const sourceButton = { disabled: false, dataset: { openSourceNote: "note-a" } };
      await clickHandler({ target: { closest(selector) {
        return selector === "[data-open-source-note]" ? sourceButton : null;
      } } });
      state.manualSync = { state: "idle" };
      await startSingleNoteSync("note-a");
      return JSON.stringify({ unavailable, unavailableRequests, ready, requests, toasts });
    })();
  `, { window: { location: { protocol: "http:", hostname: "127.0.0.1" } }, URL }));

  assert.equal(result.unavailable.startDisabled, true);
  assert.match(`${result.unavailable.title} ${result.unavailable.detail}`, /SOP (?:小红书)?扫描浏览器/);
  assert.match(result.unavailable.detailHtml, /SOP 扫描浏览器未就绪/);
  assert.doesNotMatch(result.unavailable.detailHtml, /data-open-source-note|data-summarize-note/);
  assert.deepEqual(result.unavailableRequests, [], "disabled local actions must not POST while the SOP browser is unavailable");

  assert.equal(result.ready.startDisabled, false);
  assert.match(result.ready.detailHtml, /data-open-source-note="note-a"/);
  assert.match(result.ready.detailHtml, /data-summarize-note="note-a"/);
  assert.deepEqual(result.requests, [
    ["/sync/start", "POST", "{}"],
    ["/notes/open", "POST", JSON.stringify({ note_id: "note-a" })],
    ["/sync/start", "POST", JSON.stringify({ note_id: "note-a" })]
  ]);
  assert.equal(result.toasts.every((message) => /SOP 扫描浏览器|没有/.test(message)), true);
  assert.equal(result.toasts.some((message) => /SOP 扫描浏览器中开始整理收藏/.test(message)), true);
  assert.equal(result.toasts.some((message) => /SOP 扫描浏览器中定位原帖/.test(message)), true);
  assert.equal(result.toasts.some((message) => /SOP 扫描浏览器中仅校验并重新总结/.test(message)), true);
});

test("mounted note detail starts one local-only DianDian validation without changing boards", async () => {
  const app = await read("site/app.js");
  const readyStart = app.indexOf("function sopBrowserReady()");
  const readyEnd = app.indexOf("\nfunction bookmarkIcon", readyStart);
  const readySource = readyStart >= 0 && readyEnd > readyStart ? app.slice(readyStart, readyEnd).trim() : "";
  assert.ok(readySource, "the SOP browser readiness guard must be available to the mounted detail");
  const localLocationStart = app.indexOf("function isLocalWorkbenchLocation(");
  const localLocationEnd = app.indexOf("\nfunction renderDetail", localLocationStart);
  const localLocationSource = localLocationStart >= 0 && localLocationEnd > localLocationStart
    ? app.slice(localLocationStart, localLocationEnd).trim()
    : "";
  assert.ok(localLocationSource, "the app must distinguish a local workbench from a public deployment");
  const renderStart = app.indexOf("function renderDetail(note)");
  const renderEnd = app.indexOf("\nfunction openNote", renderStart);
  const renderSource = renderStart >= 0 && renderEnd > renderStart
    ? app.slice(renderStart, renderEnd).trim()
    : "";
  assert.ok(renderSource, "the production detail renderer must be available to mount");

  const runningCheckStart = app.indexOf("function manualSyncRunning(");
  const runningCheckSource = app.slice(runningCheckStart, app.indexOf("\nfunction renderManualSync", runningCheckStart)).trim();
  assert.ok(runningCheckStart >= 0 && runningCheckSource, "the shared running check must be part of the production app");

  const rendered = runInNewContext(`${readySource}
    ${runningCheckSource}
    ${localLocationSource}
    ${renderSource}
    renderDetail(note);
    const publicHtml = elements.dialogContent.innerHTML;
    window.location = { protocol: "http:", hostname: "127.0.0.1" };
    renderDetail(note);
    const disconnectedLocalHtml = elements.dialogContent.innerHTML;
    state.localBridge = {
      baseUrl: "http://127.0.0.1:47631",
      diandianAvailable: false,
      browserSession: { owner: "sop-cdp", ready: true }
    };
    renderDetail(note);
    const unavailableLocalHtml = elements.dialogContent.innerHTML;
    state.localBridge.diandianAvailable = true;
    renderDetail(note);
    ({ publicHtml, disconnectedLocalHtml, unavailableLocalHtml, localHtml: elements.dialogContent.innerHTML });
  `, {
    note: {
      id: "note-a",
      title: "Fixture note",
      author: "Fixture author",
      sourceUrl: "https://www.xiaohongshu.com/explore/note-a",
      publishedAt: "2026-08-01",
      category: "Fixture",
      kind: "Note",
      action: "",
      resources: [],
      themes: [],
      tools: [],
      evidence: { method: "Fixture evidence" }
    },
    state: {
      data: { meta: { resourceIndex: {} } },
      localBridge: null,
      manualSync: { state: "idle" },
      bookmarks: new Set()
    },
    elements: {
      dialog: { style: { setProperty() {} } },
      dialogContent: { dataset: {}, innerHTML: "" }
    },
    resourceMap: () => new Map(),
    categoryAccent: () => "#000",
    escapeHtml: (value) => String(value ?? ""),
    safeUrl: (value) => value,
    formatDate: () => "2026-08-01",
    descriptionSection: () => "",
    settleSummaryFolds: () => {},
    bookmarkIcon: () => "",
    window: { location: { protocol: "https:", hostname: "leeroyy1288-favsense.hf.space" } }
  });
  assert.match(rendered.publicHtml, /target="_blank"/);
  assert.match(rendered.publicHtml, /<a href="https:\/\/www\.xiaohongshu\.com\/explore\/note-a"[^>]*>在小红书中查看原帖<\/a>/);
  assert.doesNotMatch(rendered.publicHtml, /搜索原帖/);
  assert.doesNotMatch(rendered.disconnectedLocalHtml, /target="_blank"/);
  assert.match(rendered.disconnectedLocalHtml, /请先启动 FavSense 本地服务/);
  assert.match(rendered.disconnectedLocalHtml, /disabled/);
  assert.doesNotMatch(rendered.publicHtml, /data-summarize-note/);
  assert.doesNotMatch(rendered.unavailableLocalHtml, /data-summarize-note/);
  assert.match(rendered.unavailableLocalHtml, /disabled/);
  assert.match(rendered.unavailableLocalHtml, /点点/);
  assert.match(rendered.localHtml, /data-summarize-note="note-a"/);
  assert.match(rendered.localHtml, /仅在本机/);
  assert.match(rendered.localHtml, /重新总结此卡/);
  assert.match(rendered.localHtml, /不会发布/);

  const startStart = app.indexOf("async function startSingleNoteSync(noteId)");
  const startEnd = app.indexOf("\nasync function initBoardManager", startStart);
  const startSource = startStart >= 0 && startEnd > startStart
    ? app.slice(startStart, startEnd).trim()
    : "";
  assert.ok(startSource, "the one-note local start action must be part of the production app");
  const listenerStart = app.indexOf('elements.dialogContent.addEventListener("click", async (event) => {');
  const listenerEnd = app.indexOf('\n  elements.dialogContent.addEventListener("submit"', listenerStart);
  const listenerSource = listenerStart >= 0 && listenerEnd > listenerStart
    ? app.slice(listenerStart, listenerEnd).trim()
    : "";
  assert.ok(listenerSource, "the production detail click handler must be registered");

  const result = JSON.parse(await runInNewContext(`
    let clickHandler;
    const events = [];
    const elements = {
      dialogContent: {
        dataset: {},
        addEventListener(type, handler) { if (type === "click") clickHandler = handler; }
      }
    };
    const state = {
      localBridge: {
        baseUrl: "http://127.0.0.1:47631",
        diandianAvailable: true,
        browserSession: { owner: "sop-cdp", ready: true }
      },
      manualSync: { state: "idle" },
      manualSyncStartedHere: false,
      data: { notes: [] },
      descriptionOverrides: {}
    };
    async function localBridgeRequest(path, options) {
      events.push(["request", path, options.method, options.body]);
      return { ok: true, state: "running" };
    }
    function validateLocalBridgeSyncStatus(value) { return value; }
    function renderManualSync(status) {
      state.manualSync = status;
      events.push(["render", status.state]);
    }
    function watchManualSync() { events.push(["watch"]); }
    function showToast(message) { events.push(["toast", message]); }
    ${runningCheckSource}
    ${readySource}
    ${startSource}
    ${listenerSource}
    (async () => {
      const button = { disabled: false, dataset: { summarizeNote: "note-a" } };
      await clickHandler({
        target: {
          closest(selector) { return selector === "[data-summarize-note]" ? button : null; }
        }
      });
      return JSON.stringify({ events, disabled: button.disabled, startedHere: state.manualSyncStartedHere });
    })();
  `));

  assert.deepEqual(result.events.slice(0, 3), [
    ["render", "starting"],
    ["request", "/sync/start", "POST", JSON.stringify({ note_id: "note-a" })],
    ["render", "running"]
  ]);
  assert.equal(result.events.some((event) => event[1] === "/boards"), false);
  assert.equal(result.events.filter((event) => event[0] === "request").length, 1);
  assert.equal(result.events.some((event) => event[0] === "watch"), true);
  assert.equal(result.events.some((event) => event[0] === "toast" && /不会发布/.test(event[1])), true);
  assert.equal(result.disabled, true);
  assert.equal(result.startedHere, true);
});

test("public compilation ignores mismatched or credential-shaped DianDian records", async () => {
  const mismatched = await buildProfileFixture("software.json", {
    diandianRecord: {
      version: 1,
      provider: "xiaohongshu-diandian",
      prompt: "总结",
      note_id: "different-note-id",
      title: "Fixture note",
      summary: "不应按标题或文件位置关联这份摘要。"
    }
  });
  assert.notEqual(mismatched.notes[0].mainSource, "diandian");
  assert.doesNotMatch(mismatched.notes[0].mainText, /不应按标题/);

  const credentialShaped = await buildProfileFixture("software.json", {
    diandianRecord: {
      version: 1,
      provider: "xiaohongshu-diandian",
      prompt: "总结",
      note_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
      title: "Fixture note",
      summary: "这份文本不应被公开。",
      xsec_token: "credential-shaped-value"
    }
  });
  assert.notEqual(credentialShaped.notes[0].mainSource, "diandian");
  assert.doesNotMatch(JSON.stringify(credentialShaped), /credential-shaped-value|这份文本不应被公开/);
});

test("public compilation rejects encoded sensitive data in saved DianDian records", async () => {
  const data = await buildProfileFixture("software.json", {
    diandianRecord: {
      version: 1,
      provider: "xiaohongshu-diandian",
      prompt: "总结",
      note_id: "aaaaaaaaaaaaaaaaaaaaaaaa",
      title: "Fixture note",
      summary: "Encoded source %78%73%65%63%5f%74%6f%6b%65%6e%3dsecret"
    }
  });
  assert.notEqual(data.notes[0].mainSource, "diandian");
  assert.doesNotMatch(JSON.stringify(data), /Encoded source/);
});

test("sensitive scanner rejects composed encoding and normalized object keys", () => {
  let nestedUrl = "https://www.xiaohongshu.com/board/private";
  for (let index = 0; index < 6; index += 1) nestedUrl = encodeURIComponent(nestedUrl);
  for (const value of [
    "%78%73%65%63%5f%E2%80%8B%74%6f%6b%65%6e%3dsecret",
    String.raw`{"xsec\u005ftoken":"secret"}`,
    String.raw`{"xsec\u200b_token":"secret"}`,
    "https%26%23%35%38%3B%26%23%34%37%3B%26%23%34%37%3Bwww%26period%3Bxiaohongshu%26period%3Bcom%26sol%3Bboard%26sol%3Bprivate",
    { "xsec_\u200btoken": "secret" },
    nestedUrl
  ]) assert.equal(containsCredentialShape(value), true);
});

test("public compilation fails closed when private board identifiers appear in a saved reply", async () => {
  await assert.rejects(
    () => buildProfileFixture("software.json", {
      diandianSummary: "Accidentally echoed private identifier bbbbbbbbbbbbbbbbbbbbbbbb."
    }),
    /Public data safety check failed/
  );
});

test("deep-processing cutoff does not hide historical catalog cards", async () => {
  const data = await buildProfileFixture("software.json", {
    publishedSince: "2026-01-01",
    note: {
      title: "范围外收藏",
      description: "旧内容",
      published_at: "2025-12-31_23:59:59",
      source_boards: ["Fixture"]
    }
  });
  assert.equal(data.notes.length, 1);
  assert.equal(data.meta.noteCount, 1);
  assert.equal(data.notes[0].title, "范围外收藏");
});

test("uncertain software content uses a neutral category instead of Vibe Coding", async () => {
  const data = await buildProfileFixture("software.json", {
    uncurated: true,
    note: { title: "一条暂时无法判断领域的收藏", description: "一般观点", source_boards: ["Fixture"] }
  });
  assert.equal(data.notes[0].category, "Fixture");
  assert.equal(data.notes[0].suggestedCategory, "其他软件与 AI");
});

test("source boards are the default primary category while content remains a searchable suggestion", () => {
  const result = resolveCategoryPolicy({
    entry: { category: "动作技术", themes: ["深蹲"] },
    note: { source_boards: ["下肢训练"] },
    config: { boards: [{ name: "下肢训练", enabled: true }] },
    profile: { classification: { category_strategy: "source-board-first" }, fallback: {} }
  });
  assert.equal(result.category, "下肢训练");
  assert.equal(result.categorySource, "source_board");
  assert.equal(result.suggestedCategory, "动作技术");
  assert.deepEqual(result.themes, ["深蹲"]);
});

test("board aliases, priorities and explicit curated overrides are deterministic", () => {
  const config = { boards: [
    { id: "first-private-id", name: "随手收藏", category: "待阅读", category_priority: 1 },
    { id: "second-private-id", name: "训练计划", category_priority: 20 }
  ] };
  const note = { source_board_ids: ["first-private-id", "second-private-id"] };
  assert.deepEqual(sourceBoardNames(note, config), ["随手收藏", "训练计划"]);
  const boardFirst = resolveCategoryPolicy({
    entry: { category: "力量训练", themes: [] }, note, config,
    profile: { classification: { category_strategy: "source-board-first" }, fallback: {} }
  });
  assert.equal(boardFirst.category, "训练计划");
  const overridden = resolveCategoryPolicy({
    entry: { category: "康复", category_override: true, category_reason: "内容是伤后恢复方案", themes: [] }, note, config,
    profile: { classification: { category_strategy: "source-board-first" }, fallback: {} }, entryOrigin: "curation"
  });
  assert.equal(overridden.category, "康复");
  assert.equal(overridden.categorySource, "curation");
  assert.equal(overridden.categoryReason, "内容是伤后恢复方案");
});

test("source board labels remove Xiaohongshu's visible note-count suffix", () => {
  const config = { boards: [{ id: "private-id", name: "Skills 笔记・114", enabled: true }] };
  const note = { source_board_ids: ["private-id"], source_boards: ["Skills 笔记・114"] };

  assert.deepEqual(sourceBoardNames(note, config), ["Skills"]);
  assert.deepEqual(sourceBoardNames({ source_boards: ["Skills笔记·114"] }, config), ["Skills"]);
  const result = resolveCategoryPolicy({
    entry: { category: "Skills与工作流", themes: [] },
    note,
    config,
    profile: { classification: { category_strategy: "source-board-first" }, fallback: {} }
  });
  assert.equal(result.category, "Skills");
});

test("content-first remains an explicit domain option", () => {
  const result = resolveCategoryPolicy({
    entry: { category: "成分机制", themes: [] },
    note: { source_boards: ["护肤收藏"] },
    config: { boards: [{ name: "护肤收藏", enabled: true }] },
    profile: { classification: { category_strategy: "content-first" }, fallback: {} }
  });
  assert.equal(result.category, "成分机制");
  assert.equal(result.categorySource, "content_rule");
});

test("a curated category override requires an auditable reason", () => {
  assert.throws(() => resolveCategoryPolicy({
    entry: { category: "康复", category_override: true, themes: [] },
    note: { source_boards: ["训练计划"] },
    config: { boards: [{ name: "训练计划", enabled: true }] },
    profile: { classification: { category_strategy: "source-board-first" }, fallback: {} },
    entryOrigin: "curation"
  }), /category_reason is required/);
});

test("automatic content rules cannot override a source board", () => {
  const result = resolveCategoryPolicy({
    entry: { category: "动作技术", category_override: true, themes: ["一", "二", "三", "四"] },
    note: { source_boards: ["训练计划"] },
    config: { boards: [{ name: "训练计划", enabled: true }] },
    profile: { classification: { category_strategy: "source-board-first" }, fallback: {} },
    entryOrigin: "content_rule"
  });
  assert.equal(result.category, "训练计划");
  assert.deepEqual(result.themes, ["一", "二", "三"]);
});

test("content kind supports an explicit curated override", async () => {
  const builder = await read("skills/xhs-favorites-organizer/scripts/build-public-site.mjs");
  const judgement = await read("skills/xhs-favorites-organizer/scripts/public-judgement.mjs");
  const schema = await read("skills/xhs-favorites-organizer/references/organization-schema.md");
  assert.match(judgement, /if \(entry\.kind !== undefined\)/);
  assert.doesNotMatch(builder, /Invalid priority for|entry\.priority|priorityLabels/);
  assert.match(schema, /可选的内容形态人工覆盖值/);
  assert.match(schema, /当前 `domain_profile` 的 `content_kinds`/);
  assert.match(schema, /不要求用户为每篇笔记维护等级/);
});

test("uncurated software notes infer candidates while unverified Skill stays neutral", async () => {
  const work = await mkdtemp(resolve(root, ".fallback-kind-test-"));
  const configPath = resolve(work, "config.json");
  const catalogPath = resolve(work, "catalog.json");
  const curationPath = resolve(work, "curation.json");
  const outputPath = resolve(work, "knowledge.json");
  const cases = {
    "aaaaaaaaaaaaaaaaaaaaaaaa": ["三个 Codex 神级 Skill", "", "Skill"],
    "bbbbbbbbbbbbbbbbbbbbbbbb": ["4 步搭建自动化工作流教程", "", "Workflow"],
    "cccccccccccccccccccccccc": ["这款在线平台需要会员", "", "Product"],
    "dddddddddddddddddddddddd": ["GitHub 开源视频剪辑工具", "", "Tool"],
    "eeeeeeeeeeeeeeeeeeeeeeee": ["关于个人知识管理的几点思考", "", "Note"]
  };
  try {
    await Promise.all([
      writeFile(configPath, JSON.stringify({
        version: 1,
        domain_profile: "config/domain-profiles/software.json",
        curation_file: curationPath,
        public_stats: {},
        boards: [{ id: "ffffffffffffffffffffffff", name: "Fixture", enabled: true }]
      })),
      writeFile(catalogPath, JSON.stringify({ notes: Object.fromEntries(
        Object.entries(cases).map(([id, [title, description]]) => [id, { title, description }])
      ) })),
      writeFile(curationPath, "{}")
    ]);
    const result = spawnSync(process.execPath, [
      resolve(root, "skills/xhs-favorites-organizer/scripts/build-public-site.mjs"),
      "--config", configPath,
      "--catalog", catalogPath,
      "--curation", curationPath,
      "--profile", resolve(root, "config/domain-profiles/software.json"),
      "--video-analysis", resolve(work, "video-analysis"),
      "--output", outputPath
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const data = JSON.parse(await readFile(outputPath, "utf8"));
    const kinds = Object.fromEntries(data.notes.map((note) => [note.id, note.kind]));
    assert.deepEqual(kinds, {
      "aaaaaaaaaaaaaaaaaaaaaaaa": "Tool",
      ...Object.fromEntries(Object.entries(cases).slice(1).map(([id, values]) => [id, values[2]]))
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("uncurated domain content uses domain semantics instead of a Note status fallback", async () => {
  const software = await buildProfileFixture("software.json", { uncurated: true });
  const fitness = await buildProfileFixture("fitness.json", { uncurated: true });
  const skincare = await buildProfileFixture("skincare.json", { uncurated: true });
  assert.equal(software.notes[0].kind, "Note");
  assert.equal(fitness.notes[0].kind, "Claim");
  assert.equal(skincare.notes[0].kind, "Claim");
});

test("each domain exports only its own content-kind vocabulary", async () => {
  const expectations = {
    "software.json": ["Note", "Tool", "Skill", "Workflow", "Product"],
    "fitness.json": ["Note", "Movement", "Program", "Claim", "Product"],
    "skincare.json": ["Note", "Ingredient", "Routine", "Claim", "Product"]
  };
  for (const [profileFile, expectedKinds] of Object.entries(expectations)) {
    const data = await buildProfileFixture(profileFile);
    assert.deepEqual(Object.keys(data.meta.kindLabels), expectedKinds);
  }
  const app = await read("site/app.js");
  assert.match(app, /state\.data\.meta\.kindLabels/);
  assert.match(app, /new Set\(state\.data\.notes\.map\(\(note\) => note\.kind\)\)/);
});

test("resource index groups projects, websites, documentation and tutorials", async () => {
  const profile = JSON.parse(await read("config/domain-profiles/software.json"));
  const index = profile.resource_index;
  assert.equal(resourceGroup({ name: "Palmier Pro", type: "AI 视频编辑" }, index), "开源项目");
  assert.equal(resourceGroup({ name: "Crawl4AI 官网", type: "官方网站" }, index), "官方网站");
  assert.equal(resourceGroup({ name: "AiWind", type: "提示词与案例网站" }, index), "官方网站");
  assert.equal(resourceGroup({ name: "Crawl4AI Docs", type: "官方文档" }, index), "官方文档");
  assert.equal(resourceGroup({ name: "Quick Start", type: "教程" }, index), "教程");
});

test("domain profile without an explicit valid default fails instead of falling back to Note", async () => {
  const work = await mkdtemp(resolve(root, ".invalid-kind-profile-test-"));
  const configPath = resolve(work, "config.json");
  const catalogPath = resolve(work, "catalog.json");
  const curationPath = resolve(work, "curation.json");
  const profilePath = resolve(work, "profile.json");
  const outputPath = resolve(work, "knowledge.json");
  const baseProfile = JSON.parse(await read("config/domain-profiles/software.json"));
  try {
    await Promise.all([
      writeFile(configPath, JSON.stringify({ version: 1, boards: [] })),
      writeFile(catalogPath, JSON.stringify({ notes: {} })),
      writeFile(curationPath, "{}")
    ]);
    for (const invalidDefault of [undefined, "MissingKind"]) {
      const profile = structuredClone(baseProfile);
      if (invalidDefault === undefined) delete profile.classification.default;
      else profile.classification.default = invalidDefault;
      await writeFile(profilePath, JSON.stringify(profile));
      const result = spawnSync(process.execPath, [
        resolve(root, "skills/xhs-favorites-organizer/scripts/build-public-site.mjs"),
        "--config", configPath,
        "--catalog", catalogPath,
        "--curation", curationPath,
        "--profile", profilePath,
        "--video-analysis", resolve(work, "video-analysis"),
        "--resources", resolve(root, "skills/xhs-favorites-organizer/references/software-resources.json"),
        "--output", outputPath
      ], { cwd: root, encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(`${result.stderr}${result.stdout}`, /classification\.default|required|not declared/);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("resource index follows configured sorts and leaves missing metrics last", async () => {
  const profile = JSON.parse(await read("config/domain-profiles/software.json"));
  const resources = [
    { name: "Beta", metricNumeric: 20 },
    { name: "Alpha", metricNumeric: 10 },
    { name: "Unknown", metricNumeric: null }
  ];
  assert.deepEqual(sortResources(resources, "metric-desc", profile.resource_index).map((item) => item.name), ["Beta", "Alpha", "Unknown"]);
  assert.deepEqual(sortResources(resources, "metric-asc", profile.resource_index).map((item) => item.name), ["Alpha", "Beta", "Unknown"]);
  assert.deepEqual(sortResources(resources, "name-asc", profile.resource_index).map((item) => item.name), ["Alpha", "Beta", "Unknown"]);
  assert.deepEqual(sortResources(resources, "name-desc", profile.resource_index).map((item) => item.name), ["Unknown", "Beta", "Alpha"]);
});

test("resource sort options follow the selected resource type", async () => {
  const profile = JSON.parse(await read("config/domain-profiles/software.json"));
  const index = profile.resource_index;
  assert.deepEqual(resourceSortsForGroup(index, "all").map((sort) => sort.id), ["name-asc", "name-desc"]);
  assert.deepEqual(resourceSortsForGroup(index, "开源项目").map((sort) => sort.id), ["metric-desc", "metric-asc", "name-asc", "name-desc"]);
  assert.deepEqual(resourceSortsForGroup(index, "GitHub 项目").map((sort) => sort.id), ["metric-desc", "metric-asc", "name-asc", "name-desc"]);
  assert.deepEqual(resourceSortsForGroup(index, "官方文档").map((sort) => sort.id), ["name-asc", "name-desc"]);
});

test("personal curation stays note-scoped and links bookmarked resources", () => {
  const ids = new Set(["note-a", "note-b"]);
  const normalized = normalizePersonalData({
    bookmarks: ["note-a", "unknown", "note-a"],
    descriptionOverrides: {
      "note-a": { description: "  我的修订  ", updatedAt: "2026-07-29T00:00:00.000Z" },
      unknown: { description: "不应保留" }
    }
  }, ids);
  assert.deepEqual(normalized.bookmarks, ["note-a"]);
  assert.equal(normalized.descriptionOverrides["note-a"].description, "我的修订");
  assert.equal(normalized.descriptionOverrides.unknown, undefined);

  const resources = relatedResourceNames([
    { id: "note-a", resources: ["Tool A", "Guide B"] },
    { id: "note-b", resources: ["Tool C"] }
  ], new Set(normalized.bookmarks));
  assert.deepEqual([...resources], ["Tool A", "Guide B"]);
});

test("personal curation migrates old bookmarks and merges portable backups", () => {
  const memory = new Map([["xhs-kb-saved", JSON.stringify(["note-a"])]]);
  const storage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key)
  };
  const loaded = loadPersonalData(storage, new Set(["note-a", "note-b"]));
  assert.deepEqual(loaded.bookmarks, ["note-a"]);
  assert.equal(memory.has("xhs-kb-saved"), false);

  const merged = mergePersonalData(loaded, {
    bookmarks: ["note-b"],
    descriptionOverrides: { "note-b": { description: "跨设备修订" } }
  }, new Set(["note-a", "note-b"]));
  assert.deepEqual(merged.bookmarks, ["note-a", "note-b"]);
  assert.match(serializePersonalData(merged, new Set(["note-a", "note-b"])), /"version": 2/);
});

test("personal curation resolves stale cross-device edits and deletions", () => {
  const ids = new Set(["note-a"]);
  const remote = {
    bookmarkStates: { "note-a": { bookmarked: false, updatedAt: "2026-07-29T02:00:00.000Z" } },
    descriptionOverrides: { "note-a": { description: "", deleted: true, updatedAt: "2026-07-29T02:00:00.000Z" } }
  };
  const staleLocal = {
    bookmarkStates: { "note-a": { bookmarked: true, updatedAt: "2026-07-29T01:00:00.000Z" } },
    descriptionOverrides: { "note-a": { description: "旧修订", updatedAt: "2026-07-29T01:00:00.000Z" } }
  };
  const merged = mergePersonalData(remote, staleLocal, ids);
  assert.deepEqual(merged.bookmarks, []);
  assert.equal(merged.bookmarkStates["note-a"].bookmarked, false);
  assert.equal(merged.descriptionOverrides["note-a"].deleted, true);
  assert.equal(merged.descriptionOverrides["note-a"].description, "");
});

test("personal sync merges the latest remote snapshot before a second client writes", () => {
  const ids = new Set(["note-a", "note-b"]);
  const clientA = normalizePersonalData({
    bookmarkStates: { "note-a": { bookmarked: true, updatedAt: "2026-07-29T01:00:00.000Z" } }
  }, ids);
  const clientB = normalizePersonalData({
    bookmarkStates: { "note-b": { bookmarked: true, updatedAt: "2026-07-29T01:00:01.000Z" } }
  }, ids);
  const afterA = mergePersonalData({}, clientA, ids);
  const afterB = mergePersonalData(afterA, clientB, ids);
  assert.deepEqual(new Set(afterB.bookmarks), new Set(["note-a", "note-b"]));
});

test("Hugging Face personal sync fails closed when the Dataset is public", () => {
  assert.equal(assertPrivateDataset({ private: true, sha: "a".repeat(40) }).private, true);
  assert.throws(() => assertPrivateDataset({ private: false, sha: "a".repeat(40) }), /sync was stopped/);
  assert.throws(() => assertPrivateDataset({ private: true }), /no verifiable revision/);
  assert.throws(() => assertPrivateDataset(null), /sync was stopped/);
  assert.equal(repositoryIsMissing(new Error("404 repository not found")), true);
  assert.equal(repositoryIsMissing(new Error("network timeout")), false);
  assert.equal(repositoryWriteConflict(new Error("409 Conflict: parent commit changed")), true);
  assert.equal(repositoryWriteConflict(new Error("network timeout")), false);
});

test("resource index validation rejects broken type-sort contracts", () => {
  assert.throws(
    () => validateResourceIndex({ default_group: {}, groups: [], sorts: [{ id: "name", label: "名称", field: "name", type: "text", direction: "asc" }] }),
    /default_group/i,
  );
  assert.throws(
    () => validateResourceIndex({ groups: [null], sorts: [{ id: "name", label: "名称", field: "name", type: "text", direction: "asc" }] }),
    /group/i,
  );
  assert.throws(
    () => validateResourceIndex({ groups: [], sorts: [{ id: "name", label: "名称", field: "name", type: "boolean", direction: "sideways" }] }),
    /unsupported/i,
  );
  assert.throws(
    () => validateResourceIndex({ groups: [], default_group: "其他", sorts: [{ id: "metric", label: "指标", field: "metricNumeric", type: "number", direction: "desc", applies_to: ["拼错的类型"] }] }),
    /unknown resource type/
  );
  assert.throws(
    () => validateResourceIndex({ groups: [], default_group: "其他", sorts: [{ id: "metric", label: "指标", field: "metricNumeric", type: "number", direction: "desc", applies_to: ["其他"] }] }),
    /at least one global sort/
  );
  assert.throws(
    () => validateResourceIndex({ groups: [], default_group: "其他", sorts: [{ id: "metric", label: "指标", field: "metricNumeric", type: "number", direction: "desc", applies_to: "其他" }] }),
    /must be an array/
  );
  assert.throws(
    () => validateResourceIndex({
      groups: [],
      fields_by_type: "Agent Skill",
      sorts: [{ id: "name", label: "名称", field: "name", type: "text", direction: "asc" }]
    }),
    /fields_by_type must be an object/
  );
  assert.throws(
    () => validateResourceIndex({
      groups: [],
      fields_by_type: { "Agent Skill": [{}] },
      sorts: [{ id: "name", label: "名称", field: "name", type: "text", direction: "asc" }]
    }),
    /field and label/
  );
});

test("software, fitness and skincare profiles expose a complete resource-index contract", async () => {
  for (const file of ["software.json", "fitness.json", "skincare.json"]) {
    const profile = JSON.parse(await read(`config/domain-profiles/${file}`));
    assert.equal(profile.version, 1);
    assert.ok(profile.id);
    assert.ok(profile.presentation?.hero?.from);
    assert.ok(profile.presentation?.hero?.to);
    assert.equal(Object.hasOwn(profile, "priorities"), false);
    assert.ok(Object.hasOwn(profile.content_kinds, profile.classification.default));
    for (const rule of profile.classification.rules) {
      assert.ok(Object.hasOwn(profile.content_kinds, rule.kind));
      assert.doesNotThrow(() => new RegExp(rule.pattern, "i"));
    }
    if (profile.fallback?.default_kind) {
      assert.ok(Object.hasOwn(profile.content_kinds, profile.fallback.default_kind));
    }
    for (const rule of profile.fallback?.kind_rules || []) {
      assert.ok(Object.hasOwn(profile.content_kinds, rule.kind));
      assert.doesNotThrow(() => new RegExp(rule.pattern, "i"));
    }
    const index = profile.resource_index;
    assert.doesNotThrow(() => validateResourceIndex(index));
    assert.equal(profile.features.resource_index, true);
    assert.ok(index.label && index.entity_label && index.registry_file);
    assert.ok(index.mapping.name && index.mapping.type && index.mapping.description);
    assert.ok(Array.isArray(index.fields));
    assert.ok(index.groups.length > 0 && index.sorts.length > 0 && index.actions.length > 0);
    for (const group of index.groups) assert.doesNotThrow(() => new RegExp(group.pattern, "i"));
    for (const sort of index.sorts) {
      assert.match(sort.field, /^(name|metricNumeric)$/);
      assert.match(sort.type, /^(text|number)$/);
      assert.match(sort.direction, /^(asc|desc)$/);
      for (const group of sort.applies_to || []) {
        assert.ok(
          group === index.default_group || index.groups.some((candidate) => candidate.label === group),
          `Unknown sort group ${group} in ${file}`
        );
      }
    }
    const registry = JSON.parse(await read(index.registry_file));
    const resources = registry[index.collection];
    assert.ok(Array.isArray(resources) && resources.length > 0);
    for (const resource of resources) {
      assert.ok(resource[index.mapping.name]);
      assert.ok(resource[index.mapping.type]);
      assert.ok(resource[index.mapping.description]);
      for (const field of index.fields) assert.ok(resource[field.field]);
      const availableActions = index.actions.filter((action) => resource[action.field]);
      assert.ok(availableActions.length > 0);
      for (const action of availableActions) assert.match(resource[action.field], /^https:\/\//);
    }
  }
});

test("video evidence statistics are derived from local evidence files", async () => {
  const work = await mkdtemp(resolve(root, ".evidence-stats-test-"));
  const noteA = resolve(work, "aaaaaaaaaaaaaaaaaaaaaaaa");
  const noteB = resolve(work, "bbbbbbbbbbbbbbbbbbbbbbbb");
  const ignored = resolve(work, "not-a-note");
  try {
    await Promise.all([mkdir(resolve(noteA, "frames"), { recursive: true }), mkdir(noteB), mkdir(ignored)]);
    await Promise.all([
      writeFile(resolve(noteA, "analysis.json"), JSON.stringify({ status: "complete" })),
      writeFile(resolve(noteA, "overview.jpg"), "a"),
      writeFile(resolve(noteA, "frames", "0001.jpg"), "a"),
      writeFile(resolve(noteB, "0001.png"), "a"),
      writeFile(resolve(ignored, "analysis.json"), JSON.stringify({ status: "complete" })),
      writeFile(resolve(ignored, "0001.jpg"), "a")
    ]);
    const stats = await collectVideoEvidenceStats(work, {}, ["aaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbb"]);
    assert.equal(stats.frameEvidenceCount, 2);
    assert.deepEqual(stats.verifiedNoteIds, ["aaaaaaaaaaaaaaaaaaaaaaaa"]);
    assert.equal(stats.derivedFromLocalEvidence, true);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("all domain profiles compile through the same public builder", async () => {
  const expectations = [
    ["software.json", "software", "资源索引", null, []],
    ["fitness.json", "fitness", "训练资料库", 3, ["目标", "适用", "注意"]],
    ["skincare.json", "skincare", "成分资料库", 3, ["适用", "耐受", "边界"]]
  ];
  for (const [file, id, label, count, fields] of expectations) {
    const data = await buildProfileFixture(file);
    assert.equal(data.meta.profileId, id);
    assert.equal(data.meta.resourceIndex.label, label);
    if (count === null) {
      assert.ok(data.resources.length >= 30);
      assert.equal(data.meta.resourceCount, data.resources.length);
    } else {
      assert.equal(data.resources.length, count);
    }
    assert.deepEqual((data.resources[0].attributes || []).map((attribute) => attribute.label), fields);
  }
});

test("builder preserves missing numeric metrics as null", async () => {
  const work = await mkdtemp(resolve(root, ".resource-metric-test-"));
  const registry = resolve(work, "registry.json");
  await writeFile(registry, JSON.stringify({ verified_at: "2026-07-28", resources: [
    { name: "Null", aliases: [], type: "Tool", usage_note: "Missing", stars: "", stars_numeric: null, repo: "https://github.com/example/null", download: "https://github.com/example/null/archive/refs/heads/main.zip" },
    { name: "Empty", aliases: [], type: "Tool", usage_note: "Missing", stars: "", stars_numeric: "", repo: "https://github.com/example/empty", download: "https://github.com/example/empty/archive/refs/heads/main.zip" },
    { name: "Absent", aliases: [], type: "Tool", usage_note: "Missing", stars: "", repo: "https://github.com/example/absent", download: "https://github.com/example/absent/archive/refs/heads/main.zip" }
  ] }));
  try {
    const data = await buildProfileFixture("software.json", { resources: registry });
    assert.deepEqual(data.resources.map((resource) => resource.metricNumeric), [null, null, null]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("skincare sunscreen resource points to a sunscreen-specific guide", async () => {
  const registry = JSON.parse(await read("config/resource-registries/skincare.example.json"));
  const sunscreen = registry.resources.find((resource) => resource.name === "防晒基础");
  assert.ok(sunscreen);
  assert.match(sunscreen.guide, /aad\.org\/public\/everyday-care\/sun-protection\//);
  assert.doesNotMatch(sunscreen.guide, /retinoid|retinol/);
});

test("public payload excludes private account state", async () => {
  const payload = await read("site/data/knowledge.json");
  for (const forbidden of [
    /xsec_token/i,
    /\/user\/profile\//i,
    /author_id/i,
    /ChromeUserData/i,
    /AppData\\Local/i
  ]) {
    assert.doesNotMatch(payload, forbidden);
  }
});

test("public payload never includes raw comment evidence", async () => {
  const secretComment = "private-comment-evidence-must-stay-local";
  const data = await buildProfileFixture("software.json", {
    uncurated: true,
    note: {
      title: "Fixture",
      description: "Public description",
      source_boards: ["Fixture"],
      comment_evidence: [{ text: secretComment, reply: false, liked_count: "9" }]
    }
  });
  assert.doesNotMatch(JSON.stringify(data), new RegExp(secretComment));
});

test("software resource registry mixes repositories, websites, docs and tutorials", async () => {
  const data = JSON.parse(await read("site/data/knowledge.json"));
  const urls = [];
  for (const resource of data.resources) {
    assert.ok(resource.name && resource.type && resource.description);
    assert.ok(Array.isArray(resource.actions) && resource.actions.length > 0);
    for (const action of resource.actions) {
      assert.match(action.url, /^https:\/\//);
      urls.push(action.url);
    }
    assert.equal(Object.hasOwn(resource, "status"), false);
  }
  assert.ok(urls.some((url) => url.startsWith("https://github.com/")));
  assert.ok(urls.some((url) => url.startsWith("https://docs.")));
  assert.ok(data.resources.some((resource) => resource.type === "官方网站"));
  assert.ok(data.resources.some((resource) => resource.type === "教程"));
});

test("VividDub keeps its verified GitHub project identity", async () => {
  const registry = JSON.parse(await read("skills/xhs-favorites-organizer/references/software-resources.json"));
  const vividdub = registry.resources.find((resource) => resource.name === "VividDub");
  assert.ok(vividdub);
  assert.equal(vividdub.type, "GitHub 产品项目");
  assert.equal(vividdub.repo, "https://github.com/VividDub/VividDub");
  assert.equal(vividdub.stars_numeric, 30);
  assert.doesNotMatch(vividdub.usage_note, /没有 GitHub|不是已确认的 GitHub/);
});

test("no card in the shipped data is left without a way to read it", async () => {
  const data = JSON.parse(await read("site/data/knowledge.json"));
  // A saved reply that lost text is shown only when nothing else exists, so no card is empty and no cut reply passes as complete.
  assert.deepEqual(data.notes.filter((note) => !note.mainText.trim()).map((note) => note.id), []);
  for (const note of data.notes.filter((item) => item.replyDamaged)) {
    assert.ok(note.mainSource !== "diandian" || note.mainText.trim(), note.id);
  }
  assert.equal(data.notes.filter((note) => note.postUnreachable).length, 3);
});

test("static app has the required deployment assets", async () => {
  const [html, css, js, personalStore, hfPersonalSync, hfSyncGuard, siteConfig, readme, publishingGuide, archivedCss, archiveReadme, windowsLauncher, browserWaiter] = await Promise.all([
    read("site/index.html"),
    read("site/styles.css"),
    read("site/app.js"),
    read("site/personal-store.mjs"),
    read("site/hf-personal-sync.mjs"),
    read("site/hf-sync-guard.mjs"),
    read("site/site-config.js"),
    read("README.md"),
    read("docs/PUBLISHING.md"),
    read("site/themes/archive/research-blue-v1/styles.css"),
    read("site/themes/archive/research-blue-v1/README.md"),
    read("Start-FavSense.cmd"),
    read("scripts/open-favsense-when-ready.ps1")
  ]);
  const [windowsEntrypoint, setupEntrypoint] = await Promise.all([
    readFile(resolve(root, "favsense.ps1")),
    readFile(resolve(root, "skills/xhs-favorites-organizer/scripts/setup-autosync.ps1"))
  ]);
  const windowsEntrypointText = windowsEntrypoint.toString("utf8");
  assert.match(html, /id="notes-grid"/);
  assert.match(html, /id="resources-grid"/);
  assert.match(html, /id="resource-type-filter"/);
  assert.match(html, /id="resource-sort"/);
  assert.match(html, /id="resource-result-count"/);
  assert.match(html, /id="bookmark-filter"/);
  assert.doesNotMatch(html, /open-source-note|私人数据默认不公开/);
  assert.match(html, /id="resource-bookmark-filter"/);
  assert.match(html, /id="personal-data-export"/);
  assert.match(html, /id="personal-data-import"/);
  assert.doesNotMatch(html, /owner\/repo|Star、许可证|从官方仓库确认/);
  assert.match(html, />同步设置</);
  assert.doesNotMatch(html, /id="clear-filters"/);
  assert.match(html, /<kbd[^>]*>按 \/ 搜索<\/kbd>/);
  assert.doesNotMatch(html, /项目雷达|资源雷达|同步与方法/);
  assert.doesNotMatch(html, /项目、风险与下一步|视频核验后的判断|证据方法|TRY →/);
  // Issue 99: the card no longer shows a next-step box, so nothing in the page reads the curated action to draw one.
  assert.doesNotMatch(js, /action-box|具体用法/);
  assert.match(html, /id="board-manager"/);
  assert.match(html, /id="board-list"/);
  assert.match(html, /id="board-enabled-count"/);
  assert.match(html, /id="manual-sync-control"[^>]*hidden/);
  assert.match(html, /id="manual-sync-start"[^>]*>开始整理</);
  assert.match(html, />\s*一键整理</);
  assert.match(html, /刷新收藏夹、同步正文与可用评论线索、增量去重，并更新公开网页/);
  // The web data is the only formal output: no sentence may speak of a second, knowledge base output.
  assert.doesNotMatch(html, /知识库与(?:公开)?网页|网页与知识库|Obsidian/);
  assert.doesNotMatch(html, /选择每天整理|自动进入每日同步/);
  assert.match(html, /id="creator-space-link"/);
  assert.doesNotMatch(html, /id="hero-dismiss"|id="hero-restore"/);
  assert.match(html, /theme-icon--sun/);
  assert.match(html, /theme-icon--moon/);
  assert.match(html, /FavSense · 拾光台/);
  assert.match(windowsLauncher, /favsense\.ps1" preview/);
  assert.match(windowsLauncher, /open-favsense-when-ready\.ps1/);
  assert.doesNotMatch(windowsLauncher, /schtasks|Register-ScheduledTask|Startup/);
  assert.match(browserWaiter, /http:\/\/127\.0\.0\.1:8766\//);
  assert.match(browserWaiter, /Start-Process \$url/);
  assert.deepEqual([...windowsEntrypoint.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.deepEqual([...setupEntrypoint.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(windowsEntrypointText, /site-preview\.json/);
  assert.match(windowsEntrypointText, /Stop-LegacySitePreview/);
  assert.match(windowsEntrypointText, /started_at_ticks/);
  assert.match(windowsEntrypointText, /Local\\FavSensePreview/);
  assert.match(windowsEntrypointText, /System\.Diagnostics\.ProcessStartInfo/);
  assert.doesNotMatch(windowsEntrypointText, /Start-Process -FilePath 'node\.exe'/);
  assert.match(html, /name="keywords"[^>]*Xiaohongshu[^>]*RedNote/);
  assert.doesNotMatch(html, /name="keywords"[^>]*Obsidian/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /\.filter-sidebar \{[^}]*position:\s*static[^}]*height:\s*auto[^}]*overflow-y:\s*visible/);
  assert.doesNotMatch(css, /\.filter-sidebar \{[^}]*overflow-y:\s*auto/);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /--brand-red:\s*#ff2442/);
  assert.match(css, /--cobalt:\s*#5b7cfa/);
  assert.match(js, /categoryAccents = new Map/);
  assert.match(js, /resourceGroup, resourceSortsForGroup, sortResources/);
  assert.match(js, /renderResourceSortOptions/);
  assert.match(js, /data-bookmark-note/);
  assert.match(js, /data-description-form/);
  assert.match(js, /note\.suggestedCategory && note\.suggestedCategory !== note\.category/);
  // Search covers what the card shows: the main text and any extracted text, not a status or a curated summary.
  assert.match(js, /note\.category, note\.suggestedCategory, noteDescription\(note\), note\.extracted\?\.text \?\? ""/);
  assert.match(html, /id="hero-counts"/);
  assert.match(html, /id="proof-replies"[^>]*>[^<]*<\/strong><span>条有完整点点总结</);
  assert.match(html, /id="proof-transcripts"[^>]*>[^<]*<\/strong><span>条有视频转写</);
  assert.doesNotMatch(html, /proof-videos|条完成深度解读/);
  assert.doesNotMatch(js, /deepSummary|curationStatus|summaryState|verifiedNoteCount|noteOrganizationStatus|pending-evidence/);
  assert.match(js, /fetch\(DATA_URL, \{ cache: "no-cache" \}\)/);
  assert.doesNotMatch(css, /pending-evidence/);
  assert.match(css, /\.category-suggestion/);
  assert.match(js, /relatedResourceNames/);
  assert.match(personalStore, /favsense-personal-v1/);
  assert.match(personalStore, /MAX_DESCRIPTION_LENGTH = 4000/);
  assert.match(hfPersonalSync, /@huggingface\/hub@2\.14\.2/);
  assert.match(hfPersonalSync, /type: "dataset"/);
  assert.match(hfPersonalSync, /private: true/);
  assert.match(hfPersonalSync, /datasetInfo/);
  assert.match(hfPersonalSync, /additionalFields: \["sha"\]/);
  assert.match(hfPersonalSync, /assertPrivateDataset/);
  assert.match(hfPersonalSync, /parentCommit: info\.sha,/);
  assert.doesNotMatch(hfPersonalSync, /parentCommit: info\.sha \|\| undefined/);
  assert.match(hfPersonalSync, /repositoryWriteConflict/);
  assert.match(hfSyncGuard, /info\?\.private !== true/);
  assert.match(readme, /hf_oauth_scopes:\s*\n\s+- contribute-repos/);
  assert.match(html, /统计随每次同步与站点构建自动更新/);
  assert.match(js, /\.\/\.local\/bridge\.json/);
  assert.match(js, /X-XHS-Bridge-Token/);
  assert.match(js, /localBridgeRequest\("\/boards"/);
  assert.match(js, /localBridgeRequest\("\/sync\/start"/);
  assert.match(js, /localBridgeRequest\("\/sync\/status"/);
  assert.match(js, /status\.publish_status === "published"/);
  assert.match(js, /manualSyncStartedHere/);
  assert.match(js, /creatorGitHubUrl/);
  assert.match(js, /FAVSENSE_CONFIG/);
  assert.match(js, /CREATOR_GITHUB_URL/);
  assert.match(css, /\.creator-space-link/);
  assert.doesNotMatch(css, /\.tech-watermark/);
  assert.match(js, /view === "notes" \? elements\.hero/);
  assert.doesNotMatch(js, /heroCollapsed|favsense-hero-collapsed/);
  assert.match(js, /state\.resourceType === "all"/);
  assert.match(js, /class="card-kind">\$\{escapeHtml\(note\.category\)\} · \$\{escapeHtml\(note\.kind\)\}/);
  assert.doesNotMatch(js, /class="card-category"/);
  assert.doesNotMatch(js, /FRAME \$\{String\(note\.number\)/);
  assert.match(js, /"信息采集与搜索", "#3569e8"/);
  assert.match(js, /"本地模型与成本", "#007c91"/);
  assert.match(js, /"内容增长与商业", "#d14b31"/);
  assert.match(js, /"知识管理与记忆", "#16803c"/);
  assert.match(css, /border-top:\s*4px solid var\(--accent\)/);
  assert.match(css, /\.card-title::after/);
  assert.match(css, /\.detail-dialog\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/s);
  assert.match(css, /\.dialog-shell\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(css, /@supports \(-moz-appearance:\s*none\)\s*\{[\s\S]*?\.detail-dialog\s*\{[^}]*scrollbar-color:[^;}]+;[^}]*scrollbar-width:\s*thin;/s);
  assert.match(css, /\.detail-dialog::-webkit-scrollbar\s*\{[^}]*width:\s*10px;/s);
  assert.match(css, /\.detail-dialog::-webkit-scrollbar-button\s*\{[^}]*display:\s*none;/s);
  assert.match(css, /\.detail-dialog::-webkit-scrollbar-thumb:hover\s*\{[^}]*var\(--accent/);
  assert.match(css, /html\.dialog-scroll-lock,\s*body\.dialog-scroll-lock\s*\{[^}]*overflow:\s*hidden;[^}]*overscroll-behavior:\s*none;/s);
  assert.match(css, /body\.dialog-scroll-lock\s*\{[^}]*position:\s*fixed;[^}]*width:\s*100%;/s);
  assert.match(css, /\.dialog-close\s*\{[^}]*position:\s*sticky;[^}]*z-index:\s*2;[^}]*top:\s*0;/s);
  assert.match(js, /function lockDialogBackground\(\)[\s\S]*document\.body\.style\.top = `-\$\{scrollY\}px`;/);
  assert.match(js, /function unlockDialogBackground\(\)[\s\S]*window\.scrollTo\(\{ left:\s*0, top:\s*scrollY, behavior:\s*"instant" \}\);/);
  // Issue 99 (approved design): the title is smaller and no longer held to a narrow column, so it fits on one line where it can.
  assert.match(css, /\.detail-title\s*\{[^}]*max-width:\s*none;[^}]*font-size:\s*clamp\(26px,\s*2\.5vw,\s*33px\);[^}]*line-height:\s*1\.12;[^}]*text-wrap:\s*pretty;/s);
  assert.match(html, /<dialog[^>]*id="detail-dialog"[^>]*aria-labelledby="detail-title"/);
  assert.match(js, /<h2 class="detail-title" id="detail-title">/);
  assert.doesNotMatch(html, /priority-filter|data-priority|保存到本机/);
  assert.doesNotMatch(js, /priorityFilter|xhs-kb-saved|toggleSaved|保存到本机|project-status/);
  assert.doesNotMatch(`${html}\n${css}\n${js}`, /themes\/archive|#3158e8|#e2ddff|#28a783/i);
  assert.match(archivedCss, /#3158e8/i);
  assert.match(archiveReadme, /当前网页不会导入或链接本目录/);
  assert.match(js, /escapeHtml/);
  assert.match(readme, /sdk: static/);
  assert.match(readme, /app_file: site\/index\.html/);
  const frontMatter = readme.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(frontMatter, "README must begin with Hugging Face YAML front matter");
  assert.deepEqual(
    frontMatter[1].split(/\r?\n/).filter((line) => /^header:\s*/.test(line)),
    ["header: mini"]
  );
  assert.match(siteConfig, /huggingFaceHeader:\s*"mini"/);
  assert.match(js, /configureHostLayout/);
  assert.match(js, /hasHuggingFaceMiniHeader/);
  assert.match(js, /dataset\.hfHeader/);
  assert.match(css, /--hf-mini-controls-top:\s*72px/);
  assert.match(css, /html\[data-hf-header="mini"\]\s+\.header-actions/);
  assert.match(css, /top:\s*var\(--hf-mini-controls-top\)/);
  assert.doesNotMatch(css, /--hf-mini-site-header-height|html\[data-hf-header="mini"\]\s+\.site-header\s*\{/);
  assert.doesNotMatch(css, /--hf-mini-header-right-clearance|right:\s*var\(--hf-mini-header-right-clearance\)/);
  assert.doesNotMatch(css, /--hf-mini-header-clearance|margin-top:\s*var\(--hf/);
  assert.match(css, /\.skip-link\s*\{[\s\S]*?top:\s*0;[\s\S]*?transform:\s*translateY\(-100%\)/);
  assert.match(css, /\.skip-link:focus\s*\{[\s\S]*?top:\s*12px/);
  assert.match(publishingGuide, /`header: mini`/);
  assert.match(publishingGuide, /浮动放在 mini header 下方/);
  assert.match(publishingGuide, /不增加 FavSense 头部高度/);
  assert.match(publishingGuide, /Space 根目录 README 前置配置中的 `header` 规范为 `mini`/);
});

test("Hugging Face mini header avoidance only activates for an embedded mini Space", () => {
  assert.equal(hasHuggingFaceMiniHeader({
    framed: true,
    referrer: "https://huggingface.co/",
    creatorUserId: "6a589b8bfe3a3b00f834c4c3",
    configuredHeader: "mini",
  }), true);
  assert.equal(hasHuggingFaceMiniHeader({
    framed: false,
    referrer: "https://huggingface.co/",
    creatorUserId: "6a589b8bfe3a3b00f834c4c3",
    configuredHeader: "mini",
  }), false);
  assert.equal(hasHuggingFaceMiniHeader({
    framed: true,
    referrer: "https://huggingface.co/",
    creatorUserId: "6a589b8bfe3a3b00f834c4c3",
    configuredHeader: "default",
  }), false);
  assert.equal(hasHuggingFaceMiniHeader({
    framed: true,
    referrer: "https://example.com/",
    creatorUserId: "6a589b8bfe3a3b00f834c4c3",
    configuredHeader: "mini",
  }), false);
  assert.equal(hasHuggingFaceMiniHeader({
    framed: true,
    referrer: "https://huggingface.co/",
    creatorUserId: "invalid",
    configuredHeader: "mini",
  }), false);
});

test("Hugging Face controls return to the site header when the host expands", () => {
  const initial = resolveHuggingFaceHeaderLayout({
    capable: true,
    outerHeight: 1187,
    innerHeight: 1100,
    baselineGap: null,
  });
  assert.deepEqual(initial, { mode: "mini", baselineGap: 87 });

  const expanded = resolveHuggingFaceHeaderLayout({
    capable: true,
    outerHeight: 1187,
    innerHeight: 1050,
    baselineGap: initial.baselineGap,
  });
  assert.deepEqual(expanded, { mode: "default", baselineGap: 87 });

  const restored = resolveHuggingFaceHeaderLayout({
    capable: true,
    outerHeight: 1187,
    innerHeight: 1100,
    baselineGap: expanded.baselineGap,
  });
  assert.deepEqual(restored, { mode: "mini", baselineGap: 87 });

  assert.deepEqual(resolveHuggingFaceHeaderLayout({
    capable: false,
    outerHeight: 1187,
    innerHeight: 1050,
    baselineGap: 87,
  }), { mode: "default", baselineGap: null });
});

test("local pending note status exposes only a strict loopback-safe review projection", () => {
  const status = validateLocalNoteOrganizationStatus({
    ok: true,
    schema_version: 2,
    note_id: "note-pending",
    status: "pending_review",
    reason_code: "audit_pending",
    display_summary: "Captured private synthetic summary",
    evidence_methods: [{ method: "point", provider: "xiaohongshu-diandian", version: "2", result_sha256: "a".repeat(64) }],
    blockers: ["audit_pending"]
  }, ORGANIZATION_STATUS_CONTRACT);
  assert.equal(status.display_summary, "Captured private synthetic summary");
  assert.deepEqual(status.blockers, ["audit_pending"]);
  for (const malformed of [
    { ...status, source_url: "https://example.invalid/private" },
    { ...status, note_id: "../private" },
    { ...status, status: "accepted" },
    { ...status, display_summary: "cookie=private-value" },
    { ...status, blockers: ["not-in-contract"] }
  ]) assert.throws(() => validateLocalNoteOrganizationStatus(malformed, ORGANIZATION_STATUS_CONTRACT));
});

test("local board manager accepts only protocol 11 with a redacted SOP browser session", () => {
  const valid = validateLocalBridgeConfig({
    baseUrl: "http://127.0.0.1:47631"
  });
  assert.equal(valid.baseUrl, "http://127.0.0.1:47631");
  for (const config of [
    { baseUrl: "https://127.0.0.1:47631" },
    { baseUrl: "http://example.com:47631" },
    { baseUrl: "http://localhost:47631" },
    { baseUrl: "http://127.0.0.1" },
    { baseUrl: "http://127.0.0.1:47631/private" }
  ]) assert.throws(() => validateLocalBridgeConfig(config));
  assert.deepEqual(validateLocalBridgeSession({
    ok: true,
    protocol_version: 11,
    token: "a".repeat(64),
    diandian_available: true,
    browser_session: { owner: "sop-cdp", ready: false }
  }), {
    token: "a".repeat(64),
    browserSession: { owner: "sop-cdp", ready: false }
  });
  assert.throws(() => validateLocalBridgeSession({
    ok: true,
    protocol_version: 10,
    token: "a".repeat(64),
    browser_session: { owner: "sop-cdp", ready: true }
  }));
  for (const browserSession of [
    null,
    { owner: "favsense-private", ready: true },
    { owner: "sop-cdp", ready: "yes" },
    { owner: "sop-cdp", ready: true, port: 9224 },
    { owner: "sop-cdp", ready: true, path: "private" },
    { owner: "sop-cdp", ready: true, browser_channel_id: "b".repeat(64) }
  ]) assert.throws(() => validateLocalBridgeSession({
    ok: true,
    protocol_version: 11,
    token: "a".repeat(64),
    browser_session: browserSession
  }));

  const boards = validateLocalBridgeBoards([{
    id: "board1",
    name: "  Skills  ",
    enabled: true,
    available: true,
    advertised_count: 12,
    captured_count: 7,
  }]);
  assert.equal(boards[0].name, "Skills");
  for (const malicious of [
    [{
      id: "board1", name: "Skills", enabled: true, available: true,
      advertised_count: 12, captured_count: '<img src=x onerror="globalThis.pwned=1">',
    }],
    [{
      id: "board1", name: "Skills", enabled: true, available: true,
      advertised_count: 12, captured_count: 7, unexpected: "field",
    }],
    [{
      id: "../board", name: "Skills", enabled: true, available: true,
      advertised_count: 12, captured_count: 7,
    }],
  ]) assert.throws(() => validateLocalBridgeBoards(malicious));

  const failed = validateLocalBridgeSyncStatus({
    ok: true,
    state: "failed",
    core_completed: true,
    summary_failed: 1,
    summary_halt_reason: "transport-failed",
    error: "&#x70b9;&#x70b9; AI &#x901a;&#x9053;&#x5f02;&#x5e38;"
  });
  assert.equal(failed.error, "点点 AI 通道异常");
  assert.equal(failed.core_completed, true);
  for (const encodedWhitespace of [
    "&#x20;", "&nbsp;", "%20", "\u00a0", "%E2%80%8B",
    "No diagnostic output was returned."
  ]) {
    const status = validateLocalBridgeSyncStatus({ ok: true, state: "failed", error: encodedWhitespace });
    assert.equal("error" in status, false);
  }
  for (const malformed of [
    { ok: true, state: "unknown" },
    { ok: true, state: "failed", error: {} },
    { ok: true, state: "failed", summary_failed: -1 },
    { ok: true, state: "failed", unexpected: "field" },
  ]) assert.throws(() => validateLocalBridgeSyncStatus(malformed));

  const v2 = validateLocalBridgeSyncStatus({
    ok: true,
    schema_version: 2,
    run_id: "fixture-run",
    state: "failed",
    build_version: "",
    copy_key: "build_failed",
    phases: {
      core: { status: "completed", reason_code: "", updated_at: "2026-08-23T00:00:00Z" },
      summary: { status: "completed", reason_code: "", updated_at: "2026-08-23T00:00:00Z" },
      evidence: { status: "ready", reason_code: "", updated_at: "2026-08-23T00:00:00Z" },
      curation: { status: "validated", reason_code: "", updated_at: "2026-08-23T00:00:00Z" },
      build: { status: "failed", artifact_status: "held_previous", reason_code: "build_failed", updated_at: "2026-08-23T00:00:00Z" },
      publish: { status: "not_started", reason_code: "", updated_at: "2026-08-23T00:00:00Z" },
    },
    counts: { scanned: 1, new: 1, summary_captured: 1, summary_failed: 0, summary_batch_aborted: 0, curation_accepted: 1, curation_pending: 0 },
  }, ORGANIZATION_STATUS_CONTRACT);
  assert.equal(v2.phases.build.reason_code, "build_failed");
  assert.throws(() => validateLocalBridgeSyncStatus({ ...v2, state: "completed" }, ORGANIZATION_STATUS_CONTRACT));
  assert.throws(() => validateLocalBridgeSyncStatus({ ...v2, copy_key: "not_a_contract_sentence" }, ORGANIZATION_STATUS_CONTRACT));
  const legacy = validateLocalBridgeSyncStatus({ ok: true, state: "completed", scanned: 1 }, ORGANIZATION_STATUS_CONTRACT);
  assert.equal(legacy.state, "completed_with_warnings");
  assert.equal(legacy.reason_code, "unknown_legacy");
});

test("Hugging Face personal sync validates every remote snapshot before merging or upload", async () => {
  const source = await read("site/hf-personal-sync.mjs");
  const limitedReader = sourceSlice(source, "async function readLimitedResponseText", "async function downloadPersonalData");
  assert.match(limitedReader, /headers\?\.get\?\.\("content-length"\)/);
  assert.match(limitedReader, /response\.body\?\.getReader\?\.\(\)/);
  assert.match(limitedReader, /await reader\.cancel\(\)/);
  const download = sourceSlice(source, "async function downloadPersonalData", "export async function initializeHfPersonalSync");
  assert.match(download, /readLimitedResponseText\(response\)/);
  assert.match(download, /validatePersonalDataPayload\(JSON\.parse\(source\)\)/);
  const save = sourceSlice(source, "export async function saveHfPersonalData", "export function signOutHfPersonalSync");
  assert.ok(save.indexOf("downloadPersonalData") < save.indexOf("mergePersonalData"));

  const readLimited = runInNewContext(
    `const MAX_PERSONAL_DATA_BYTES = 256 * 1024; ${limitedReader}; readLimitedResponseText`,
    { Uint8Array, TextDecoder, TextEncoder, Error }
  );
  let textCalls = 0;
  await assert.rejects(
    readLimited({
      headers: { get: () => String(300 * 1024) },
      text: async () => { textCalls += 1; return "must not read"; }
    }),
    /exceeds the supported size/
  );
  assert.equal(textCalls, 0);

  let reads = 0;
  let cancels = 0;
  await assert.rejects(
    readLimited({
      headers: { get: () => null },
      body: { getReader: () => ({
        async read() {
          reads += 1;
          return { done: false, value: new Uint8Array(140 * 1024) };
        },
        async cancel() { cancels += 1; }
      }) }
    }),
    /exceeds the supported size/
  );
  assert.equal(reads, 2);
  assert.equal(cancels, 1);
});

test("corrupt or future personal data fails closed instead of becoming an empty writable store", () => {
  const ids = new Set(["note-a"]);
  const storageWith = (value) => ({
    getItem: (key) => key === "favsense-personal-v1" ? value : null,
    setItem() { throw new Error("must not write"); },
    removeItem() { throw new Error("must not remove"); }
  });
  assert.throws(() => loadPersonalData(storageWith("{broken"), ids), SyntaxError);
  assert.throws(
    () => loadPersonalData(storageWith(JSON.stringify({
      version: 99,
      bookmarks: ["note-a"],
      bookmarkStates: {},
      descriptionOverrides: {}
    })), ids),
    /版本|结构/,
  );
  assert.throws(() => loadPersonalData({ getItem() { throw new Error("storage unavailable"); } }, ids), /storage unavailable/);
  assert.throws(() => validatePersonalDataPayload({ version: 99 }), /版本|结构/);
});

test("manual sync renders a safety stop as an explicit terminal warning", async () => {
  const app = await read("site/app.js");
  const readyStart = app.indexOf("function sopBrowserReady()");
  const readyEnd = app.indexOf("\nfunction bookmarkIcon", readyStart);
  const readySource = readyStart >= 0 && readyEnd > readyStart ? app.slice(readyStart, readyEnd).trim() : "";
  assert.ok(readySource);
  const renderStart = app.indexOf("function manualSyncRunning(");
  const renderEnd = app.indexOf("async function refreshManualSyncStatus", renderStart);
  const renderSource = renderStart >= 0 && renderEnd > renderStart ? app.slice(renderStart, renderEnd).trim() : "";
  assert.ok(renderSource);
  const classes = new Map();
  const textNode = () => ({ textContent: "", disabled: false });
  const singleNoteButton = { disabled: false };
  const elements = {
    manualSyncControl: { classList: { toggle(name, value) { classes.set(name, value); } } },
    manualSyncStart: textNode(),
    manualSyncClearStop: textNode(),
    manualSyncLocalRebuild: textNode(),
    manualSyncTitle: textNode(),
    manualSyncDetail: textNode(),
    dialogContent: {
      querySelector(selector) {
        return selector === "[data-summarize-note]" ? singleNoteButton : null;
      }
    }
  };
  const state = {
    localBridge: { browserSession: { owner: "sop-cdp", ready: true } },
    manualSync: { state: "idle" },
    boards: []
  };
  runInNewContext(`${readySource}\n${renderSource}\nrenderManualSync({ state: "starting" });`, { state, elements, normalizeLocalBridgeDiagnostic });
  assert.equal(elements.manualSyncTitle.textContent, "正在使用 SOP 小红书扫描浏览器");
  assert.equal(elements.manualSyncStart.disabled, true);

  runInNewContext(`${readySource}\n${renderSource}\nrenderManualSync({ state: "safety-stopped" });`, { state, elements, normalizeLocalBridgeDiagnostic });

  assert.equal(classes.get("is-failed"), true);
  assert.equal(elements.manualSyncStart.textContent, "检查后重试");
  assert.equal(elements.manualSyncTitle.textContent, "已因小红书安全限制停止");
  assert.match(elements.manualSyncDetail.textContent, /不会自动重试/);

  runInNewContext(`${readySource}\n${renderSource}\nrenderManualSync({ state: "running", summary_plan_pending: true });`, { state, elements, normalizeLocalBridgeDiagnostic });
  assert.equal(elements.manualSyncTitle.textContent, "核心入库完成，正在确认深度整理");
  assert.match(elements.manualSyncDetail.textContent, /本地整理结果已保留/);
  assert.equal(singleNoteButton.disabled, true);

  runInNewContext(`${readySource}\n${renderSource}\nrenderManualSync({ state: "failed", error: "fixture failure" });`, { state, elements, normalizeLocalBridgeDiagnostic });
  assert.equal(singleNoteButton.disabled, false, "an open card must become retryable after a terminal failure");

  runInNewContext(`${readySource}\n${renderSource}\nrenderManualSync({
    state: "failed",
    core_completed: true,
    summary_failed: 1,
    summary_halt_reason: "transport-failed",
    error: "点点 AI 自动整理通道异常；核心整理结果已保留。"
  });`, { state, elements, normalizeLocalBridgeDiagnostic });
  assert.equal(elements.manualSyncTitle.textContent, "核心整理已完成，点点增强未完成");
  assert.equal(elements.manualSyncDetail.textContent, "点点 AI 自动整理通道异常；核心整理结果已保留。");

  runInNewContext(`${readySource}\n${renderSource}\nrenderManualSync({ state: "failed", error: "&#x20;" });`, { state, elements, normalizeLocalBridgeDiagnostic });
  assert.equal(elements.manualSyncTitle.textContent, "本次整理未完成");
  assert.equal(
    elements.manualSyncDetail.textContent,
    "请检查 SOP 扫描浏览器的登录状态后再次整理。",
    "an HTML whitespace entity must not replace the actionable failure explanation",
  );

  // The web data is the only formal output, so no sentence reports a second one.
  runInNewContext(`${readySource}\n${renderSource}\nrenderManualSync({ state: "idle" });`, { state, elements, normalizeLocalBridgeDiagnostic });
  assert.equal(elements.manualSyncDetail.textContent, "点击一次即可同步已开启的收藏夹、增量去重，并更新公开网页。");
  runInNewContext(
    `${readySource}\n${renderSource}\nrenderManualSync({ state: "completed", scanned: 3, new: 1, publish_status: "published" });`,
    { state, elements, normalizeLocalBridgeDiagnostic, countText: String },
  );
  assert.equal(elements.manualSyncTitle.textContent, "本次整理完成");
  assert.equal(elements.manualSyncDetail.textContent, "共扫描 3 条，新增 1 条；本地网页数据已经更新，Hugging Face 已更新。");
});

test("the status contract's local rebuild sentence names the web data alone", async () => {
  assert.equal(ORGANIZATION_STATUS_CONTRACT.copy.local_rebuild_running, "正在本地重建网页数据，不访问小红书");
  for (const [key, sentence] of Object.entries(ORGANIZATION_STATUS_CONTRACT.copy)) {
    assert.doesNotMatch(sentence, /知识库与网页|网页与知识库|Obsidian/, key);
  }
});

async function runCoreCompleteRefresh(terminalStatus) {
  const app = await read("site/app.js");
  const refreshStart = app.indexOf("async function refreshManualSyncStatus()");
  const refreshEnd = app.indexOf("\nfunction watchManualSync", refreshStart);
  const refreshSource = refreshStart >= 0 && refreshEnd > refreshStart
    ? app.slice(refreshStart, refreshEnd).trim()
    : "";
  assert.ok(refreshSource, "the production sync status transition must be available");
  const runningCheckStart = app.indexOf("function manualSyncRunning(");
  const runningCheckSource = app.slice(runningCheckStart, app.indexOf("\nfunction renderManualSync", runningCheckStart)).trim();
  assert.ok(runningCheckStart >= 0 && runningCheckSource, "the shared running check must be part of the production app");

  return JSON.parse(await runInNewContext(`
    const terminalStatus = ${JSON.stringify(terminalStatus)};
    const events = [];
    const state = {
      manualSync: { state: "starting" },
      manualSyncStartedHere: true,
      manualSyncPoll: 42,
      statusContract: ${JSON.stringify(ORGANIZATION_STATUS_CONTRACT)}
    };
    const location = { reload() { events.push(["reload"]); } };
    const window = {
      clearInterval(value) { events.push(["clear", value]); },
      setTimeout(callback, delay) { events.push(["timeout", delay]); callback(); }
    };
    async function localBridgeRequest() {
      return terminalStatus;
    }
    function validateLocalBridgeSyncStatus(value) { return value; }
    function renderManualSync(status) {
      state.manualSync = status;
      events.push(["render", status.state, status.core_completed]);
    }
    function showToast(message) { events.push(["toast", message]); }
    ${runningCheckSource}
    ${refreshSource}
    (async () => {
      const status = await refreshManualSyncStatus();
      return JSON.stringify({ status, events, startedHere: state.manualSyncStartedHere });
    })();
  `));
}

test("a core-complete point-enhancement failure refreshes the preserved local results", async () => {
  const result = await runCoreCompleteRefresh({
    ok: true,
    state: "failed",
    core_completed: true,
    summary_failed: 1,
    summary_halt_reason: "transport-failed",
    error: "点点 AI 自动整理通道异常；核心整理结果已保留。"
  });

  assert.deepEqual(result.events, [
    ["render", "failed", true],
    ["clear", 42],
    ["toast", "核心整理完成，点点增强未完成；正在刷新网页"],
    ["timeout", 900],
    ["reload"],
  ]);
  assert.equal(result.startedHere, false);
});

test("a post-core safety stop refreshes preserved results without masking the safety reason", async () => {
  const result = await runCoreCompleteRefresh({
    ok: true,
    state: "safety-stopped",
    core_completed: true,
    summary_failed: 1,
    summary_halt_reason: "xhs-safety-stop",
    error: "页面触发安全限制，核心整理结果已保留。"
  });

  assert.deepEqual(result.events, [
    ["render", "safety-stopped", true],
    ["clear", 42],
    ["toast", "核心整理结果已保留；已因小红书安全限制停止，正在刷新网页"],
    ["timeout", 900],
    ["reload"],
  ]);
  assert.equal(result.startedHere, false);
});

test("v2 polling continues while any phase is still running", async () => {
  const phase = (status) => ({ status, reason_code: "", updated_at: "2026-08-23T00:00:00Z" });
  const result = await runCoreCompleteRefresh({
    ok: true,
    schema_version: 2,
    state: "core_completed",
    phases: {
      core: phase("completed"),
      summary: phase("running"),
      evidence: phase("not_started"),
      curation: phase("not_started"),
      build: phase("not_started"),
      publish: phase("not_started"),
    },
    counts: {},
  });
  assert.deepEqual(result.events, [["render", "core_completed", null]]);
  assert.equal(result.startedHere, true);
});

test("v2 terminal outcomes show truthful refresh messages", async () => {
  const phase = (status, reason_code = "", artifact_status = null) => ({
    status,
    reason_code,
    updated_at: "2026-08-23T00:00:00Z",
    ...(artifact_status ? { artifact_status } : {}),
  });
  const base = {
    ok: true,
    schema_version: 2,
    run_id: "fixture-run",
    state: "published",
    build_version: "a".repeat(64),
    phases: {
      core: phase("completed"),
      summary: phase("completed"),
      evidence: phase("ready"),
      curation: phase("validated"),
      build: phase("succeeded"),
      publish: phase("unchanged"),
    },
    counts: {},
  };
  // The bubble is the contract's sentence for the key the server chose; the page does not pick it.
  for (const [patch, message] of [
    [{
      state: "failed",
      copy_key: "build_failed",
      phases: { ...base.phases, build: phase("failed", "build_failed", "held_previous"), publish: phase("not_started") },
    }, ORGANIZATION_STATUS_CONTRACT.copy.build_failed],
    [{
      state: "completed_with_warnings",
      copy_key: "publish_failed",
      phases: { ...base.phases, publish: phase("failed", "publish_failed", "held_previous") },
    }, ORGANIZATION_STATUS_CONTRACT.copy.publish_failed],
    [{
      state: "organization_partial",
      copy_key: "summary_failed",
      phases: { ...base.phases, summary: phase("failed", "transport_failed"), evidence: phase("missing", "evidence_missing"), curation: phase("pending_review", "audit_pending") },
    }, ORGANIZATION_STATUS_CONTRACT.copy.summary_failed],
    [{
      state: "safety_stopped",
      copy_key: "safety_stopped",
      phases: { ...base.phases, summary: phase("safety_stopped", "safety_signal"), evidence: phase("safety_stopped", "safety_signal"), build: phase("not_started"), publish: phase("not_started") },
    }, ORGANIZATION_STATUS_CONTRACT.copy.safety_stopped],
  ]) {
    const result = await runCoreCompleteRefresh({ ...base, ...patch });
    assert.deepEqual(result.events, [
      ["render", patch.state, null],
      ["clear", 42],
      ["toast", message],
      ["timeout", 900],
      ["reload"],
    ]);
    assert.equal(result.startedHere, false);
  }
});

test("one-click workflow imports first, hands the plan to the sync service and opens nothing", async () => {
  const [template, app] = await Promise.all([
    read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template"),
    read("site/app.js")
  ]);
  const exportMarker = '  GM_registerMenuCommand("打开拾光台后开始整理"';
  assert.match(template, /__DIANDIAN_MATCH_LINE__/);
  assert.ok(template.includes(exportMarker));
  const userscript = renderUserscriptTemplate(template)
    .replace(exportMarker, `  globalThis.__FAVSENSE_TEST_HOOKS__ = { runBoard };\n${exportMarker}`);

  const requests = [];
  const events = [];
  const openedTabs = [];
  const assigned = [];
  let hooks;
  let statusBox = null;
  let timerId = 0;
  const schedule = (callback, delay = 0) => {
    const id = ++timerId;
    if (delay < 5000) queueMicrotask(callback);
    return id;
  };

  const anchors = ["note-a", "note-b"].map((noteId) => {
    const container = { textContent: `Title ${noteId}`, querySelector: () => null };
    return {
      href: `https://www.xiaohongshu.com/board/board1/${noteId}?xsec_token=board-${noteId}&xsec_source=pc_share`,
      textContent: `Title ${noteId}`,
      getAttribute(name) { return name === "title" ? `Title ${noteId}` : ""; },
      querySelector: () => null,
      closest: () => container
    };
  });
  const document = {
    body: { innerText: "" },
    documentElement: {
      scrollHeight: 1200,
      appendChild(element) { statusBox = element; }
    },
    getElementById(id) { return statusBox?.id === id ? statusBox : null; },
    createElement() { return { id: "", style: {}, textContent: "" }; },
    querySelectorAll(selector) { return selector === "a[href]" ? anchors : []; }
  };
  const window = {
    setTimeout: schedule,
    clearTimeout() {},
    setInterval() { return ++timerId; },
    clearInterval() {},
    scrollTo() {},
    scrollBy() {}
  };
  const location = {
    origin: "https://www.xiaohongshu.com",
    pathname: "/board/board1",
    search: "",
    href: "https://www.xiaohongshu.com/board/board1",
    assign(url) { assigned.push(url); },
    replace(url) { assigned.push(url); }
  };
  const responses = {
    "/sync/board-context": { ok: true, board: { id: "board1", name: "Board One", advertised_count: 2 } },
    "/sync/summary-plan": { ok: true, enabled: true, note_ids: ["note-a", "note-b"], driven: true },
    "/import-sync": { ok: true, scanned: 2, new: 2, next_board_id: "board2" }
  };
  const GM_xmlhttpRequest = (options) => {
    const pathname = new URL(options.url).pathname;
    events.push(pathname);
    const body = options.data ? JSON.parse(options.data) : null;
    requests.push({ pathname, body });
    const payload = pathname === "/sync/summary-plan" && body?.note_ids?.length === 0
      ? { ok: true, enabled: false, abandoned: true, note_ids: [] }
      : responses[pathname] || { ok: false, error: `unexpected request: ${pathname}` };
    queueMicrotask(() => options.onload({ status: payload.ok ? 200 : 404, responseText: JSON.stringify(payload) }));
  };

  const context = {
    globalThis: null,
    location,
    history: { state: null, replaceState() {} },
    document,
    window,
    innerHeight: 900,
    URL,
    URLSearchParams,
    TextEncoder,
    crypto: webcrypto,
    setTimeout: schedule,
    clearTimeout() {},
    queueMicrotask,
    GM_xmlhttpRequest,
    GM_registerMenuCommand() {},
    GM_openInTab(url) {
      openedTabs.push(url);
      return { close() {} };
    }
  };
  context.globalThis = context;
  runInNewContext(userscript, context);
  hooks = context.__FAVSENSE_TEST_HOOKS__;
  assert.ok(hooks, "userscript test hooks must be injected into the real workflow closure");

  await hooks.runBoard("incremental", "batch1");

  const planIndex = requests.findIndex((item) => item.pathname === "/sync/summary-plan");
  const importIndex = requests.findIndex((item) => item.pathname === "/import-sync");
  assert.ok(importIndex >= 0 && planIndex > importIndex);
  assert.equal(requests.some((item) => item.pathname === "/sync/failure"), false);
  assert.deepEqual(openedTabs, [], "the board page never opens a tab; the sync service moves the one page");
  assert.deepEqual(assigned, [], "the sync service, not the board page, takes the page to the next step");
  assert.doesNotMatch(template, /GM_setValue|localStorage|sessionStorage/);
  assert.match(app, /\/notes\/open/);
  assert.match(app, /已在 SOP 扫描浏览器中定位原帖/);
  const openHandler = app.match(/const sourceButton = event\.target\.closest\("\[data-open-source-note\]"\);[\s\S]*?(?=\n    const copyButton)/)?.[0] || "";
  assert.match(openHandler, /JSON\.stringify\(\{ note_id: sourceButton\.dataset\.openSourceNote \}\)/);
  assert.doesNotMatch(openHandler, /title|sourceUrl|xsec_token|window\.open/);
});

test("target-note mode imports, plans, and summarizes exactly the requested visible note", async () => {
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  const exportMarker = '  GM_registerMenuCommand("打开拾光台后开始整理"';
  const userscript = renderUserscriptTemplate(template)
    .replace(exportMarker, `  globalThis.__FAVSENSE_TEST_HOOKS__ = { runBoard };\n${exportMarker}`);
  let hooks;
  let targetNoteId = "note-target";
  let invalidPlan = false;
  let statusBox = null;
  let timerId = 0;
  const requests = [];
  const openedTabs = [];
  const assigned = [];
  const schedule = (callback, delay = 0) => {
    const id = ++timerId;
    if (delay < 5000) queueMicrotask(callback);
    return id;
  };

  const anchors = ["note-a", "note-target", "note-c"].map((noteId) => {
    const container = { textContent: `Title ${noteId}`, querySelector: () => null };
    return {
      href: `https://www.xiaohongshu.com/board/board1/${noteId}?xsec_token=board-${noteId}&xsec_source=pc_share`,
      textContent: `Title ${noteId}`,
      getAttribute(name) { return name === "title" ? `Title ${noteId}` : ""; },
      querySelector: () => null,
      closest: () => container
    };
  });
  const document = {
    body: { innerText: "" },
    documentElement: {
      scrollHeight: 1200,
      appendChild(element) { statusBox = element; }
    },
    getElementById(id) { return statusBox?.id === id ? statusBox : null; },
    createElement() { return { id: "", style: {}, textContent: "" }; },
    querySelectorAll(selector) { return selector === "a[href]" ? anchors : []; }
  };
  const location = {
    origin: "https://www.xiaohongshu.com",
    pathname: "/board/board1",
    search: "",
    href: "https://www.xiaohongshu.com/board/board1",
    assign(url) { assigned.push(url); }
  };
  const GM_xmlhttpRequest = (options) => {
    const pathname = new URL(options.url).pathname;
    const body = options.data ? JSON.parse(options.data) : null;
    requests.push({ pathname, body });
    let payload;
    if (pathname === "/sync/board-context") payload = {
      ok: true,
      board: {
        id: "board1",
        name: "Board One",
        advertised_count: anchors.length,
        target_note_id: targetNoteId
      }
    };
    else if (pathname === "/import-sync") payload = {
      ok: true, scanned: body.urls.length, new: body.urls.length, next_board_id: "board2"
    };
    else if (pathname === "/sync/summary-plan" && body.note_ids.length === 0) payload = {
      ok: true, enabled: false, abandoned: true, note_ids: []
    };
    else if (pathname === "/sync/summary-plan") payload = {
      ok: true,
      enabled: true,
      driven: true,
      note_ids: invalidPlan ? [targetNoteId, "note-a"] : [targetNoteId]
    };
    else payload = { ok: true };
    queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify(payload) }));
  };
  const context = {
    globalThis: null,
    location,
    history: { state: null, replaceState() {} },
    document,
    window: {
      setTimeout: schedule,
      clearTimeout() {},
      setInterval() { return ++timerId; },
      clearInterval() {},
      scrollTo() {},
      scrollBy() {}
    },
    innerHeight: 900,
    URL,
    URLSearchParams,
    TextEncoder,
    crypto: webcrypto,
    setTimeout: schedule,
    clearTimeout() {},
    queueMicrotask,
    GM_xmlhttpRequest,
    GM_registerMenuCommand() {},
    GM_openInTab(url) {
      openedTabs.push(String(url));
      return { close() {} };
    }
  };
  context.globalThis = context;
  runInNewContext(userscript, context);
  hooks = context.__FAVSENSE_TEST_HOOKS__;

  const offsets = () => ({ requests: requests.length, tabs: openedTabs.length, assigned: assigned.length });
  let start = offsets();
  await hooks.runBoard("history", "target-success");
  let runRequests = requests.slice(start.requests);
  const imported = runRequests.find((request) => request.pathname === "/import-sync");
  const planned = runRequests.find((request) => request.pathname === "/sync/summary-plan" && request.body.note_ids.length);
  assert.equal(imported.body.urls.length, 1);
  assert.match(imported.body.urls[0], /\/note-target\?/);
  assert.deepEqual(planned.body.note_ids, ["note-target"]);
  assert.deepEqual(Object.keys(planned.body.titles), ["note-target"]);
  assert.equal(openedTabs.slice(start.tabs).length, 0, "the target run opens no tab; the sync service moves the one page");
  assert.deepEqual(assigned.slice(start.assigned), [], "a target run must never continue to another board");

  invalidPlan = true;
  start = offsets();
  await hooks.runBoard("history", "target-invalid-plan");
  runRequests = requests.slice(start.requests);
  assert.equal(openedTabs.slice(start.tabs).length, 0, "an invalid multi-note plan must not open any note or AI tab");
  assert.equal(runRequests.some((request) => request.pathname === "/sync/summary-plan" && request.body.note_ids.length === 0), true);
  assert.deepEqual(assigned.slice(start.assigned), []);

  invalidPlan = false;
  targetNoteId = "missing-note";
  start = offsets();
  await hooks.runBoard("history", "target-missing");
  runRequests = requests.slice(start.requests);
  assert.equal(runRequests.some((request) => request.pathname === "/import-sync"), false);
  assert.equal(runRequests.some((request) => request.pathname === "/sync/summary-plan"), false);
  assert.equal(openedTabs.slice(start.tabs).length, 0);
  assert.deepEqual(assigned.slice(start.assigned), []);
});

test("DianDian browser selectors and completion markers come from the configured Skill contract", async () => {
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  assert.doesNotMatch(template, /\.xhs-ai-selected-note-card|\.ai-message\"|ai-message-finished/);
  const contract = structuredClone(TEST_DIANDIAN_CONTRACT);
  contract.selectors.input_controls = [".contract-only-input"];
  contract.selectors.input_placeholders = ["contract-only-input"];
  contract.selectors.share_controls = [".contract-only-share"];
  contract.selectors.unlabeled_share_controls = [".contract-only-share"];
  contract.selectors.share_menu_items = [".contract-only-menu-item"];
  contract.selectors.share_action_text = "contract-only-share-label";
  contract.selectors.copy_action_text = "contract-only-copy-label";
  contract.selectors.selected_note_card = ".contract-only-card";
  contract.selectors.assistant_message = ".contract-only-message";
  contract.selectors.finished_message_class = "contract-only-finished";
  contract.timings_ms.page_dom_stable = 1777;
  contract.minimum_summary_chars = 37;
  const exportMarker = '  GM_registerMenuCommand("打开拾光台后开始整理"';
  const userscript = renderUserscriptTemplate(template, contract)
    .replace(
      exportMarker,
      `  globalThis.__FAVSENSE_TEST_HOOKS__ = { aiInput, selectedNoteCount, aiMessages };\n${exportMarker}`,
    );
  const input = {
    disabled: false,
    hidden: false,
    getAttribute(name) { return name === "placeholder" ? "contract-only-input" : null; },
    getClientRects() { return [{}]; }
  };
  const cards = [{}, {}];
  const messages = [{ classList: { contains(name) { return name === "contract-only-finished"; } } }];
  let hooks;
  const document = {
    querySelectorAll(selector) {
      if (selector === ".contract-only-input") return [input];
      if (selector === ".contract-only-card") return cards;
      if (selector === ".contract-only-message") return messages;
      return [];
    },
    getElementById() { return null; },
    documentElement: { appendChild() {} }
  };
  const window = { getComputedStyle() { return { display: "block", visibility: "visible" }; } };
  const context = {
    URL,
    URLSearchParams,
    location: { origin: "https://www.xiaohongshu.com", pathname: "/board/testboard", search: "" },
    document,
    window,
    getComputedStyle: window.getComputedStyle,
    GM_registerMenuCommand() { hooks = context.__FAVSENSE_TEST_HOOKS__; },
    GM_openInTab() {},
    HTMLTextAreaElement: class {},
    Event: class {},
    InputEvent: class {},
    KeyboardEvent: class {},
    crypto: webcrypto,
    TextEncoder,
    setTimeout,
    clearTimeout
  };

  runInNewContext(userscript, context);

  assert.equal(hooks.aiInput(), input);
  assert.equal(hooks.selectedNoteCount(), 2);
  assert.equal(hooks.aiMessages().length, 1);
  assert.equal(hooks.aiMessages()[0], messages[0]);
  assert.match(userscript, /contract-only-share/);
  assert.match(userscript, /contract-only-menu-item/);
  assert.match(userscript, /contract-only-copy-label/);
  assert.match(userscript, /contract-only-share-label/);
  assert.match(userscript, /"page_dom_stable":1777/);
  assert.match(userscript, /"minimum_summary_chars":37/);
});

test("a DianDian plan failure cannot roll back or block the completed core import", async () => {
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  const exportMarker = '  GM_registerMenuCommand("打开拾光台后开始整理"';
  const userscript = renderUserscriptTemplate(template)
    .replace(exportMarker, `  globalThis.__FAVSENSE_TEST_HOOKS__ = { runBoard };\n${exportMarker}`);
  const requests = [];
  const assigned = [];
  let abandonAttempts = 0;
  const anchor = {
    href: "https://www.xiaohongshu.com/board/board1/note-a?xsec_token=board-token&xsec_source=pc_share",
    textContent: "Title note-a",
    getAttribute(name) { return name === "title" ? "Title note-a" : ""; },
    closest() { return { textContent: "Title note-a", querySelector: () => null }; }
  };
  let statusBox = null;
  const schedule = (callback, delay = 0) => {
    if (delay < 5000) queueMicrotask(callback);
    return 1;
  };
  const context = {
    globalThis: null,
    location: {
      origin: "https://www.xiaohongshu.com",
      pathname: "/board/board1",
      search: "",
      href: "https://www.xiaohongshu.com/board/board1",
      assign(url) { assigned.push(url); }
    },
    history: { state: null, replaceState() {} },
    document: {
      body: { innerText: "" },
      documentElement: { scrollHeight: 1000, appendChild(element) { statusBox = element; } },
      getElementById(id) { return statusBox?.id === id ? statusBox : null; },
      createElement: () => ({ style: {}, textContent: "" }),
      querySelectorAll(selector) { return selector === "a[href]" ? [anchor] : []; }
    },
    window: { setTimeout: schedule, clearTimeout() {}, scrollTo() {}, scrollBy() {} },
    innerHeight: 800,
    URL,
    URLSearchParams,
    setTimeout: schedule,
    queueMicrotask,
    GM_registerMenuCommand() {},
    GM_xmlhttpRequest(options) {
      const pathname = new URL(options.url).pathname;
      const body = options.data ? JSON.parse(options.data) : null;
      requests.push({ pathname, body });
      if (pathname === "/sync/summary-plan" && body?.note_ids?.length === 0) abandonAttempts += 1;
      const values = {
        "/sync/board-context": { status: 200, body: { ok: true, board: { id: "board1", name: "Board One", advertised_count: 1 } } },
        "/import-sync": { status: 200, body: { ok: true, scanned: 1, new: 1, next_board_id: "board2" } },
        "/sync/summary-plan": body?.note_ids?.length || abandonAttempts < 2
          ? { status: 503, body: { ok: false, error: "optional plan unavailable" } }
          : { status: 200, body: { ok: true, enabled: false, note_ids: [], abandoned: true } }
      };
      const response = values[pathname] || { status: 500, body: { ok: false, error: `unexpected ${pathname}` } };
      queueMicrotask(() => options.onload({ status: response.status, responseText: JSON.stringify(response.body) }));
    }
  };
  context.globalThis = context;
  runInNewContext(userscript, context);

  await context.__FAVSENSE_TEST_HOOKS__.runBoard("incremental", "batch1");

  const importIndex = requests.findIndex((request) => request.pathname === "/import-sync");
  const planCalls = requests.filter((request) => request.pathname === "/sync/summary-plan");
  assert.ok(importIndex >= 0 && requests.indexOf(planCalls[0]) > importIndex);
  assert.deepEqual(planCalls.map((request) => request.body), [
    { run_id: "batch1_board1", board_id: "board1", note_ids: ["note-a"], titles: { "note-a": "Title note-a" } },
    { run_id: "batch1_board1", board_id: "board1", note_ids: [] },
    { run_id: "batch1_board1", board_id: "board1", note_ids: [] }
  ]);
  assert.equal(abandonAttempts, 2);
  assert.equal(requests.some((request) => request.pathname === "/sync/failure"), false);
  assert.match(assigned.at(-1), /^https:\/\/www\.xiaohongshu\.com\/board\/board2\?/);
});

async function runBoardAckFailureScenario() {
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  const exportMarker = '  GM_registerMenuCommand("打开拾光台后开始整理"';
  const userscript = renderUserscriptTemplate(template)
    .replace(exportMarker, `  globalThis.__FAVSENSE_TEST_HOOKS__ = { runBoard };\n${exportMarker}`);
  const requests = [];
  const assigned = [];
  let statusBox = null;
  let hooks;
  const schedule = (callback, delay = 0) => {
    if (delay < 5000) queueMicrotask(callback);
    return 1;
  };

  const anchor = {
    href: "https://www.xiaohongshu.com/board/board1/note-a?xsec_token=board-token&xsec_source=pc_share",
    textContent: "Title note-a",
    getAttribute(name) { return name === "title" ? "Title note-a" : ""; },
    querySelector: () => null,
    closest() { return { textContent: "Title note-a", querySelector: () => null }; }
  };
  const context = {
    globalThis: null,
    location: {
      origin: "https://www.xiaohongshu.com",
      pathname: "/board/board1",
      search: "",
      href: "https://www.xiaohongshu.com/board/board1",
      assign(url) { assigned.push(url); }
    },
    history: { state: null, replaceState() {} },
    document: {
      body: { innerText: "" },
      documentElement: { scrollHeight: 1000, appendChild(element) { statusBox = element; } },
      getElementById(id) { return statusBox?.id === id ? statusBox : null; },
      createElement: () => ({ id: "", style: {}, textContent: "" }),
      querySelectorAll(selector) { return selector === "a[href]" ? [anchor] : []; }
    },
    window: {
      setTimeout: schedule,
      clearTimeout() {},
      setInterval: () => 1,
      clearInterval() {},
      scrollTo() {},
      scrollBy() {}
    },
    innerHeight: 800,
    URL,
    URLSearchParams,
    TextEncoder,
    crypto: webcrypto,
    setTimeout: schedule,
    clearTimeout() {},
    queueMicrotask,
    GM_registerMenuCommand() {},
    GM_xmlhttpRequest(options) {
      const pathname = new URL(options.url).pathname;
      const body = options.data ? JSON.parse(options.data) : null;
      requests.push({ pathname, body });
      let response;
      if (pathname === "/sync/board-context") {
        response = { status: 200, body: { ok: true, board: { id: "board1", name: "Board One", advertised_count: 1 } } };
      } else if (pathname === "/import-sync") {
        response = { status: 200, body: { ok: true, scanned: 1, new: 1, next_board_id: "board2" } };
      } else if (pathname === "/sync/summary-plan") {
        response = { status: 503, body: { ok: false, error: "plan acknowledgement unavailable" } };
      } else {
        response = { status: 500, body: { ok: false, error: `unexpected ${pathname}` } };
      }
      queueMicrotask(() => options.onload({ status: response.status, responseText: JSON.stringify(response.body) }));
    }
  };
  context.globalThis = context;
  runInNewContext(userscript, context);
  hooks = context.__FAVSENSE_TEST_HOOKS__;
  await hooks.runBoard("incremental", "batch1");
  return { assigned, requests, status: statusBox?.textContent || "" };
}

test("runBoard stays on the current board when both plan-abandon acknowledgements fail", async () => {
  const result = await runBoardAckFailureScenario();
  const abandonCalls = result.requests.filter((request) => (
    request.pathname === "/sync/summary-plan" && request.body.note_ids.length === 0
  ));
  assert.equal(abandonCalls.length, 2);
  assert.deepEqual(result.assigned, []);
  assert.equal(result.requests.some((request) => request.pathname === "/sync/failure"), false);
  assert.doesNotMatch(result.status, /完成/);
});

test("profile and board workflows preserve a pre-core safety stop in the bridge protocol", async () => {
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  const exportMarker = '  GM_registerMenuCommand("打开拾光台后开始整理"';
  const userscript = renderUserscriptTemplate(template)
    .replace(exportMarker, `  globalThis.__FAVSENSE_TEST_HOOKS__ = { runProfile, runBoard };\n${exportMarker}`);
  const requests = [];
  let statusBox = null;
  const location = {
    origin: "https://www.xiaohongshu.com",
    href: "https://www.xiaohongshu.com/board/board1",
    pathname: "/board/board1",
    search: "",
    assign() { throw new Error("a safety stop must not navigate"); }
  };
  const document = {
    body: { innerText: "请完成验证码" },
    documentElement: { scrollHeight: 0, appendChild(node) { statusBox = node; } },
    getElementById(id) { return id === "xhs-kb-sync-status" ? statusBox : null; },
    createElement() { return { id: "", style: {}, textContent: "" }; },
    querySelectorAll(selector) {
      if (String(selector).includes('[role="alert"]')) return [{
        innerText: document.body.innerText,
        hidden: false,
        getAttribute: () => null,
        getClientRects: () => [{}]
      }];
      return [];
    }
  };
  const context = {
    globalThis: null,
    location,
    history: { state: null, replaceState() {} },
    document,
    window: { setTimeout, clearTimeout, scrollTo() {}, scrollBy() {} },
    innerHeight: 800,
    URL,
    URLSearchParams,
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    GM_xmlhttpRequest(options) {
      const url = new URL(options.url);
      const body = options.data ? JSON.parse(options.data) : undefined;
      requests.push({ pathname: url.pathname, body });
      const response = url.pathname === "/sync/board-context"
        ? { ok: true, board: { id: "board1", name: "Board One" } }
        : { ok: true, state: "safety-stopped" };
      queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify(response) }));
    },
    GM_registerMenuCommand() {}
  };
  context.globalThis = context;
  runInNewContext(userscript, context);

  await context.__FAVSENSE_TEST_HOOKS__.runProfile("incremental", "profile-batch");
  await context.__FAVSENSE_TEST_HOOKS__.runBoard("incremental", "board-batch");

  assert.deepEqual(
    requests.filter((request) => request.pathname === "/sync/failure").map((request) => request.body),
    [
      { run_id: "profile-batch", error: "xhs-safety-stop" },
      { run_id: "board-batch_board1", board_id: "board1", error: "xhs-safety-stop" }
    ]
  );
  assert.equal(requests.some((request) => ["/sync/discover", "/import-sync"].includes(request.pathname)), false);
});

test("userscript separates platform safety chrome from ordinary note content", async () => {
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  const exportMarker = '  GM_registerMenuCommand("打开拾光台后开始整理"';
  const userscript = renderUserscriptTemplate(template)
    .replace(exportMarker, `  globalThis.__FAVSENSE_TEST_HOOKS__ = { assertSafePage, isSafetyFailure };\n${exportMarker}`);
  let challengeControls = [];
  let messageControls = [];
  const document = {
    title: "小红书",
    body: { innerText: "验证码识别教程：如何处理访问频繁，并解释错误码 300031" },
    documentElement: { appendChild() {} },
    getElementById: () => null,
    createElement: () => ({ id: "", style: {}, textContent: "" }),
    querySelectorAll(selector) {
      if (String(selector).includes("captcha")) return challengeControls;
      if (String(selector).includes('[role="alert"]')) return messageControls;
      return [];
    }
  };
  const context = {
    globalThis: null,
    location: {
      origin: "https://www.xiaohongshu.com",
      href: "https://www.xiaohongshu.com/explore",
      pathname: "/explore",
      search: ""
    },
    history: { state: null, replaceState() {} },
    document,
    window: { setTimeout, clearTimeout },
    getComputedStyle(element) {
      return element.testStyle || { display: "block", visibility: "visible", opacity: "1" };
    },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    GM_xmlhttpRequest(options) {
      queueMicrotask(() => options.onload({ status: 200, responseText: '{"ok":true}' }));
    },
    GM_registerMenuCommand() {}
  };
  context.globalThis = context;
  runInNewContext(userscript, context);

  assert.doesNotThrow(() => context.__FAVSENSE_TEST_HOOKS__.assertSafePage());
  assert.equal(
    context.__FAVSENSE_TEST_HOOKS__.isSafetyFailure(new Error("点点 AI 总结《验证码识别教程》超时")),
    false,
    "a note title embedded in an ordinary timeout must remain content, not a safety signal"
  );
  assert.equal(
    context.__FAVSENSE_TEST_HOOKS__.isSafetyFailure({ code: "xhs-safety-stop", message: "" }),
    true
  );
  document.title = "验证码";
  assert.doesNotThrow(
    () => context.__FAVSENSE_TEST_HOOKS__.assertSafePage(),
    "a note-controlled page title must not act as platform safety chrome"
  );
  document.title = "小红书";
  document.body.innerText = "访问频繁 300031，请稍后再试";
  messageControls = [{
    innerText: document.body.innerText,
    hidden: false,
    getAttribute: () => null,
    getClientRects: () => [{}],
    testStyle: { display: "block", visibility: "hidden", opacity: "1" }
  }];
  assert.doesNotThrow(
    () => context.__FAVSENSE_TEST_HOOKS__.assertSafePage(),
    "CSS-hidden alert text must not act as visible platform chrome"
  );
  messageControls[0].testStyle.visibility = "visible";
  assert.throws(
    () => context.__FAVSENSE_TEST_HOOKS__.assertSafePage(),
    (error) => error.code === "xhs-safety-stop"
  );
  document.body.innerText = "验证码识别教程：如何处理访问频繁";
  messageControls = [];
  challengeControls = [{
    hidden: false,
    getAttribute: () => null,
    getClientRects: () => [{}],
    testStyle: { display: "block", visibility: "visible", opacity: "0" }
  }];
  assert.doesNotThrow(
    () => context.__FAVSENSE_TEST_HOOKS__.assertSafePage(),
    "a fully transparent challenge container must not act as visible platform chrome"
  );
  challengeControls[0].testStyle.opacity = "1";
  assert.throws(
    () => context.__FAVSENSE_TEST_HOOKS__.assertSafePage(),
    (error) => error.code === "xhs-safety-stop"
  );
});

async function runMountedAiWorker({
  safetyText = "",
  safetyAfterEnter = false,
  safetyAfterPrompt = false,
  safetyAfterSave = false,
  inputMode = "attachment",
  tamperInlineLink = false,
  preexistingFinished = false,
  sourceUrl = "",
  delayedFinishedReply = false
  , replaceFinishedReply = false
  , preventPasteDefault = false
} = {}) {
  const [template, inputFixture, inlineFixture, hybridFixture] = await Promise.all([
    read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template"),
    read("skills/xhs-favorites-organizer/test-fixtures/diandian-visible-input-paste.json").then(JSON.parse),
    read("skills/xhs-favorites-organizer/test-fixtures/diandian-inline-link-prompt.json").then(JSON.parse),
    read("skills/xhs-favorites-organizer/test-fixtures/diandian-hybrid-context.json").then(JSON.parse)
  ]);
  // The page gets its job from the sync service by the worker id in its address, runs it by itself and
  // reports the result; the reported result is mapped to the saved/failed shape these tests read.
  const userscript = renderUserscriptTemplate(template);
  let reportOutcome;
  const reported = new Promise((resolveReport) => { reportOutcome = resolveReport; });

  class BrowserEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.defaultPrevented = false;
      Object.assign(this, init);
    }
    preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
  }
  class FakeDataTransfer {
    constructor() { this.values = new Map(); }
    setData(type, value) { this.values.set(type, String(value)); }
    getData(type) { return this.values.get(type) || ""; }
  }
  let selectedCount = 0;
  let hybridObservationCount = 0;
  let hybridSettled = false;
  let fallbackSendClicks = 0;
  let attachedInputId = "";
  const linkEvents = [];
  const messages = [];
  const sentPrompts = [];
  const linkInjections = [];
  const promptInputPayloads = [];
  let newMessageFinished = false;
  let saveSawFinishedReply = false;
  if (preexistingFinished) {
    messages.push({
      innerText: "这是打开新标签页前遗留的旧完成消息，绝不能作为本篇笔记的总结保存。",
      classList: { contains: (name) => name === "ai-message-finished" }
    });
  }
  class FakeTextarea {
    constructor(spec) {
      this._value = "";
      this.id = spec.id;
      this.placeholder = spec.placeholder;
      this.hidden = !spec.visible;
      this.visible = spec.visible;
      this.disabled = false;
    }
    get value() { return this._value; }
    set value(value) {
      this._value = value;
      if (/^https:\/\/www\.xiaohongshu\.com\//.test(String(value))) {
        linkInjections.push({ source: "value-setter", includesPrompt: String(value).endsWith(" 总结") });
      }
    }
    setRangeText(replacement, start, end) {
      this._value = `${this._value.slice(0, start)}${replacement}${this._value.slice(end)}`;
    }
    focus() {}
    getAttribute(name) {
      if (name === "placeholder") return this.placeholder;
      if (name === "aria-hidden") return this.hidden ? "true" : "false";
      return null;
    }
    getClientRects() { return this.visible ? [{ width: 320, height: 48 }] : []; }
    dispatchEvent(event) {
      const pastedLink = event.clipboardData?.getData?.("text/plain") || "";
      const valueIsLink = /^https:\/\/www\.xiaohongshu\.com\//.test(this._value);
      const pasteIsLink = /^https:\/\/www\.xiaohongshu\.com\//.test(pastedLink);
      const isExpectedInlinePrompt = this._value === inlineFixture.expected_prompt;
      if (valueIsLink || pasteIsLink) {
        linkEvents.push({ inputId: this.id, type: event.type, inputType: event.inputType || "", pastedLink });
        if (!this.visible) throw new Error("DianDian automation targeted the hidden legacy textarea");
      if (event.type === inputFixture.required_link_event && pasteIsLink) {
          attachedInputId = this.id;
          linkInjections.push({ source: "paste-event", includesPrompt: false });
          if (preventPasteDefault) {
            event.preventDefault();
            queueMicrotask(() => {
              this._value = pastedLink;
            });
            return false;
          }
          this._value = pastedLink;
          if (["attachment", "hybrid", "hybrid-tampered", "hybrid-then-attachment"].includes(inputMode)) {
            selectedCount = 1;
            if (inputMode === "attachment") this._value = "";
            if (inputMode === "hybrid-tampered") this._value = hybridFixture.tampered_value;
          }
        } else if (
          event.type === "input"
          && event.inputType !== inputFixture.forbidden_duplicate_link_event.input_type
          && !isExpectedInlinePrompt
        ) {
          throw new Error("DianDian note links must enter through paste semantics");
        }
      }
      if (event.type === "input" && event.inputType === "insertText") {
        promptInputPayloads.push(String(event.data || ""));
      }
      if (event.type === "change" && inputMode === "inline-link" && tamperInlineLink) {
        this._value = inlineFixture.tampered_value;
      }
      if (event.type === "change" && safetyAfterPrompt && this._value === inlineFixture.expected_prompt) {
        document.body.innerText = "验证码";
      }
      if (event.type === "keydown" && event.key === "Enter") {
        sentPrompts.push(this._value);
        const expectedPrompt = inputMode === "inline-link" ? inlineFixture.expected_prompt : "总结";
        if (this._value !== expectedPrompt) return true;
        if (safetyAfterEnter) {
          document.body.innerText = "验证码";
          return true;
        }
        this._value = "";
        let finishedChecks = 0;
        messages.push({
          innerText: "这是点点 AI 为当前笔记生成的完整新总结正文，包含足够信息用于保存。",
          classList: {
            contains(name) {
              if (name !== "ai-message-finished") return false;
              finishedChecks += 1;
              newMessageFinished = !delayedFinishedReply || finishedChecks >= 3;
              return newMessageFinished;
            }
          }
        });
        if (replaceFinishedReply) queueMicrotask(() => {
          messages[messages.length - 1] = {
            innerText: "这是点点 AI 替换节点后生成的完整新总结正文，内容比旧节点更完整且必须保存这一版。",
            classList: { contains: (name) => name === "ai-message-finished" }
          };
        });
      }
      return true;
    }
  }
  const inputs = inputFixture.inputs.map((spec) => new FakeTextarea(spec));
  const selectedCard = { innerText: "Mounted AI worker note" };
  const sendButton = {
    disabled: false,
    className: "send-button",
    textContent: "发送",
    getAttribute: () => "",
    click() { fallbackSendClicks += 1; }
  };
  const document = {
    body: { innerText: safetyText },
    documentElement: { appendChild() {} },
    getElementById: () => null,
    createElement: () => ({ style: {}, textContent: "" }),
    querySelector(selector) {
      if (!selector.startsWith("textarea")) return null;
      const placeholder = selector.match(/placeholder=["']([^"']+)["']/)?.[1];
      return placeholder ? inputs.find((input) => input.placeholder === placeholder) || null : inputs[0] || null;
    },
    querySelectorAll(selector) {
      if (document.body.innerText && String(selector).includes('[role="alert"]')) return [{
        innerText: document.body.innerText,
        hidden: false,
        getAttribute: () => null,
        getClientRects: () => [{}]
      }];
      if (selector === "textarea") return inputs;
      if (selector === ".xhs-ai-selected-note-card") {
        if (inputMode === "hybrid-then-attachment" && selectedCount && !hybridSettled) {
          hybridObservationCount += 1;
          if (hybridObservationCount >= 4) {
            inputs.find((input) => input.visible)._value = "";
            hybridSettled = true;
          }
        }
        return selectedCount ? [selectedCard] : [];
      }
      if (selector === ".ai-message") return messages;
      if (selector === "button") return [sendButton];
      return [];
    }
  };
  const requests = [];
  const GM_xmlhttpRequest = (options) => {
    const pathname = new URL(options.url).pathname;
    const body = options.data ? JSON.parse(options.data) : null;
    requests.push({ pathname, body });
    if (pathname === "/sync/diandian-result") saveSawFinishedReply = newMessageFinished;
    if (pathname === "/sync/page-result") {
      reportOutcome(body.ok ? { type: "saved", error: "" } : { type: "failed", error: body.error });
    }
    const response = pathname === "/sync/board-context"
      ? { ok: true, board: { id: "board1", name: "Board One" } }
      : pathname === "/sync/page-task"
        ? {
            ok: true,
            task: {
              stage: "ai",
              run_id: "batch1_board1",
              board_id: "board1",
              note_id: "note-a",
              title: "Mounted AI worker note",
              batch: "batch1",
              url: sourceUrl || (inputMode === "inline-link"
                ? inlineFixture.canonical_share_url
                : "https://www.xiaohongshu.com/discovery/item/note-a?xsec_token=copied-token&xsec_source=pc_share")
            }
          }
        : { ok: true, saved: true, plan_complete: true, finalization_started: true };
    queueMicrotask(() => {
      options.onload({ status: 200, responseText: JSON.stringify(response) });
      if (pathname === "/sync/diandian-result" && safetyAfterSave) document.body.innerText = "验证码";
    });
  };
  const workerId = "11111111-1111-4111-8111-111111111111";
  class FastDate extends Date {
    static clock = 0;
    static now() {
      FastDate.clock += 1000;
      return FastDate.clock;
    }
  }
  const schedule = (callback) => { queueMicrotask(callback); return 1; };
  const context = {
    globalThis: null,
    location: {
      origin: "https://www.xiaohongshu.com",
      pathname: "/ai_chat",
      search: `?xhs_kb_worker=${workerId}`,
      href: `https://www.xiaohongshu.com/ai_chat?xhs_kb_worker=${workerId}`
    },
    history: { state: null, replaceState() {} },
    document,
    window: {
      setTimeout: schedule, clearTimeout, setInterval, clearInterval,
      getComputedStyle(element) {
        return { display: element.visible ? "block" : "none", visibility: element.visible ? "visible" : "hidden" };
      }
    },
    URL,
    URLSearchParams,
    TextEncoder,
    crypto: webcrypto,
    HTMLTextAreaElement: FakeTextarea,
    InputEvent: BrowserEvent,
    Event: BrowserEvent,
    ClipboardEvent: BrowserEvent,
    KeyboardEvent: BrowserEvent,
    DataTransfer: FakeDataTransfer,
    Date: FastDate,
    setTimeout: schedule,
    clearTimeout,
    queueMicrotask,
    GM_xmlhttpRequest,
    GM_registerMenuCommand() {},
    GM_openInTab() { throw new Error("AI worker must not open another tab"); }
  };
  context.globalThis = context;
  // The worker starts by itself when the page loads and reports when it is done.
  runInNewContext(userscript, context);
  const message = await Promise.race([
    reported,
    new Promise((_resolve, rejectTimeout) => setTimeout(() => rejectTimeout(new Error("the AI page never reported")), 3000))
  ]);
  return {
    message,
    requests,
    fallbackSendClicks,
    attachedInputId,
    inputFixture,
    inlineFixture,
    hybridFixture,
    linkEvents,
    linkInjections,
    promptInputPayloads,
    newMessageFinished,
    saveSawFinishedReply,
    sentPrompts,
    selectedCount
  };
}

test("mounted AI worker posts only the completed new summary and preserves safety-stop codes", async () => {
  const success = await runMountedAiWorker();
  assert.equal(success.message.type, "saved");
  assert.equal(success.attachedInputId, success.inputFixture.expected_input_id);
  assert.equal(success.linkEvents.some((event) => (
    event.inputId === success.inputFixture.expected_input_id
    && event.type === success.inputFixture.required_link_event
    && /^https:\/\/www\.xiaohongshu\.com\//.test(event.pastedLink)
  )), true, "the visible conversation textarea must receive the note URL through clipboard paste data");
  assert.equal(success.linkEvents.some((event) => (
    event.inputId === success.inputFixture.expected_input_id
    && event.type === success.inputFixture.forbidden_duplicate_link_event.type
    && event.inputType === success.inputFixture.forbidden_duplicate_link_event.input_type
  )), false, "the native paste must not be followed by a duplicate full-link input event");
  const saved = success.requests.find((request) => request.pathname === "/sync/diandian-result");
  assert.deepEqual(saved?.body, {
    run_id: "batch1_board1",
    board_id: "board1",
    note_id: "note-a",
    title: "Mounted AI worker note",
    summary: "这是点点 AI 为当前笔记生成的完整新总结正文，包含足够信息用于保存。"
  });

  const safety = await runMountedAiWorker({ safetyText: "验证码" });
  assert.equal(safety.message.type, "failed");
  assert.equal(safety.message.error, "xhs-safety-stop");
  assert.equal(safety.requests.some((request) => request.pathname === "/sync/diandian-result"), false);

  const safetyDuringSubmit = await runMountedAiWorker({ safetyAfterEnter: true });
  assert.equal(safetyDuringSubmit.message.type, "failed");
  assert.equal(safetyDuringSubmit.message.error, "xhs-safety-stop");
  assert.equal(safetyDuringSubmit.fallbackSendClicks, 0, "safety stop must not click the fallback send button");
});

test("mounted AI worker submits an exact retained canonical link without requiring an attachment card", async () => {
  const success = await runMountedAiWorker({ inputMode: "inline-link", preexistingFinished: true });
  assert.equal(success.message.type, "saved", success.message.error || "inline-link summary was not saved");
  assert.equal(success.selectedCount, 0, "the current DianDian UI does not render a selected-note attachment card");
  assert.equal(success.attachedInputId, success.inputFixture.expected_input_id);
  assert.deepEqual(success.sentPrompts, [success.inlineFixture.expected_prompt]);
  const saved = success.requests.find((request) => request.pathname === "/sync/diandian-result");
  assert.equal(saved?.body.summary, "这是点点 AI 为当前笔记生成的完整新总结正文，包含足够信息用于保存。");

  const tampered = await runMountedAiWorker({ inputMode: "inline-link", tamperInlineLink: true });
  assert.equal(tampered.message.type, "failed");
  assert.equal(tampered.message.error, "ai-prompt-not-stable");
  assert.deepEqual(tampered.sentPrompts, []);
  assert.equal(tampered.requests.some((request) => request.pathname === "/sync/diandian-result"), false);

  const safetyDuringSubmit = await runMountedAiWorker({ inputMode: "inline-link", safetyAfterEnter: true });
  assert.equal(safetyDuringSubmit.message.type, "failed");
  assert.equal(safetyDuringSubmit.message.error, "xhs-safety-stop");
  assert.equal(safetyDuringSubmit.fallbackSendClicks, 0, "safety stop must not click the fallback send button");

  const safetyBeforeSubmit = await runMountedAiWorker({ inputMode: "inline-link", safetyAfterPrompt: true });
  assert.equal(safetyBeforeSubmit.message.type, "failed");
  assert.equal(safetyBeforeSubmit.message.error, "xhs-safety-stop");
  assert.deepEqual(safetyBeforeSubmit.sentPrompts, [], "safety stop must be checked before pressing Enter");
});

test("mounted AI worker follows the complete single-note state arc without duplicate link insertion", async () => {
  const contract = JSON.parse(await read(
    "skills/xhs-favorites-organizer/test-fixtures/diandian-single-note-state-arc.json"
  ));
  const sourceUrl = "https://www.xiaohongshu.com/discovery/item/note-a?xsec_token=fixture-token&xsec_source=pc_share";
  const result = await runMountedAiWorker({
    inputMode: "inline-link",
    sourceUrl,
    preexistingFinished: true,
    delayedFinishedReply: true
  });

  assert.equal(result.message.type, "saved", result.message.error || "the complete state arc did not save");
  assert.equal(
    result.linkInjections.filter((event) => event.source === "paste-event").length,
    contract.expected_link_injections,
    "the note URL must be injected by exactly one paste action"
  );
  assert.equal(
    result.linkInjections.filter((event) => event.source === "value-setter").length,
    0,
    "a successful native paste must not be followed by a second full-link setter write"
  );
  assert.deepEqual(
    result.promptInputPayloads,
    [contract.expected_prompt_append],
    "direct-link mode must append only the fixed prompt suffix to the retained URL"
  );
  assert.deepEqual(result.sentPrompts, [`${sourceUrl}${contract.expected_prompt_append}`]);
  assert.equal(result.sentPrompts.length, contract.expected_submissions);
  assert.equal(result.newMessageFinished, true, "the new assistant reply must reach finished state");
  assert.equal(result.saveSawFinishedReply, true, "saving must occur only after the new reply is finished");
  assert.equal(
    result.requests.filter((request) => request.pathname === "/sync/diandian-result").length,
    1,
    "the finished reply must be saved exactly once"
  );
});

test("mounted AI worker never performs a fallback write after a handled asynchronous paste", async () => {
  const result = await runMountedAiWorker({ inputMode: "inline-link", preventPasteDefault: true });
  assert.equal(result.message.type, "saved", result.message.error || "handled paste did not complete");
  assert.equal(result.linkInjections.filter((event) => event.source === "paste-event").length, 1);
  assert.equal(result.linkInjections.filter((event) => event.source === "value-setter").length, 0);
});

test("mounted AI worker follows the current finished reply when DianDian replaces its DOM node", async () => {
  const result = await runMountedAiWorker({ inputMode: "inline-link", replaceFinishedReply: true });
  assert.equal(result.message.type, "saved", result.message.error || "replacement reply was not saved");
  const saved = result.requests.find((request) => request.pathname === "/sync/diandian-result");
  assert.equal(saved?.body.summary, "这是点点 AI 替换节点后生成的完整新总结正文，内容比旧节点更完整且必须保存这一版。");
});

test("mounted AI worker reports a safety stop that appears during the post-save dwell", async () => {
  const result = await runMountedAiWorker({ inputMode: "inline-link", safetyAfterSave: true });
  assert.equal(result.message.type, "failed");
  assert.equal(result.message.error, "xhs-safety-stop");
  assert.equal(result.requests.filter((request) => request.pathname === "/sync/diandian-result").length, 1);
});

test("mounted AI worker rejects a mixed attachment-card and retained-link context", async () => {
  for (const inputMode of ["hybrid", "hybrid-tampered"]) {
    const result = await runMountedAiWorker({ inputMode });
    assert.equal(result.message.type, "failed");
    assert.equal(result.message.error, "link-not-recognized");
    assert.equal(result.selectedCount, 1);
    assert.deepEqual(result.sentPrompts, []);
    assert.equal(result.requests.some((request) => request.pathname === "/sync/diandian-result"), false);
  }
});

test("mounted AI worker waits for a transient card-and-link state to settle", async () => {
  const result = await runMountedAiWorker({ inputMode: "hybrid-then-attachment" });
  assert.equal(result.message.type, "saved", result.message.error || "the transient DianDian state did not settle");
  assert.deepEqual(result.sentPrompts, ["总结"]);
  assert.equal(result.requests.filter((request) => request.pathname === "/sync/diandian-result").length, 1);
});

test("CDP mode omits the AI match and cannot start the page worker defensively", async () => {
  const contract = structuredClone(TEST_DIANDIAN_CONTRACT);
  contract.cdp_enabled = true;
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  const userscript = renderUserscriptTemplate(template, contract);
  let workerStarts = 0;
  const schedule = (callback) => { queueMicrotask(callback); return 1; };
  runInNewContext(userscript, {
    location: {
      origin: "https://www.xiaohongshu.com",
      pathname: "/ai_chat",
      search: "?xhs_kb_worker=11111111-1111-1111-1111-111111111111",
      href: "https://www.xiaohongshu.com/ai_chat?xhs_kb_worker=11111111-1111-1111-1111-111111111111"
    },
    history: { state: null, replaceState() {} },
    document: {
      body: { innerText: "" },
      documentElement: { appendChild() {} },
      getElementById: () => null,
      createElement: () => ({ style: {}, textContent: "" })
    },
    window: { setTimeout: schedule, clearTimeout() {} },
    URL,
    URLSearchParams,
    TextEncoder,
    crypto: webcrypto,
    setTimeout: schedule,
    clearTimeout() {},
    queueMicrotask,
    GM_xmlhttpRequest(options) {
      // A page worker would start by asking the sync service for its job.
      if (new URL(options.url).pathname === "/sync/page-task") workerStarts += 1;
      queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify({ ok: true }) }));
    },
    GM_registerMenuCommand() {}
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.doesNotMatch(userscript, /^\/\/ @match\s+https:\/\/www\.xiaohongshu\.com\/ai_chat/m);
  assert.equal(workerStarts, 0);
});

test("generated userscript exits before touching secrets or privileged APIs on a non-Xiaohongshu origin", async () => {
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  const userscript = renderUserscriptTemplate(template);
  let trapCount = 0;
  const trap = () => { trapCount += 1; };
  class TrapTextEncoder {
    constructor() { trapCount += 1; }
  }

  runInNewContext(userscript, {
    location: { origin: "http://attacker.invalid", pathname: "/ai_chat", search: "" },
    TextEncoder: TrapTextEncoder,
    GM_xmlhttpRequest: trap,
    GM_registerMenuCommand: trap,
    GM_openInTab: trap,
  });

  assert.equal(trapCount, 0);
});

test("long board IDs derive collision-resistant run IDs consistently", async () => {
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  const helpers = sourceSlice(template, "  function hex(bytes)", "\n  async function waitUntil");
  const batch = "manual20260822010101000000";
  const firstBoard = `${"a".repeat(79)}b`;
  const secondBoard = `${"a".repeat(79)}c`;
  const result = await runInNewContext(
    `${helpers}\n(async () => ({
      first: await manualRunId(${JSON.stringify(batch)}, ${JSON.stringify(firstBoard)}),
      second: await manualRunId(${JSON.stringify(batch)}, ${JSON.stringify(secondBoard)}),
      short: await manualRunId("shortbatch", "board")
    }))()`,
    { crypto: webcrypto, TextEncoder, Uint8Array }
  );
  const expected = createHash("sha256")
    .update(`${batch}\0${firstBoard}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  assert.equal(result.first.length, 80);
  assert.equal(result.second.length, 80);
  assert.notEqual(result.first, result.second);
  assert.ok(result.first.endsWith(`_${expected}`));
  assert.equal(result.short, "shortbatch_board");
});

test("userscript metadata identifies the one-page workflow release and asks for no tab-opening grant", async () => {
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  assert.equal(template.match(/^\/\/ @version\s+(\S+)$/m)?.[1], "3.1.0");
  assert.deepEqual(
    [...template.matchAll(/^\/\/ @grant\s+(\S+)$/gm)].map((match) => match[1]),
    ["GM_xmlhttpRequest", "GM_registerMenuCommand"]
  );
});

test("userscript metadata covers the exact Xiaohongshu page opened by setup", async () => {
  const [template, setup] = await Promise.all([
    read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template"),
    read("skills/xhs-favorites-organizer/scripts/setup-autosync.ps1"),
  ]);
  const setupLandingUrl = setup.match(/\$xhsLoginUrl\s*=\s*'([^']+)'/)?.[1];
  const matchUrls = [...template.matchAll(/^\/\/ @match\s+(\S+)$/gm)].map((match) => match[1]);

  assert.equal(setupLandingUrl, "https://www.xiaohongshu.com/explore");
  assert.ok(matchUrls.includes(setupLandingUrl));
});

test("exact-note navigation replaces the signed history entry with a token-free URL", async () => {
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  const userscript = renderUserscriptTemplate(template);
  let replacement = "";
  runInNewContext(userscript, {
    location: {
      origin: "https://www.xiaohongshu.com",
      href: "https://www.xiaohongshu.com/discovery/item/note-id?xsec_token=private&xsec_source=pc_share&xhs_kb_opened=1",
      pathname: "/discovery/item/note-id",
      search: "?xsec_token=private&xsec_source=pc_share&xhs_kb_opened=1",
      hash: ""
    },
    history: {
      state: null,
      replaceState(_state, _title, url) { replacement = url; }
    },
    document: { readyState: "complete" },
    URL,
    URLSearchParams,
    GM_registerMenuCommand() {}
  });
  assert.equal(replacement, "/discovery/item/note-id");
  assert.doesNotMatch(replacement, /xsec_token|xsec_source/);

  replacement = "";
  runInNewContext(userscript, {
    location: {
      origin: "https://www.xiaohongshu.com",
      href: "https://www.xiaohongshu.com/discovery/item/ordinary-note?source=webshare",
      pathname: "/discovery/item/ordinary-note",
      search: "?source=webshare",
      hash: ""
    },
    history: {
      state: null,
      replaceState(_state, _title, url) { replacement = url; }
    },
    document: { readyState: "complete" },
    URL,
    URLSearchParams,
    GM_registerMenuCommand() {}
  });
  assert.equal(replacement, "");
});

test("board lookup resolves the exact signed note inside the caller-created tab", async () => {
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  const userscript = renderUserscriptTemplate(template);
  const noteId = "note-id";
  const boardId = "boardfixture";
  const signedTarget = `https://www.xiaohongshu.com/discovery/item/${noteId}?xsec_token=transient&xsec_source=pc_share&xhs_kb_opened=1`;
  let replacement = "";
  let privilegedTabOpens = 0;
  const anchor = {
    href: `https://www.xiaohongshu.com/board/${boardId}/${noteId}?xsec_token=transient&xsec_source=pc_share`,
    textContent: "精确原帖",
    getAttribute(name) { return name === "title" ? "精确原帖" : ""; },
    closest() { return { textContent: "精确原帖", querySelector: () => null }; }
  };
  const location = {
    origin: "https://www.xiaohongshu.com",
    href: `https://www.xiaohongshu.com/board/${boardId}?source=web_user_page&xhs_kb_open_note=${noteId}`,
    pathname: `/board/${boardId}`,
    search: `?source=web_user_page&xhs_kb_open_note=${noteId}`,
    hash: "",
    replace(url) { replacement = url; }
  };

  runInNewContext(userscript, {
    location,
    history: { state: null, replaceState() {} },
    document: {
      body: { innerText: "" },
      documentElement: { appendChild() {}, scrollHeight: 0 },
      querySelectorAll(selector) { return selector === "a[href]" ? [anchor] : []; },
      getElementById: () => null,
      createElement: () => ({ style: {} })
    },
    window: { scrollTo() {}, scrollBy() {}, setTimeout, clearTimeout },
    innerHeight: 800,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    GM_registerMenuCommand() {},
    GM_openInTab() { privilegedTabOpens += 1; }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(replacement, signedTarget);
  assert.equal(privilegedTabOpens, 0);
});

test("FavSense reuses the exact SOP scanner browser channel and remains user-triggered", async () => {
  const [setup, xhsSetup, start, bridge, daily, localBridgeUtils, readme, publishing, architecture, skill, workflow, fetcher, mediaDownloader, adapter] = await Promise.all([
    read("skills/xhs-favorites-organizer/scripts/setup-autosync.ps1"),
    read("skills/xhs-favorites-organizer/scripts/setup-xhs-downloader.ps1"),
    read("skills/xhs-favorites-organizer/scripts/start-autosync.ps1"),
    read("skills/xhs-favorites-organizer/scripts/bridge-server.py"),
    read("skills/xhs-favorites-organizer/scripts/run-daily.ps1"),
    read("site/local-bridge-utils.mjs"),
    read("README.md"),
    read("docs/PUBLISHING.md"),
    read("docs/ARCHITECTURE.md"),
    read("skills/xhs-favorites-organizer/SKILL.md"),
    read("skills/xhs-favorites-organizer/references/automatic-workflow.md"),
    read("skills/xhs-favorites-organizer/scripts/fetch-xhs-details.py"),
    read("skills/xhs-favorites-organizer/scripts/download-pending-media.py"),
    read("skills/xhs-favorites-organizer/references/xhs-downloader-adapter.md")
  ]);
  assert.doesNotMatch(setup, /install-windows-task\.ps1/);
  assert.match(setup, /Unregister-ScheduledTask/);
  assert.match(setup, /userscript-install-capability/);
  assert.doesNotMatch(setup, /tampermonkey\.net|script_installation\.php/);
  assert.match(setup, /\[string\]\$SopRuntime/);
  const sopRuntimeDefaults = [setup, start, daily];
  for (const source of sopRuntimeDefaults) {
    assert.match(source, /Join-Path \(Split-Path -Parent \$workspacePath\) 'SOP - 小红书'/);
    assert.doesNotMatch(source, /SOP - 小红书[\\/]运行系统/);
  }
  for (const source of [readme, skill]) {
    assert.match(source, /\.\.[\\/]SOP - 小红书"/);
    assert.doesNotMatch(source, /SOP - 小红书[\\/]运行系统/);
  }
  assert.match(setup, /\$secretsPath = Join-Path \$runtimeFullPath '\.secrets'/);
  assert.match(setup, /\$profilePath = Join-Path \$secretsPath 'browser-profiles[\\/]cdp-chrome'/);
  assert.match(setup, /\$portFilePath = Join-Path \$secretsPath 'cdp-port\.txt'/);
  assert.match(setup, /\$scriptsPath = Join-Path \$runtimeFullPath 'scripts'/);
  assert.match(setup, /\$launcherPath = Join-Path \$scriptsPath '启动扫描浏览器\.bat'/);
  assert.match(setup, /\$profilePath, \$scriptsPath/);
  assert.match(setup, /dhdgffkkebhmkfjojejmpbldmpobfkfo/);
  assert.match(setup, /chromewebstore\.google\.com\/detail\/tampermonkey\/\$tampermonkeyId/);
  assert.match(setup, /https:\/\/www\.xiaohongshu\.com\/explore/);
  assert.match(setup, /127\.0\.0\.1:\$port\/json\/version/);
  assert.match(setup, /127\.0\.0\.1:\$port\/json\/new\?/);
  assert.match(setup, /127\.0\.0\.1:\$port\/json\/activate\//);
  assert.match(setup, /Start-Process -FilePath \$Channel\.LauncherPath/);
  assert.match(setup, /FileAttributes\]::ReparsePoint/);
  assert.match(setup, /Resolve-SopBrowserChannel/);
  assert.match(setup, /manifest\.json/);
  assert.match(setup, /ConvertFrom-Json/);
  assert.ok(setup.indexOf("ReparsePoint") < setup.indexOf("$tampermonkeyInstalled"));
  const setupLockInvocation = setup.lastIndexOf("Invoke-FavSenseSetupUnderLock -StateDirectory");
  assert.ok(setupLockInvocation > 0);
  for (const sideEffectMarker of [
    "$channel = Resolve-SopBrowserChannel",
    "Ensure-SopBrowserChannel -Channel $channel",
    "$tampermonkeyInstalled = Test-SopTampermonkeyInstallation",
    "Open-SopBrowserTab -Channel $channel",
    "Get-ScheduledTask -TaskName 'FavSense-Daily'",
    "setup-xhs-downloader.ps1",
    "$tokenBytes ="
  ]) assert.ok(setupLockInvocation < setup.lastIndexOf(sideEffectMarker), sideEffectMarker);
  assert.ok(setup.indexOf("dhdgffkkebhmkfjojejmpbldmpobfkfo") < setup.indexOf("$installBytes"));
  assert.ok(setup.indexOf("$tampermonkeyInstalled") < setup.indexOf("stop-autosync.ps1"));
  assert.ok(setup.indexOf("setup-xhs-downloader.ps1") < setup.indexOf("$tokenBytes"));
  assert.ok(setup.indexOf("setup-xhs-downloader.ps1") < setup.indexOf("$installBytes"));
  assert.ok(setup.indexOf("$installBytes") < setup.indexOf("start-autosync.ps1"));
  assert.ok(setup.indexOf("$installSourceUrl") < setup.indexOf("$startAction"));
  assert.ok(setup.indexOf("$startAction") < setup.lastIndexOf("Invoke-SetupCredentialTransaction"));
  const setupStartAction = setup.match(/\$startAction\s*=\s*\{([\s\S]*?)\r?\n\}/)?.[1] || "";
  assert.match(setupStartAction, /start-autosync\.ps1/);
  assert.equal((setupStartAction.match(/Open-SopBrowserTab/g) || []).length, 2);
  assert.match(setupStartAction, /\$installSourceUrl/);
  assert.match(setupStartAction, /\$xhsLoginUrl/);
  const missingExtensionBranch = setup.match(/if \(-not \$tampermonkeyInstalled\) \{[\s\S]*?\r?\n\s{4}\}/)?.[0] || "";
  assert.match(missingExtensionBranch, /Open-SopBrowserTab[\s\S]*return/);
  assert.doesNotMatch(missingExtensionBranch, /stop-autosync|Remove-Item|installSourceUrl|installBytes|start-autosync|bridge-token/);
  assert.doesNotMatch(setup, /Copy-Item[\s\S]*(Chrome|Cookie|Extensions)/i);
  assert.doesNotMatch(setup, /if \(-not \(Test-Path -LiteralPath \$tokenPath/);
  assert.doesNotMatch(setup, /Start-FavSenseDedicatedChrome|\$chromeRoots|chrome\.exe|\.xhs-favorites[\\/]browser-profile|DevToolsActivePort|--user-data-dir|--remote-debugging-port|--new-window/i);
  assert.match(start, /\[string\]\$SopRuntime/);
  assert.match(start, /--sop-runtime/);
  assert.match(start, /browser_channel_id/);
  assert.doesNotMatch(start, /chrome\.exe|\.xhs-favorites[\\/]browser-profile|DevToolsActivePort|--user-data-dir/i);
  assert.doesNotMatch(bridge, /\.xhs-favorites[\\/]browser-profile|DevToolsActivePort|--user-data-dir/i);
  assert.match(daily, /\/sync\/start/);
  assert.match(daily, /\[string\]\$NoteId/);
  assert.match(daily, /@\{ note_id = \$NoteId \}/);
  assert.match(daily, /NoteId -notmatch '\^\[a-f0-9\]\{24\}\$'/);
  assert.match(daily, /-SopRuntime \$sopRuntimePath/);
  assert.doesNotMatch(daily, /Start-Process|chrome\.exe|xiaohongshu\.com\/board|browser-profile|DevToolsActivePort/);
  assert.doesNotMatch([setup, xhsSetup, start, daily].join("\n"), /Storage\.getCookies|Network\.getAllCookies|Cookies?\b/);
  assert.doesNotMatch([setup, daily, readme, publishing, architecture, skill, workflow].join("\n"), /普通 ?Chrome|regular Chrome|FavSense 专用浏览器|项目私有.*browser/i);
  assert.match([readme, publishing, architecture, skill, workflow].join("\n"), /SOP (?:小红书)?扫描浏览器/);
  assert.match(setup, /No daily or Windows startup task was installed/);
  assert.match(start, /\$expectedProtocolVersion = 11/);
  assert.match(start, /Get-FavSenseRuntimeId/);
  assert.match(start, /runtime_id/);
  assert.match(start, /stop-autosync\.ps1/);
  assert.match(localBridgeUtils, /protocol_version !== 11/);
  assert.match(localBridgeUtils, /browser_session/);
  assert.match(localBridgeUtils, /browserSession\.owner !== "sop-cdp"/);
  assert.match(localBridgeUtils, /typeof browserSession\.ready !== "boolean"/);
  const expectedXhsCommit = "d805ebdd3db53f68137bc2b7a6ed118ce572d09b";
  const pinnedSources = [xhsSetup, fetcher, mediaDownloader, adapter];
  for (const source of pinnedSources) assert.match(source, new RegExp(expectedXhsCommit));
  assert.equal(new Set(pinnedSources.flatMap((source) => source.match(/[a-f0-9]{40}/g) || [])).size, 1);
  assert.match(readme, /开始整理/);
});

test("setup validates the shared SOP channel and only accepts a real Tampermonkey manifest", {
  skip: process.platform !== "win32"
}, () => {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", resolve(root, "skills/xhs-favorites-organizer/tests/test_setup_browser_profile.ps1"),
    "-ScriptPath", resolve(root, "skills/xhs-favorites-organizer/scripts/setup-autosync.ps1")
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Shared SOP runtime validation, dynamic CDP port, single launcher call, tab creation, and Tampermonkey detection were accepted/);
});

test("setup restores the previous private installation when bridge startup fails", {
  skip: process.platform !== "win32"
}, () => {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", resolve(root, "skills/xhs-favorites-organizer/tests/test_setup_transaction.ps1"),
    "-ScriptPath", resolve(root, "skills/xhs-favorites-organizer/scripts/setup-autosync.ps1")
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Credential setup lock, crash-temp cleanup, exact rollback, service restoration, and success commit were accepted/);
});

test("XHS-Downloader setup is pinned, locked and transactional without network access", {
  skip: process.platform !== "win32"
}, () => {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", resolve(root, "skills/xhs-favorites-organizer/tests/test_setup_xhs_downloader.ps1"),
    "-ScriptPath", resolve(root, "skills/xhs-favorites-organizer/scripts/setup-xhs-downloader.ps1")
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Pinned XHS-Downloader checkout, real installer lock, ownership journal crash recovery, and transactional install\/repair cleanup were accepted/);
});

test("bridge startup accepts delayed health after the first five seconds", {
  skip: process.platform !== "win32"
}, () => {
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", resolve(root, "skills/xhs-favorites-organizer/tests/test_start_autosync.ps1"),
    "-ScriptPath", resolve(root, "skills/xhs-favorites-organizer/scripts/start-autosync.ps1")
  ], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Shared SOP identity, delayed readiness, and failed-start process cleanup were accepted/);
});
