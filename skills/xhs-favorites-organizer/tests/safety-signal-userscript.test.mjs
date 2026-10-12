import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

// The userscript keeps its own browser-side copy of the rule that recognises a platform block.
// It is held to the same table as the Python rule and the bridge's injected check, for the
// contexts it reads: a visible prompt on a board page, and a JSON script element.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (path) => readFile(resolve(root, path), "utf8");
const table = JSON.parse(await read("skills/xhs-favorites-organizer/test-fixtures/safety-signal-cases.json"));
const BROWSER_CONTRACT = {
  enabled: true,
  cdp_enabled: true,
  ...JSON.parse(await read("skills/xhs-diandian-summarize-note/runtime/browser-contract.json"))
};

async function loadAssertSafePage() {
  const template = await read("skills/xhs-favorites-organizer/assets/xhs-favorites.user.js.template");
  const exportMarker = '  GM_registerMenuCommand("打开拾光台后开始整理"';
  assert.ok(template.includes(exportMarker));
  const userscript = template
    .replaceAll("__DIANDIAN_MATCH_LINE__", "")
    .replaceAll("__PORT__", "47631")
    .replaceAll("__TOKEN__", "a".repeat(64))
    .replaceAll("__INSTALL_CAPABILITY__", "b".repeat(64))
    .replaceAll("__BOARDS__", "{}")
    .replaceAll("__DIANDIAN_CONTRACT__", JSON.stringify(BROWSER_CONTRACT))
    .replace(exportMarker, `  globalThis.__FAVSENSE_TEST_HOOKS__ = { assertSafePage };\n${exportMarker}`);
  const shown = { context: null, text: "" };
  const element = (text) => ({
    innerText: text, textContent: text, hidden: false, getAttribute: () => null
  });
  const context = {
    globalThis: null,
    location: { origin: "https://www.xiaohongshu.com", pathname: "/", search: "", href: "https://www.xiaohongshu.com/" },
    history: { state: null, replaceState() {} },
    document: {
      body: { innerText: "" },
      documentElement: { scrollHeight: 1000, appendChild() {} },
      getElementById: () => null,
      createElement: () => ({ id: "", style: {}, textContent: "" }),
      querySelectorAll(selector) {
        if (selector.includes('role="alert"')) return shown.context === "page-shell" ? [element(shown.text)] : [];
        if (selector.includes("application/json")) return shown.context === "page-script" ? [element(shown.text)] : [];
        return [];
      }
    },
    window: { setTimeout() { return 1; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, scrollTo() {}, scrollBy() {} },
    innerHeight: 800,
    URL, URLSearchParams, TextEncoder,
    setTimeout() { return 1; },
    clearTimeout() {},
    queueMicrotask,
    GM_registerMenuCommand() {},
    GM_xmlhttpRequest() {}
  };
  context.globalThis = context;
  runInNewContext(userscript, context);
  return {
    isBlocked(caseContext, text) {
      shown.context = caseContext;
      shown.text = text;
      try {
        context.__FAVSENSE_TEST_HOOKS__.assertSafePage();
        return false;
      } catch (error) {
        assert.equal(error.code, "xhs-safety-stop");
        return true;
      }
    }
  };
}

for (const caseContext of ["page-shell", "page-script"]) {
  test(`the userscript's copy of the block rule follows the table for ${caseContext}`, async () => {
    const page = await loadAssertSafePage();
    const cases = table.cases.filter((entry) => entry.context === caseContext);
    assert.ok(cases.some((entry) => entry.blocked) && cases.some((entry) => !entry.blocked));
    for (const entry of cases) {
      assert.equal(page.isBlocked(caseContext, entry.text), entry.blocked, `${entry.id}: ${entry.why}`);
    }
  });
}

test("a page showing nothing is not a block", async () => {
  const page = await loadAssertSafePage();
  assert.equal(page.isBlocked("none", ""), false);
});
