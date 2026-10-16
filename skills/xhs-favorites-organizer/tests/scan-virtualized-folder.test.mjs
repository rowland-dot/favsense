import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";

// A favourite-folder page keeps only about 30 posts in the page at a time and loads more as the reader
// nears the bottom. A history scan that jumps straight to the bottom therefore never reads the posts in
// between, and how many it misses depends on timing. The scan must walk the folder from the top in small
// steps, so that every post is inside the page at some check.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const BASE_CONTRACT = JSON.parse(await read("skills/xhs-diandian-summarize-note/runtime/browser-contract.json"));
const TEMPLATE = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
const EXPORT_MARKER = '  GM_registerMenuCommand("打开拾光台后开始整理"';

const VIEWPORT = 900;
const ROW = 160; // height of one post in the fake folder page
const IN_PAGE = 30; // posts the page keeps around the viewport
const BATCH = 50; // posts the page loads each time the reader comes within one viewport of the bottom
const FOLDER = 150; // about the size of the largest real folder (158)
const RUNAWAY_MOVES = 3000;

const noteIds = (count) => Array.from({ length: count }, (_, index) => `note-${String(index).padStart(3, "0")}`);

function renderUserscript() {
  const contract = { enabled: true, cdp_enabled: true, ...BASE_CONTRACT };
  return TEMPLATE
    .replaceAll("__DIANDIAN_MATCH_LINE__", "")
    .replaceAll("__PORT__", "47631")
    .replaceAll("__TOKEN__", "a".repeat(64))
    .replaceAll("__INSTALL_CAPABILITY__", "b".repeat(64))
    .replaceAll("__TEMPLATE_VERSION__", "0.0.0")
    .replaceAll("__BOARDS__", "{}")
    .replaceAll("__DIANDIAN_CONTRACT__", JSON.stringify(contract))
    .replace(EXPORT_MARKER, `  globalThis.__FAVSENSE_TEST_HOOKS__ = { runBoard };\n${EXPORT_MARKER}`);
}

