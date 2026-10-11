import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

// Covers the page side of "the bridge dropped the connection while a board was processing":
// when the import request fails at the transport level, the page asks the bridge for the run's
// status instead of reporting a failure while the bridge is still working.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const BROWSER_CONTRACT = {
  enabled: true,
  cdp_enabled: true,
  ...JSON.parse(await read("skills/xhs-diandian-summarize-note/runtime/browser-contract.json"))
};
const IMPORT_LIMIT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

function renderUserscript(template) {
  return template
    .replaceAll("__DIANDIAN_MATCH_LINE__", "")
    .replaceAll("__PORT__", "47631")
    .replaceAll("__TOKEN__", "a".repeat(64))
    .replaceAll("__INSTALL_CAPABILITY__", "b".repeat(64))
    .replaceAll("__BOARDS__", "{}")
    .replaceAll("__DIANDIAN_CONTRACT__", JSON.stringify(BROWSER_CONTRACT));
}

// Runs the real runBoard on a fake clock. importReply decides how /import-sync answers;
// statusReplies is the queue of answers for GET /status (the last one repeats).
async function runBoardWith({ importReply, statusReplies = [] }) {
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  const exportMarker = '  GM_registerMenuCommand("打开拾光台后开始整理"';
  assert.ok(template.includes(exportMarker));
  const userscript = renderUserscript(template)
    .replace(exportMarker, `  globalThis.__FAVSENSE_TEST_HOOKS__ = { runBoard };\n${exportMarker}`);
  const requests = [];
  const assigned = [];
  let statusBox = null;
  const messages = [];
  let clock = 1_800_000_000_000;
  class FakeDate extends Date { static now() { return clock; } }
  const schedule = (callback, delay = 0) => {
    clock += delay;
    queueMicrotask(callback);
    return 1;
  };
  const anchor = {
    href: "https://www.xiaohongshu.com/board/board1/note-a?xsec_token=board-token&xsec_source=pc_share",
    textContent: "Title note-a",
    getAttribute(name) { return name === "title" ? "Title note-a" : ""; },
    querySelector: () => null,
    closest() { return { textContent: "Title note-a", querySelector: () => null }; }
  };
  let statusCalls = 0;
  let abandonAttempts = 0;
  const context = {
    globalThis: null,
    Date: FakeDate,
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
      createElement: () => {
        const element = { id: "", style: {} };
        let text = "";
        Object.defineProperty(element, "textContent", {
          get: () => text,
          set: (value) => { text = value; messages.push(value); }
        });
        return element;
      },
      querySelectorAll(selector) { return selector === "a[href]" ? [anchor] : []; }
    },
    window: { setTimeout: schedule, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, scrollTo() {}, scrollBy() {} },
    innerHeight: 800,
    URL,
    URLSearchParams,
    TextEncoder,
    setTimeout: schedule,
    clearTimeout() {},
    queueMicrotask,
    GM_registerMenuCommand() {},
    GM_xmlhttpRequest(options) {
      const url = new URL(options.url);
      const body = options.data ? JSON.parse(options.data) : null;
      requests.push({ method: options.method, pathname: url.pathname, search: url.search, body, at: clock });
      const reply = (response) => queueMicrotask(() => options.onload({
        status: response.status, responseText: JSON.stringify(response.body)
      }));
      if (url.pathname === "/sync/board-context") {
        reply({ status: 200, body: { ok: true, board: { id: "board1", name: "Board One", advertised_count: 1 } } });
      } else if (url.pathname === "/import-sync") {
        if (importReply === "transport-error") queueMicrotask(() => options.onerror());
        else reply(importReply);
      } else if (url.pathname === "/status") {
        const answer = statusReplies[Math.min(statusCalls, statusReplies.length - 1)];
        statusCalls += 1;
        if (answer === "transport-error") queueMicrotask(() => options.onerror());
        else if (answer?.http) reply(answer.http);
        else reply({ status: 200, body: { ok: true, ...answer } });
      } else if (url.pathname === "/sync/summary-plan") {
        if (body?.note_ids?.length === 0) abandonAttempts += 1;
        // The DianDian plan is optional: make it unavailable so the run moves on right after the core import.
        reply(body?.note_ids?.length || abandonAttempts < 2
          ? { status: 503, body: { ok: false, error: "optional plan unavailable" } }
          : { status: 200, body: { ok: true, enabled: false, note_ids: [], abandoned: true } });
      } else if (url.pathname === "/sync/failure") {
        reply({ status: 200, body: { ok: true, recorded: false } });
      } else {
        reply({ status: 500, body: { ok: false, error: `unexpected ${url.pathname}` } });
      }
    }
  };
  context.globalThis = context;
  runInNewContext(userscript, context);
  await context.__FAVSENSE_TEST_HOOKS__.runBoard("incremental", "batch1");
  return {
    requests,
    assigned,
    status: statusBox?.textContent || "",
    messages,
    statusRequests: requests.filter((request) => request.pathname === "/status"),
    failurePosts: requests.filter((request) => request.pathname === "/sync/failure"),
    importRequest: requests.find((request) => request.pathname === "/import-sync")
  };
}

