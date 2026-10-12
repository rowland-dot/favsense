import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";

// One round uses one Xiaohongshu page. The user script never opens a tab: on a board page it hands the
// summary plan to the sync service and stops, and on a note page or the DianDian page it does one
// job for a task the sync service registered for that page, then reports the result.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const BASE_CONTRACT = JSON.parse(await read("skills/xhs-diandian-summarize-note/runtime/browser-contract.json"));
const TEMPLATE = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
const EXPORT_MARKER = '  GM_registerMenuCommand("打开拾光台后开始整理"';
const WORKER_ID = "44444444-4444-4444-8444-444444444444";

function contractFor({ cdp }) {
  return { enabled: true, cdp_enabled: cdp, ...BASE_CONTRACT };
}

function renderUserscript(contract, hookNames) {
  return TEMPLATE
    .replaceAll("__DIANDIAN_MATCH_LINE__", contract.cdp_enabled === true ? "" : `// @match        ${contract.ai_chat_url}*`)
    .replaceAll("__PORT__", "47631")
    .replaceAll("__TOKEN__", "a".repeat(64))
    .replaceAll("__INSTALL_CAPABILITY__", "b".repeat(64))
    .replaceAll("__BOARDS__", "{}")
    .replaceAll("__DIANDIAN_CONTRACT__", JSON.stringify(contract))
    .replace(EXPORT_MARKER, `  globalThis.__FAVSENSE_TEST_HOOKS__ = { ${hookNames.join(", ")} };\n${EXPORT_MARKER}`);
}

const schedule = (callback, delay = 0) => {
  if (delay < 5000) queueMicrotask(callback);
  return 1;
};

// A board page holding two scanned notes. `plan` is what the sync service answers to the summary plan.
async function runBoardOnce({ plan, cdp = true, targetNoteId = "" }) {
  const userscript = renderUserscript(contractFor({ cdp }), ["runBoard"]);
  const requests = [];
  const assigned = [];
  const opened = [];
  let statusBox = null;
  const anchors = ["note-a", "note-b"].map((noteId) => ({
    href: `https://www.xiaohongshu.com/board/board1/${noteId}?xsec_token=board-${noteId}&xsec_source=pc_share`,
    textContent: `Title ${noteId}`,
    getAttribute(name) { return name === "title" ? `Title ${noteId}` : ""; },
    querySelector: () => null,
    closest: () => ({ textContent: `Title ${noteId}`, querySelector: () => null })
  }));
  const context = {
    globalThis: null,
    location: {
      origin: "https://www.xiaohongshu.com",
      pathname: "/board/board1",
      search: "",
      href: "https://www.xiaohongshu.com/board/board1",
      assign(url) { assigned.push(url); },
      replace(url) { assigned.push(url); }
    },
    history: { state: null, replaceState() {} },
    document: {
      body: { innerText: "" },
      documentElement: { scrollHeight: 1200, appendChild(element) { statusBox = element; } },
      getElementById(id) { return statusBox?.id === id ? statusBox : null; },
      createElement: () => ({ id: "", style: {}, textContent: "" }),
      querySelectorAll(selector) { return selector === "a[href]" ? anchors : []; }
    },
    window: { setTimeout: schedule, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, scrollTo() {}, scrollBy() {} },
    innerHeight: 900,
    URL,
    URLSearchParams,
    TextEncoder,
    crypto: webcrypto,
    setTimeout: schedule,
    clearTimeout() {},
    queueMicrotask,
    GM_registerMenuCommand() {},
    // The script must not ask for this: any call is a failure, and so is the grant itself.
    GM_openInTab(url) { opened.push(url); throw new Error("the user script must never open a tab"); },
    GM_xmlhttpRequest(options) {
      const pathname = new URL(options.url).pathname;
      const body = options.data ? JSON.parse(options.data) : null;
      requests.push({ pathname, body });
      let payload;
      if (pathname === "/sync/board-context") {
        payload = { ok: true, board: { id: "board1", name: "Board One", advertised_count: 2, ...(targetNoteId ? { target_note_id: targetNoteId } : {}) } };
      } else if (pathname === "/import-sync") {
        payload = { ok: true, scanned: body.urls.length, new: body.urls.length, next_board_id: "board2" };
      } else if (pathname === "/sync/summary-plan") {
        payload = body.note_ids.length === 0 ? { ok: true, enabled: false, abandoned: true, note_ids: [] } : { ok: true, ...plan };
      } else {
        payload = { ok: false, error: `unexpected request: ${pathname}` };
      }
      queueMicrotask(() => options.onload({ status: payload.ok ? 200 : 404, responseText: JSON.stringify(payload) }));
    }
  };
  context.globalThis = context;
  runInNewContext(userscript, context);
  await context.__FAVSENSE_TEST_HOOKS__.runBoard(targetNoteId ? "history" : "incremental", "batch1");
  return { requests, assigned, opened, status: statusBox?.textContent || "" };
}