// Runs one board page through the real user script. The fake folder holds `total` posts; `captchaAfterMoves`
// makes a captcha appear after that many scroll moves; `targetNoteId` makes it a single-note check.
// `hiddenAtStart` puts the folder page in a background tab: it has never been laid out, so it cannot scroll and
// its height stays one screen, until the sync service brings it to the front (`frontWorks` says whether that
// request has any effect). `hiddenAfterMoves` sends the page to the background after that many scroll moves.
// Time is virtual: every sleep the script asks for moves the clock, so a long wait costs nothing.
async function scanFolder({
  mode = "history",
  total,
  advertisedCount = 0,
  captchaAfterMoves = Infinity,
  targetNoteId = "",
  hiddenAtStart = false,
  hiddenAfterMoves = Infinity,
  frontWorks = true
}) {
  const clock = { now: 1_700_000_000_000 };
  const startedAt = clock.now;
  const schedule = (callback, delay = 0) => {
    clock.now += delay;
    if (delay < 5000) queueMicrotask(callback);
    return 1;
  };
  const state = { loaded: Math.min(BATCH, total), scrollY: 0, moves: [], visible: !hiddenAtStart, laidOut: !hiddenAtStart };
  const requests = [];
  let statusBox = null;
  const pageHeight = () => (state.laidOut ? state.loaded * ROW : VIEWPORT);
  const scrollTo = (top) => {
    if (!state.visible) return; // a page in a background tab does not scroll
    if (state.moves.length >= RUNAWAY_MOVES) throw new Error("the scan never finished");
    const to = Math.max(0, Math.min(top, pageHeight() - VIEWPORT));
    state.moves.push({ from: state.scrollY, to });
    state.scrollY = to;
    if (state.scrollY + 2 * VIEWPORT >= pageHeight()) state.loaded = Math.min(total, state.loaded + BATCH);
    if (state.moves.length === hiddenAfterMoves) state.visible = false;
  };
  const ids = noteIds(total);
  const anchorFor = (index) => ({
    href: `https://www.xiaohongshu.com/board/board1/${ids[index]}?xsec_token=token-${ids[index]}&xsec_source=pc_share`,
    textContent: `Title ${ids[index]}`,
    getAttribute: (name) => (name === "title" ? `Title ${ids[index]}` : ""),
    querySelector: () => null,
    closest: () => ({ textContent: `Title ${ids[index]}`, querySelector: () => null })
  });
  const postsInPage = () => {
    const first = Math.max(0, Math.floor(state.scrollY / ROW) - 5);
    return Array.from({ length: Math.max(0, Math.min(IN_PAGE, state.loaded - first)) }, (_, offset) => anchorFor(first + offset));
  };
  const context = {
    globalThis: null,
    Date: { now: () => clock.now },
    location: {
      origin: "https://www.xiaohongshu.com",
      pathname: "/board/board1",
      search: "",
      href: "https://www.xiaohongshu.com/board/board1",
      assign() {},
      replace() {}
    },
    history: { state: null, replaceState() {} },
    document: {
      body: { innerText: "" },
      get visibilityState() { return state.visible ? "visible" : "hidden"; },
      documentElement: { get scrollHeight() { return pageHeight(); }, appendChild(element) { statusBox = element; } },
      getElementById(id) { return statusBox?.id === id ? statusBox : null; },
      createElement: () => ({ id: "", style: {}, textContent: "" }),
      querySelectorAll(selector) {
        if (selector === "a[href]") return postsInPage();
        if (selector.includes("captcha") && state.moves.length >= captchaAfterMoves) {
          return [{ hidden: false, getAttribute: () => null }];
        }
        return [];
      }
    },
    window: {
      get scrollY() { return state.scrollY; },
      scrollTo(options) { scrollTo(options.top); },
      scrollBy(options) { scrollTo(state.scrollY + options.top); },
      setTimeout: schedule,
      clearTimeout() {},
      setInterval: () => 1,
      clearInterval() {}
    },
    innerHeight: VIEWPORT,
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
      let payload = { ok: true };
      if (pathname === "/sync/board-context") {
        payload = { ok: true, board: { id: "board1", name: "Folder", advertised_count: advertisedCount,...(targetNoteId ? { target_note_id: targetNoteId } : {}) } };
      } else if (pathname === "/sync/scan-page-front") {
        if (frontWorks) {
          state.visible = true;
          state.laidOut = true;
        }
        payload = { ok: true, activated: frontWorks };
      } else if (pathname === "/import-sync") {
        payload = { ok: true, scanned: body.urls.length, new: body.urls.length };
      } else if (pathname === "/sync/summary-plan") {
        payload = targetNoteId
          ? { ok: true, enabled: true, note_ids: [targetNoteId], driven: true }
          : { ok: true, enabled: false, note_ids: [] };
      }
      queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify(payload) }));
    }
  };
  context.globalThis = context;
  runInNewContext(renderUserscript(), context);
  await context.__FAVSENSE_TEST_HOOKS__.runBoard(mode, "batch1");
  const imported = requests.find((request) => request.pathname === "/import-sync");
  return {
    requests,
    moves: state.moves,
    importedIds: imported ? imported.body.urls.map((url) => new URL(url).pathname.split("/").pop()) : null,
    reachedBottom: state.scrollY + VIEWPORT >= pageHeight(),
    allLoaded: state.loaded === total,
    fronts: requests.filter((request) => request.pathname === "/sync/scan-page-front").map((request) => request.body),
    elapsedMs: clock.now - startedAt
  };
}

test("a history scan lists every post of a folder whose page keeps only about 30 posts in the page", async () => {
  const result = await scanFolder({ total: FOLDER });
  assert.ok(result.importedIds, "the scan reached the import");
  assert.deepEqual([...result.importedIds].sort(), noteIds(FOLDER));
  assert.ok(result.allLoaded, "the page was scrolled until it had loaded the whole folder");
});

test("a history scan walks in steps of at most half a viewport and ends at the bottom", async () => {
  const result = await scanFolder({ total: FOLDER });
  const largest = Math.max(...result.moves.map((move) => Math.abs(move.to - move.from)));
  assert.ok(result.moves.length > 20, `the scan moved ${result.moves.length} times`);
  assert.ok(largest <= VIEWPORT / 2, `the largest step was ${largest}px, a viewport is ${VIEWPORT}px`);
  assert.ok(result.reachedBottom, "the scan ended with the bottom of the page in view");
});

