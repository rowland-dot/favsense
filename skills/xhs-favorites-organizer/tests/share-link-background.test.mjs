import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";

// Covers fetching a note's share link while the scan browser sits behind other windows.
// The page then counts as hidden, so the browser delays its timers far past their due time.
// The note page gets its job from the local sync service by the worker id in its address, does it
// on its own, and reports the result back.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const BROWSER_CONTRACT = {
  enabled: true,
  cdp_enabled: true,
  ...JSON.parse(await read("skills/xhs-diandian-summarize-note/runtime/browser-contract.json"))
};
const NOTE_URL = "https://www.xiaohongshu.com/discovery/item/note-a?xsec_token=current-token";

function renderUserscript(template) {
  return template
    .replaceAll("__DIANDIAN_MATCH_LINE__", "")
    .replaceAll("__PORT__", "47631")
    .replaceAll("__TOKEN__", "a".repeat(64))
    .replaceAll("__INSTALL_CAPABILITY__", "b".repeat(64))
    .replaceAll("__BOARDS__", "{}")
    .replaceAll("__DIANDIAN_CONTRACT__", JSON.stringify(BROWSER_CONTRACT));
}

// Drives the real note-page share worker against a fake sync service on a fake clock.
// timerCost maps a requested timer delay to how far the clock really moves; a hidden page
// is modelled by a cost far above the delay.
async function runShareWorker({
  timerCost = (ms) => ms,
  menuAppearsAfterMs = 0,
  shareControlPresent = true,
  clickReply = { status: 200, body: { ok: true, clicked: true } }
} = {}) {
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  const exportMarker = '  GM_registerMenuCommand("打开拾光台后开始整理"';
  assert.ok(template.includes(exportMarker));
  const userscript = renderUserscript(template)
    .replace(exportMarker, `  globalThis.__FAVSENSE_TEST_HOOKS__ = { waitUntil };\n${exportMarker}`);
  let clock = 1_800_000_000_000;
  let currentTimerCost = timerCost;
  class FakeDate extends Date { static now() { return clock; } }
  const schedule = (callback, delay = 0) => {
    clock += currentTimerCost(delay);
    queueMicrotask(callback);
    return 1;
  };
  let reportResult;
  const reported = new Promise((resolveReport) => { reportResult = resolveReport; });
  let shareClickedAt = null;
  const clickActions = [];
  const shareControl = {
    textContent: "分享", className: "share-icon-container", classList: { contains: () => true },
    getClientRects: () => [{}], getAttribute: () => ""
  };
  const copyItem = {
    textContent: "复制链接",
    dataset: { clipboardText: NOTE_URL },
    getClientRects: () => [{}], getAttribute: () => ""
  };
  const document = {
    body: { innerText: "" },
    documentElement: { appendChild() {}, setAttribute() {}, getAttribute: () => null, removeAttribute() {} },
    getElementById: () => null,
    createElement: () => ({ style: {}, textContent: "" }),
    querySelectorAll(selector) {
      if (shareControlPresent && selector.includes(".share-icon-container")) return [shareControl];
      const menuOpen = shareClickedAt !== null && clock - shareClickedAt >= menuAppearsAfterMs;
      if (menuOpen && selector.includes('[role="menuitem"]')) return [copyItem];
      return [];
    }
  };
  const workerId = "44444444-4444-4444-8444-444444444444";
  const context = {
    globalThis: null,
    Date: FakeDate,
    location: {
      origin: "https://www.xiaohongshu.com",
      pathname: "/discovery/item/note-a",
      search: `?xhs_kb_share_worker=${workerId}`,
      href: NOTE_URL
    },
    history: { state: null, replaceState() {} },
    document,
    window: { setTimeout: schedule, clearTimeout() {} },
    navigator: { clipboard: { readText: async () => "" } },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    URL, URLSearchParams, TextEncoder, crypto: webcrypto,
    setTimeout: schedule, clearTimeout() {}, queueMicrotask,
    GM_registerMenuCommand() {},
    GM_xmlhttpRequest(options) {
      const pathname = new URL(options.url).pathname;
      const body = options.data ? JSON.parse(options.data) : null;
      if (pathname === "/sync/page-task") {
        const task = { stage: "share", run_id: "run", board_id: "board", note_id: "note-a", title: "Title", batch: "batch" };
        queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify({ ok: true, task }) }));
        return;
      }
      if (pathname === "/sync/page-result") {
        // Report in the shape these tests have always read: the link, or the reason it failed.
        reportResult(body.ok ? { type: "share-link", url: body.url } : { type: "share-failed", error: body.error });
      }
      if (pathname === "/sync/diandian-click") {
        clickActions.push(body.action);
        if (body.action === "share") shareClickedAt = clock;
        if (clickReply === "network-error") queueMicrotask(() => options.onerror());
        else if (clickReply === "timeout") queueMicrotask(() => options.ontimeout());
        else queueMicrotask(() => options.onload({ status: clickReply.status, responseText: JSON.stringify(clickReply.body) }));
        return;
      }
      queueMicrotask(() => options.onload({ status: 200, responseText: '{"ok":true}' }));
    }
  };
  context.globalThis = context;
  runInNewContext(userscript, context);
  const hooks = context.__FAVSENSE_TEST_HOOKS__;
  return {
    clickActions,
    hooks,
    now: () => clock,
    setTimerCost(next) { currentTimerCost = next; },
    // The worker starts by itself when the page loads; this waits for what it reports.
    async requestCopy() {
      return reported;
    }
  };
}