test("the user script has no way to open a tab and no channel to other tabs", () => {
  assert.doesNotMatch(TEMPLATE, /GM_openInTab/);
  assert.doesNotMatch(TEMPLATE, /BroadcastChannel/);
  assert.doesNotMatch(TEMPLATE, /\/sync\/diandian-cdp/);
  assert.doesNotMatch(TEMPLATE, /GM_setValue|GM_getValue|localStorage|sessionStorage/);
  // A note page does its job from the first moment, before the page has finished loading.
  assert.equal(TEMPLATE.match(/^\/\/ @run-at\s+(\S+)$/m)?.[1], "document-start");
});

test("the user script version is newer than the release that opened a tab for every step", () => {
  // The script has no update URL, so a changed script only reaches the browser if Tampermonkey sees a higher version.
  const version = TEMPLATE.match(/^\/\/ @version\s+(\S+)$/m)?.[1].split(".").map(Number);
  const shipped = [3, 0, 3];
  const differing = version.findIndex((part, index) => part !== shipped[index]);
  assert.ok(differing !== -1 && version[differing] > shipped[differing], `@version ${version.join(".")} must exceed 3.0.3`);
});

test("a board page hands a non-empty plan, with the note titles, to the sync service and stays put", async () => {
  for (const cdp of [true, false]) {
    const result = await runBoardOnce({ cdp, plan: { enabled: true, note_ids: ["note-a", "note-b"], driven: true } });
    const planned = result.requests.find((request) => request.pathname === "/sync/summary-plan" && request.body.note_ids.length);
    assert.deepEqual(planned.body, {
      run_id: "batch1_board1",
      board_id: "board1",
      note_ids: ["note-a", "note-b"],
      titles: { "note-a": "Title note-a", "note-b": "Title note-b" }
    }, `cdp=${cdp}`);
    assert.deepEqual(result.opened, []);
    assert.deepEqual(result.assigned, [], "the sync service moves the page on, so the script must not");
    assert.deepEqual(
      result.requests
        .map((request) => request.pathname)
        .filter((pathname) => !["/install/complete", "/sync/board-context"].includes(pathname)),
      ["/import-sync", "/sync/summary-plan"],
      "no per-note requests belong to the board page any more"
    );
    assert.equal(result.requests.some((request) => request.pathname === "/sync/failure"), false);
  }
});

test("a board page with nothing to summarize still moves on to the next board itself", async () => {
  const result = await runBoardOnce({ plan: { enabled: false, note_ids: [] } });
  assert.deepEqual(result.opened, []);
  assert.equal(result.assigned.length, 1);
  assert.match(result.assigned[0], /^https:\/\/www\.xiaohongshu\.com\/board\/board2\?/);
});

test("a plan the sync service cannot drive is dropped and the board page moves on by itself", async () => {
  const result = await runBoardOnce({ plan: { enabled: true, note_ids: ["note-a", "note-b"] } });
  const plans = result.requests.filter((request) => request.pathname === "/sync/summary-plan");
  assert.deepEqual(plans.map((request) => request.body.note_ids), [["note-a", "note-b"], []]);
  assert.deepEqual(result.opened, []);
  assert.equal(result.assigned.length, 1);
  assert.match(result.assigned[0], /^https:\/\/www\.xiaohongshu\.com\/board\/board2\?/);
});