test("a history scan is not cut off at 200 posts", async () => {
  const result = await scanFolder({ total: 260 });
  assert.equal(result.importedIds?.length, 260);
  assert.deepEqual([...result.importedIds].sort(), noteIds(260));
});

test("a history scan does not stop at the post count the folder list advertises", async () => {
  // The folder list page has been read as 0 for every folder; a wrong small count must not cut a scan short either.
  const result = await scanFolder({ total: FOLDER, advertisedCount: 10 });
  assert.deepEqual([...result.importedIds].sort(), noteIds(FOLDER));
});

test("a safety signal during the walk stops it at once and nothing is imported", async () => {
  const result = await scanFolder({ total: FOLDER, captchaAfterMoves: 6 });
  assert.equal(result.importedIds, null, "no import request is made");
  assert.equal(result.moves.length, 6, "no scroll move follows the signal");
  const failure = result.requests.find((request) => request.pathname === "/sync/failure");
  assert.equal(failure?.body.error, "xhs-safety-stop");
});

test("a single-note check finds a post from the middle of the folder", async () => {
  const result = await scanFolder({ total: FOLDER, targetNoteId: "note-080" });
  assert.deepEqual(result.importedIds, ["note-080"]);
});

test("an incremental scan still reads only what is on screen and does not scroll", async () => {
  const result = await scanFolder({ mode: "incremental", total: FOLDER });
  assert.deepEqual(result.moves, []);
  assert.deepEqual([...result.importedIds].sort(), noteIds(IN_PAGE));
});

// A tab in the background is not laid out, so the folder page cannot scroll and its height stays one screen.
// The first full sync with the half-screen walk listed 30 of 158 posts for that reason: the idle check
// ended the walk after the first screen. The walk needs the page in front, and says so when it cannot get it.

test("a folder page that starts in a background tab is brought to the front and then every post is listed", async () => {
  const result = await scanFolder({ total: FOLDER, hiddenAtStart: true });
  assert.ok(result.fronts.length >= 1, "the sync service was asked to show the page");
  assert.deepEqual(result.fronts[0], { run_id: "batch1_board1", board_id: "board1" });
  assert.deepEqual([...(result.importedIds ?? [])].sort(), noteIds(FOLDER));
});

test("a page sent to a background tab part way through the walk is brought back and the walk goes on", async () => {
  const result = await scanFolder({ total: FOLDER, hiddenAfterMoves: 20 });
  assert.ok(result.fronts.length >= 1, "the sync service was asked to show the page again");
  assert.deepEqual([...(result.importedIds ?? [])].sort(), noteIds(FOLDER));
});

test("a folder page that never reaches the front stops the round with a reason and imports nothing", async () => {
  const result = await scanFolder({ total: FOLDER, hiddenAtStart: true, frontWorks: false });
  assert.equal(result.importedIds, null, "a first screen is not listed as if it were the folder");
  assert.ok(result.fronts.length > 1, "it kept asking while it waited");
  assert.deepEqual(result.moves, []);
  assert.ok(result.elapsedMs <= 2 * 60 * 1000, `it waited ${result.elapsedMs} ms`);
  const failure = result.requests.find((request) => request.pathname === "/sync/failure");
  assert.match(failure?.body.error ?? "", /后台/);
});

test("a single-note check on a background page is brought to the front before it walks", async () => {
  const result = await scanFolder({ total: FOLDER, targetNoteId: "note-080", hiddenAtStart: true });
  assert.ok(result.fronts.length >= 1, "the sync service was asked to show the page");
  assert.deepEqual(result.importedIds, ["note-080"]);
});

test("a folder page that is in front all along never asks for it", async () => {
  const result = await scanFolder({ total: FOLDER });
  assert.deepEqual(result.fronts, []);
});

test("an incremental scan does not ask for the front: it reads the links a background page already holds", async () => {
  const result = await scanFolder({ mode: "incremental", total: FOLDER, hiddenAtStart: true });
  assert.deepEqual(result.fronts, []);
  assert.deepEqual([...result.importedIds].sort(), noteIds(IN_PAGE));
});
