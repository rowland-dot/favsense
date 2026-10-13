import { test, expect } from "@playwright/test";
import { backgroundsFromElement, compositeOver, contrastRatio, parseColor, resolveBackground } from "./contrast-support.mjs";

// Every visible piece of text on the page, in both views and both themes, must be at least 11px
// and must reach WCAG AA contrast against the colour it actually sits on.
// Decorative glyphs drawn by ::before/::after, icons and disabled controls are not text and are not judged for contrast.

const MIN_FONT_PX = 11;
const AA_NORMAL = 4.5;
const AA_LARGE = 3;
const origins = { manager: "http://127.0.0.1:8766", public: "http://127.0.0.1:8767" };
const canvas = { light: [255, 255, 255], dark: [18, 18, 18] };
const noteIds = ["note-accepted", "note-pending", "note-diandian", "note-evidence"];

// Runs inside the page: lists every visible element that carries text of its own.
function collectTextProbes({ scopeSelector, backgroundsSource }) {
  const backgroundsFromElement = (0, eval)(`(${backgroundsSource})`);
  const scope = document.querySelector(scopeSelector);
  const skippedTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "OPTION", "OPTGROUP"]);
  const textInputTypes = new Set(["search", "text", "email", "url", "tel", "password"]);
  const describe = (node) => {
    const classes = [...node.classList].map((name) => `.${name}`).join("");
    return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${classes}`;
  };
  const probes = [];
  for (const element of scope.querySelectorAll("*")) {
    if (skippedTags.has(element.tagName) || element.closest("svg")) continue;
    let text = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent.trim()).join("");
    let style = getComputedStyle(element);
    if (element.tagName === "SELECT") text = element.selectedOptions[0]?.textContent.trim() || "";
    if (element.tagName === "TEXTAREA" || (element.tagName === "INPUT" && textInputTypes.has(element.type))) {
      text = element.value;
      if (!text && element.placeholder) {
        text = element.placeholder;
        style = getComputedStyle(element, "::placeholder");
      }
    }
    if (!text) continue;
    const box = element.getBoundingClientRect();
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || box.width <= 0 || box.height <= 0) continue;
    let opacity = 1;
    for (let node = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    probes.push({
      where: `${element.parentElement ? `${describe(element.parentElement)} > ` : ""}${describe(element)}`,
      text: text.slice(0, 24),
      fontSize: Number.parseFloat(style.fontSize),
      fontWeight: Number(style.fontWeight),
      color: style.color,
      opacity,
      disabled: element.matches(":disabled") || Boolean(element.closest("fieldset:disabled")),
      backgrounds: backgroundsFromElement(element, true),
    });
  }
  return probes;
}

async function scan(page, surface, scopeSelector) {
  const probes = await page.evaluate(collectTextProbes, { scopeSelector, backgroundsSource: backgroundsFromElement.toString() });
  return probes.map((probe) => ({ ...probe, surface }));
}

async function resetFixture(page) {
  await page.goto(`${origins.manager}/__health`);
  await page.evaluate(() => fetch("/__test/reset", { method: "POST", headers: { "X-FavSense-Test": "favsense-synthetic-v1" } }));
}

async function textProbesForEveryView(page, kind, theme) {
  await resetFixture(page);
  await page.goto(origins[kind]);
  // Switch the way a visitor does: with the site's own theme button, which sets data-theme on <html>.
  if (theme === "dark") await page.locator("#theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator(".note-card")).toHaveCount(noteIds.length);
  const probes = [...await scan(page, "知识卡", "body")];

  for (const id of noteIds) {
    await page.locator(`[data-open-note="${id}"]`).click();
    await expect(page.locator("#detail-dialog")).toHaveAttribute("open", "");
    probes.push(...await scan(page, `详情 ${id}`, "#detail-dialog"));
    await page.locator("#dialog-close").click();
    await expect(page.locator("#detail-dialog")).not.toHaveAttribute("open", "");
  }

  await page.getByRole("button", { name: "资源索引", exact: true }).click();
  await expect(page.locator(".resource-card").first()).toBeVisible();
  probes.push(...await scan(page, "资源索引", "body"));

  await page.getByRole("button", { name: "同步设置", exact: true }).click();
  if (kind === "manager") await expect(page.locator("#manual-sync-control")).toBeVisible();
  probes.push(...await scan(page, "同步设置", "body"));
  return probes;
}

// One line per distinct problem, so a repeated card does not bury the report.
function summarise(findings) {
  const counts = new Map();
  for (const line of findings) counts.set(line, (counts.get(line) || 0) + 1);
  return [...counts].map(([line, count]) => `${line} ×${count}`).sort();
}

test("the font-size floor token and the text-colour tokens are defined", async ({ page }) => {
  // Without this, a misspelt or missing token makes the browser fall back to inherited text and the checks below pass by accident.
  await page.goto(origins.public);
  const tokens = await page.evaluate(
    (names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(name).trim()])),
    ["--text-xs", "--text-red", "--text-blue", "--fill-blue"]
  );
  expect(tokens["--text-xs"]).toMatch(/px$/);
  expect(Number.parseFloat(tokens["--text-xs"])).toBeGreaterThanOrEqual(MIN_FONT_PX);
  for (const name of ["--text-red", "--text-blue", "--fill-blue"]) expect(tokens[name], name).not.toBe("");
});

for (const width of [390, 320]) {
  test(`the tab bar does not cover the brand, the open-source link or the theme button at ${width}px wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(origins.public);
    await expect(page.locator(".note-card").first()).toBeVisible();
    const boxes = await page.evaluate(() => {
      const box = (selector) => {
        const element = document.querySelector(selector);
        if (!element || !element.checkVisibility()) return null;
        const { left, top, right, bottom } = element.getBoundingClientRect();
        return { left, top, right, bottom };
      };
      return { nav: box(".primary-nav"), others: Object.fromEntries([".brand", "#creator-space-link", "#theme-toggle"].map((selector) => [selector, box(selector)])) };
    });
    expect(boxes.nav).not.toBeNull();
    expect(boxes.others[".brand"]).not.toBeNull();
    expect(boxes.others["#theme-toggle"]).not.toBeNull();
    const overlaps = Object.entries(boxes.others)
      .filter(([, other]) => other && other.left < boxes.nav.right && other.right > boxes.nav.left && other.top < boxes.nav.bottom && other.bottom > boxes.nav.top)
      .map(([selector]) => selector);
    expect(overlaps).toEqual([]);
  });

  test(`each top navigation tab stays on one line at ${width}px wide`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(origins.public);
    await expect(page.locator(".note-card").first()).toBeVisible();
    const lines = await page.locator(".primary-nav .nav-button").evaluateAll((buttons) => buttons.map((button) => {
      const range = document.createRange();
      range.selectNodeContents(button);
      return { label: button.textContent.trim(), lines: new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size };
    }));
    expect(lines).toEqual([
      { label: "知识卡", lines: 1 },
      { label: "资源索引", lines: 1 },
      { label: "同步设置", lines: 1 },
    ]);
  });
}

