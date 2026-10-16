import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";

// The sync service refuses a user script that speaks an older protocol than its own. For that it must
// learn which template the installed script was generated from: every request the script makes names it.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const BASE_CONTRACT = JSON.parse(await read("skills/xhs-diandian-summarize-note/runtime/browser-contract.json"));
const TEMPLATE = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
const EXPORT_MARKER = '  GM_registerMenuCommand("打开拾光台后开始整理"';
const TEMPLATE_VERSION = TEMPLATE.match(/^\/\/ @version\s+(\d+(?:\.\d+){2,})$/m)[1];

function renderUserscript(version) {
  const contract = { enabled: true, cdp_enabled: true, ...BASE_CONTRACT };
  return TEMPLATE
    .replaceAll("__DIANDIAN_MATCH_LINE__", "")
    .replaceAll("__PORT__", "47631")
    .replaceAll("__TOKEN__", "a".repeat(64))
    .replaceAll("__INSTALL_CAPABILITY__", "b".repeat(64))
    .replaceAll("__TEMPLATE_VERSION__", version)
    .replaceAll("__BOARDS__", "{}")
    .replaceAll("__DIANDIAN_CONTRACT__", JSON.stringify(contract))
    .replace(EXPORT_MARKER, `  globalThis.__FAVSENSE_TEST_HOOKS__ = { runBoard };\n${EXPORT_MARKER}`);
}

// A board page whose first request is answered with a failure, so the script stops after a few requests.
async function requestHeadersOfOneBoardPage(version) {
  const sent = [];
  let statusBox = null;
  const context = {
    globalThis: null,
    location: {
      origin: "https://www.xiaohongshu.com", pathname: "/board/board1", search: "",
      href: "https://www.xiaohongshu.com/board/board1", assign() {}, replace() {}
    },
    history: { state: null, replaceState() {} },
    document: {
      body: { innerText: "" },
      documentElement: { scrollHeight: 1200, appendChild(element) { statusBox = element; } },
      getElementById(id) { return statusBox?.id === id ? statusBox : null; },
      createElement: () => ({ id: "", style: {}, textContent: "" }),
      querySelectorAll: () => []
    },
    window: { setTimeout: (callback) => { queueMicrotask(callback); return 1; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, scrollTo() {}, scrollBy() {} },
    innerHeight: 900, URL, URLSearchParams, TextEncoder, crypto: webcrypto,
    setTimeout: (callback) => { queueMicrotask(callback); return 1; },
    clearTimeout() {}, queueMicrotask, GM_registerMenuCommand() {},
    GM_xmlhttpRequest(options) {
      sent.push({ pathname: new URL(options.url).pathname, headers: options.headers });
      queueMicrotask(() => options.onload({ status: 409, responseText: JSON.stringify({ ok: false, error: "stop" }) }));
    }
  };
  context.globalThis = context;
  runInNewContext(renderUserscript(version), context);
  await context.__FAVSENSE_TEST_HOOKS__.runBoard("incremental", "batch1");
  return sent;
}

test("every request the user script makes names the template version it was generated from", async () => {
  const sent = await requestHeadersOfOneBoardPage(TEMPLATE_VERSION);
  assert.ok(sent.length >= 2, "the install check-in and the board request are both sent");
  for (const request of sent) {
    assert.equal(request.headers["X-XHS-Userscript-Version"], TEMPLATE_VERSION, request.pathname);
    assert.equal(request.headers["X-XHS-Bridge-Token"], "a".repeat(64), request.pathname);
  }
});

test("the skill document tells the next reader how an outdated script is detected and fixed", async () => {
  const skill = await read("skills/xhs-favorites-organizer/SKILL.md");
  for (const needle of ["X-XHS-Userscript-Version", "USERSCRIPT_ROUTES", "template_version", "setup-autosync.ps1"]) {
    assert.ok(skill.includes(needle), needle);
  }
});

test("the skill document says the first authorized script request records the version, so a fresh install is never refused up front", async () => {
  const skill = await read("skills/xhs-favorites-organizer/SKILL.md");
  const context = await read("CONTEXT.md");
  for (const [name, text] of [["SKILL.md", skill], ["CONTEXT.md", context]]) {
    assert.ok(text.includes("首个经授权的用户脚本请求"), `${name} names the request that records the version`);
    for (const old of ["没有它或与模板不同", "或记录里没有"]) {
      assert.ok(!text.includes(old), `${name} no longer refuses a start for a version that was never recorded`);
    }
  }
});

test("the version the script reports is filled in at generation, not written into the template", () => {
  assert.match(TEMPLATE, /"__TEMPLATE_VERSION__"/);
});