test("share link is still copied when a hidden page fires its timers long after they were due", async () => {
  // A background tab's timers fire at most about once a minute; the menu opens a second after the click.
  const worker = await runShareWorker({
    timerCost: (ms) => Math.max(ms, 60_000),
    menuAppearsAfterMs: 1000
  });
  const result = await worker.requestCopy();
  assert.equal(result.type, "share-link", `hidden page failed with ${result.error}`);
  assert.equal(result.url, NOTE_URL);
  assert.deepEqual(worker.clickActions, ["share", "copy"]);
});

test("a wait checks its condition once more when a late timer returns after the deadline", async () => {
  const worker = await runShareWorker();
  const startedAt = worker.now();
  worker.setTimerCost(() => 30_000);
  const outcome = await worker.hooks
    .waitUntil(() => (worker.now() >= startedAt + 5000 ? "ready" : null), 1000, "timed out", 250)
    .then((value) => ({ value }), (error) => ({ error: error.message }));
  assert.deepEqual(outcome, { value: "ready" });
});

test("a share control that never settles stops with its own reason", async () => {
  const worker = await runShareWorker({ shareControlPresent: false });
  const result = await worker.requestCopy();
  assert.equal(result.type, "share-failed");
  assert.equal(result.error, "share-control-timeout");
  assert.deepEqual(worker.clickActions, []);
});

test("a share menu that never shows the copy item stops with its own reason", async () => {
  const worker = await runShareWorker({ menuAppearsAfterMs: Infinity });
  const result = await worker.requestCopy();
  assert.equal(result.type, "share-failed");
  assert.equal(result.error, "share-menu-timeout");
  assert.deepEqual(worker.clickActions, ["share"]);
});

test("a failed request to the local sync service during the share click stops with its own reason", async () => {
  for (const clickReply of ["network-error", "timeout", { status: 503, body: { ok: false } }]) {
    const worker = await runShareWorker({ clickReply });
    const result = await worker.requestCopy();
    assert.equal(result.type, "share-failed");
    assert.equal(result.error, "share-service-request-failed", JSON.stringify(clickReply));
  }
});

test("the userscript version is newer than the release that shipped the foreground wording", async () => {
  // The script has no update URL, so the fix only reaches users if Tampermonkey sees a higher version.
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  const version = template.match(/^\/\/ @version\s+(\S+)$/m)?.[1].split(".").map(Number);
  const shipped = [3, 0, 2];
  const newer = version.findIndex((part, i) => part !== shipped[i]);
  assert.ok(newer !== -1 && version[newer] > shipped[newer], `@version ${version.join(".")} must exceed 3.0.2`);
});

test("a safety stop reported by the local sync service is not relabelled as a service failure", async () => {
  const worker = await runShareWorker({ clickReply: { status: 500, body: { ok: false, error: "xhs-safety-stop" } } });
  const result = await worker.requestCopy();
  assert.equal(result.error, "xhs-safety-stop");
});