for (const kind of Object.keys(origins)) {
  for (const theme of ["light", "dark"]) {
    test(`${kind} view keeps every visible text at ${MIN_FONT_PX}px or larger in the ${theme} theme`, async ({ page }) => {
      const probes = await textProbesForEveryView(page, kind, theme);
      const tooSmall = probes
        .filter((probe) => probe.fontSize < MIN_FONT_PX)
        .map((probe) => `${probe.surface}: ${probe.where} "${probe.text}" is ${probe.fontSize}px`);
      expect(summarise(tooSmall)).toEqual([]);
    });

    test(`${kind} view keeps every visible text at WCAG AA contrast in the ${theme} theme`, async ({ page }) => {
      const probes = await textProbesForEveryView(page, kind, theme);
      const weak = [];
      for (const probe of probes) {
        if (probe.disabled) continue;
        const background = resolveBackground(probe.backgrounds, canvas[theme]);
        const foreground = parseColor(probe.color);
        const text = compositeOver({ channels: foreground.channels, alpha: foreground.alpha * probe.opacity }, background);
        const ratio = contrastRatio(text, background);
        const large = probe.fontSize >= 24 || (probe.fontWeight >= 700 && probe.fontSize >= 18.66);
        const required = large ? AA_LARGE : AA_NORMAL;
        if (ratio < required) weak.push(`${probe.surface}: ${probe.where} "${probe.text}" is ${ratio.toFixed(2)}:1, needs ${required}:1`);
      }
      expect(summarise(weak)).toEqual([]);
    });
  }
}