test("a single-note validation plans exactly the requested note and does not move the page", async () => {
  const result = await runBoardOnce({
    targetNoteId: "note-b",
    plan: { enabled: true, note_ids: ["note-b"], driven: true }
  });
  const planned = result.requests.find((request) => request.pathname === "/sync/summary-plan" && request.body.note_ids.length);
  assert.deepEqual(planned.body.note_ids, ["note-b"]);
  assert.deepEqual(planned.body.titles, { "note-b": "Title note-b" });
  assert.deepEqual(result.assigned, []);
  assert.deepEqual(result.opened, []);
});

// A note page the sync service navigated to: the script asks which task the page has, copies the link,
// and reports. `clickReply` answers the native-click request; `shareControlPresent` models a page whose
// share control never settles.
async function runNotePage({
  cdp = true,
  task = { stage: "share", run_id: "batch1_board1", board_id: "board1", note_id: "note-a" },
  clickReply = { status: 200, body: { ok: true, clicked: true } },
  shareControlPresent = true,
  contract = contractFor({ cdp })
} = {}) {
  const userscript = renderUserscript(contract, ["runShareLinkWorker"]);
  const requests = [];
  const attributes = new Map();
  let shareClicked = false;
  let copyClicked = false;
  let cleanedLocation = "";
  const shareHit = { click() { shareClicked = true; } };
  const copyHit = { click() { copyClicked = true; } };
  const share = {
    textContent: "分享", className: "share-icon-container", classList: { contains: () => true },
    getClientRects: () => [{}], getAttribute: () => "",
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 24, height: 24 }),
    contains: (element) => element === shareHit
  };
  const copy = {
    textContent: "复制链接",
    dataset: { clipboardText: "https://www.xiaohongshu.com/discovery/item/note-a?xsec_token=current-token" },
    getClientRects: () => [{}], getAttribute: () => "",
    getBoundingClientRect: () => ({ left: 10, top: 60, width: 24, height: 24 }),
    contains: (element) => element === copyHit
  };
  const location = {
    origin: "https://www.xiaohongshu.com",
    pathname: "/discovery/item/note-a",
    search: `?xsec_token=current-token&xhs_kb_share_worker=${WORKER_ID}`,
    hash: "",
    href: `https://www.xiaohongshu.com/discovery/item/note-a?xsec_token=current-token&xhs_kb_share_worker=${WORKER_ID}`
  };
  let domReady;
  const context = {
    globalThis: null,
    location,
    history: {
      state: null,
      replaceState(_state, _title, url) {
        cleanedLocation = url;
        location.search = "";
        location.href = `${location.origin}${url}`;
      }
    },
    document: {
      readyState: "loading",
      body: { innerText: "" },
      documentElement: {
        appendChild() {},
        setAttribute(name, value) { attributes.set(name, value); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        removeAttribute(name) { attributes.delete(name); }
      },
      addEventListener(type, listener) { if (type === "DOMContentLoaded") domReady = listener; },
      getElementById: () => null,
      createElement: () => ({ style: {}, textContent: "" }),
      querySelectorAll(selector) {
        if (shareControlPresent && selector.includes(".share-icon-container")) return [share];
        if (shareClicked && selector.includes('[role="menuitem"]')) return [copy];
        return [];
      },
      elementFromPoint: () => (shareClicked ? copyHit : shareHit)
    },
    window: { setTimeout: schedule, clearTimeout() {} },
    navigator: { clipboard: { readText: async () => "" } },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    URL,
    URLSearchParams,
    TextEncoder,
    crypto: webcrypto,
    setTimeout: schedule,
    clearTimeout() {},
    queueMicrotask,
    GM_registerMenuCommand() {},
    GM_openInTab() { throw new Error("the user script must never open a tab"); },
    GM_xmlhttpRequest(options) {
      const pathname = new URL(options.url).pathname;
      const body = options.data ? JSON.parse(options.data) : null;
      requests.push({ pathname, search: new URL(options.url).search, body, method: options.method });
      let reply = { status: 200, body: { ok: true } };
      if (pathname === "/sync/page-task") reply = { status: 200, body: { ok: true, task } };
      if (pathname === "/sync/diandian-click") {
        if (body.action === "share" && clickReply.status === 200) shareClicked = true;
        if (body.action === "copy" && clickReply.status === 200) copyClicked = true;
        reply = clickReply;
      }
      queueMicrotask(() => options.onload({ status: reply.status, responseText: JSON.stringify(reply.body) }));
    }
  };
  context.globalThis = context;
  runInNewContext(userscript, context);
  const results = () => requests.filter((request) => request.pathname === "/sync/page-result");
  for (let attempt = 0; attempt < 200 && !results().length; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  }
  if (domReady) domReady();
  return { requests, results: results(), attributes, cleanedLocation: () => cleanedLocation, clicks: () => ({ share: shareClicked, copy: copyClicked }) };
}