const COMPLETED = {
  state: "completed", run_id: "batch1_board1", scanned: 1, new: 1, next_board_id: "board2"
};

test("a dropped import connection waits for the bridge to finish and then continues to the next board", async () => {
  const result = await runBoardWith({
    importReply: "transport-error",
    statusReplies: [{ state: "running" }, { state: "running" }, COMPLETED]
  });
  assert.equal(result.requests.filter((request) => request.pathname === "/import-sync").length, 1);
  assert.equal(result.statusRequests.length, 3);
  assert.ok(result.statusRequests.every((request) => (
    request.method === "GET" && request.search === "?run_id=batch1_board1"
  )));
  assert.equal(result.failurePosts.length, 0);
  assert.match(result.assigned.at(-1), /^https:\/\/www\.xiaohongshu\.com\/board\/board2\?/);
  assert.doesNotMatch(result.status, /无法连接/);
});

test("while the bridge reports running, the page says the local service is still working on the board", async () => {
  const result = await runBoardWith({
    importReply: "transport-error",
    statusReplies: [{ state: "running" }, COMPLETED]
  });
  assert.ok(result.messages.some((message) => /本地(?:同步)?服务.*仍在处理/.test(message)), result.messages.join(" | "));
  assert.equal(result.failurePosts.length, 0);
});

test("a dropped import connection shows the bridge's own error when the run failed", async () => {
  const result = await runBoardWith({
    importReply: "transport-error",
    statusReplies: [{ state: "failed", run_id: "batch1_board1", error: "organizer failed: disk full" }]
  });
  assert.equal(result.statusRequests.length, 1);
  assert.match(result.status, /organizer failed: disk full/);
  assert.deepEqual(result.assigned, []);
});

test("a dropped import connection shows the bridge's safety-stop error and does not move on", async () => {
  const result = await runBoardWith({
    importReply: "transport-error",
    statusReplies: [{
      state: "safety-stopped", run_id: "batch1_board1", next_board_id: null,
      error: "小红书触发安全限制，已停止本轮且不会继续重试"
    }]
  });
  assert.match(result.status, /安全限制/);
  assert.deepEqual(result.assigned, []);
});

test("the page stops waiting once the import time limit passes while the bridge still says running", async () => {
  const result = await runBoardWith({
    importReply: "transport-error",
    statusReplies: [{ state: "running" }]
  });
  assert.deepEqual(result.assigned, []);
  assert.match(result.status, /无法连接本地同步服务/);
  const importAt = result.importRequest.at;
  const lastPollAt = result.statusRequests.at(-1).at;
  assert.ok(lastPollAt - importAt <= IMPORT_LIMIT_MS + POLL_INTERVAL_MS);
  assert.ok(result.statusRequests.length > 10);
});

test("an unreachable bridge is reported at once instead of being polled", async () => {
  const result = await runBoardWith({
    importReply: "transport-error",
    statusReplies: ["transport-error"]
  });
  assert.equal(result.statusRequests.length, 1);
  assert.match(result.status, /无法连接本地同步服务/);
  assert.deepEqual(result.assigned, []);
});

test("a run the bridge never started is reported at once", async () => {
  const result = await runBoardWith({
    importReply: "transport-error",
    statusReplies: [{ http: { status: 404, body: { ok: false, state: "not_started" } } }]
  });
  assert.equal(result.statusRequests.length, 1);
  assert.match(result.status, /无法连接本地同步服务/);
});

test("a JSON error reply from the bridge is a real answer and is not followed up with status polling", async () => {
  const result = await runBoardWith({
    importReply: { status: 500, body: { ok: false, error: "KeyError: 'x'" } },
    statusReplies: [COMPLETED]
  });
  assert.equal(result.statusRequests.length, 0);
  assert.match(result.status, /KeyError/);
});