test("a note page the sync service navigated to copies one link by itself and reports it", async () => {
  const page = await runNotePage();
  const task = page.requests.find((request) => request.pathname === "/sync/page-task");
  assert.equal(task.method, "GET");
  assert.equal(task.search, `?worker_id=${WORKER_ID}`);
  assert.deepEqual(
    page.requests.filter((request) => request.pathname === "/sync/diandian-click").map((request) => request.body),
    ["share", "copy"].map((action) => ({
      run_id: "batch1_board1", board_id: "board1", note_id: "note-a", worker_id: WORKER_ID, action
    }))
  );
  assert.equal(page.results.length, 1);
  assert.deepEqual(page.results[0].body, {
    worker_id: WORKER_ID,
    stage: "share",
    ok: true,
    url: "https://www.xiaohongshu.com/discovery/item/note-a?xsec_token=current-token"
  });
  assert.equal(page.attributes.has("data-xhs-kb-share-worker"), false, "the page marker is removed once the result is sent");
  assert.equal(page.cleanedLocation(), "/discovery/item/note-a", "the signed address leaves the page history");
});

test("a note page whose task is for another page or another stage does nothing but report", async () => {
  const page = await runNotePage({ task: { stage: "ai", run_id: "batch1_board1", board_id: "board1", note_id: "note-a" } });
  assert.equal(page.requests.some((request) => request.pathname === "/sync/diandian-click"), false);
  assert.equal(page.results.length, 1);
  assert.equal(page.results[0].body.ok, false);
  assert.equal(page.results[0].body.error, "share-worker-not-ready");
  assert.deepEqual(page.clicks(), { share: false, copy: false });
});

test("a share control that never settles is reported with its own reason, without a click", async () => {
  const contract = contractFor({ cdp: true });
  contract.timings_ms = { ...contract.timings_ms, share_control_wait: 200 };
  const page = await runNotePage({ shareControlPresent: false, contract });
  assert.equal(page.results.length, 1);
  assert.deepEqual({ ok: page.results[0].body.ok, error: page.results[0].body.error }, { ok: false, error: "share-control-timeout" });
  assert.equal(page.requests.some((request) => request.pathname === "/sync/diandian-click"), false);
});

test("a safety stop the sync service saw during the click is reported as a safety stop", async () => {
  const page = await runNotePage({ clickReply: { status: 500, body: { ok: false, error: "xhs-safety-stop" } } });
  assert.equal(page.results.length, 1);
  assert.deepEqual({ ok: page.results[0].body.ok, error: page.results[0].body.error }, { ok: false, error: "xhs-safety-stop" });
});

test("an unreachable sync service during the click is reported as a service failure", async () => {
  const page = await runNotePage({ clickReply: { status: 503, body: { ok: false } } });
  assert.equal(page.results.length, 1);
  assert.deepEqual({ ok: page.results[0].body.ok, error: page.results[0].body.error }, { ok: false, error: "share-service-request-failed" });
});
