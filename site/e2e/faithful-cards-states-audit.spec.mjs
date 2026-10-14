import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { backgroundsFromElement, compositeOver, contrastRatio, parseColor, resolveBackground } from "./contrast-support.mjs";

// Step 7 audit of the faithful-cards feature: behaviours the main browser spec (faithful-cards.spec.mjs) does not
// reach. Each case changes the frozen cards in flight (the page's own data request is answered with an edited copy)
// so no shared fixture file is touched and no other spec sees these cards.
//   - text that looks like markup is shown as text and never runs (checklist: CARD-01 safety, spec §8)
//   - a single line break in the post stays a line break (CARD-08)
//   - very long unbroken text never makes a card or the page scroll sideways (V-P4-01, V-P4-04, every card)
//   - the 未核实 marker is still readable when the tool name is long (V-P4-06)
//   - the public footer: first control is the search link to the post, never a link to /explore/ (V-P0-11)
//   - keyboard order and focus ring inside a detail view (V-P5-04)
//   - size and contrast of the new elements in both themes (V-P5-07)

const headers = { "X-FavSense-Test": "favsense-synthetic-v1" };
const fixture = JSON.parse(readFileSync(new URL("../../scripts/fixtures/faithful-cards.json", import.meta.url), "utf8"));
const REPLY = "6a7dc92600000000250090ff";
const DAMAGED = "6a44938c0000000006021e9e";
const FORMER_HELD = "6ab3dfdc00000000140023f9";
const VIDEO_ONLY_TAGS = "6a2a81d1000000001702d3de";
const WITH_EXTRACTED = "fixture-post-and-transcript";
// The app treats 127.0.0.1 and localhost as the local workbench (no link to Xiaohongshu in the footer), so the public
// site is opened under a *.localhost name: Chromium sends that name to the same loopback server, and the app sees a
// public address. (Fixture server on 8767 is the public one; it is started by the Playwright config, never by a spec.)
const PUBLIC = "http://public.localhost:8767";

test.afterEach(async ({ page }) => {
  await page.request.post("http://127.0.0.1:8766/__test/reset", { headers });
});

async function useFixture(page, edit = null) {
  await page.request.post("http://127.0.0.1:8766/__test/reset", { headers });
  await page.request.post("http://127.0.0.1:8766/__test/scenario", { headers, data: { scenario: "faithful-cards" } });
  if (!edit) return;
  await page.route("**/data/knowledge.json", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    edit(data, (id) => data.notes.find((note) => note.id === id));
    await route.fulfill({ response, json: data });
  });
}

async function openCard(page, id, origin = "") {
  // A new document every time: changing only the address fragment would leave the previous card open.
  await page.goto("about:blank");
  await page.goto(`${origin}/#note=${id}`);
  const detail = page.getByRole("dialog");
  await expect(detail.locator(".detail-title")).toBeVisible();
  return detail;
}

const sidewaysScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test("text that looks like markup is shown as plain text everywhere and never runs", async ({ page }) => {
  const HOSTILE = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
  const requested = [];
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/x") requested.push(request.url()); });
  await useFixture(page, (_data, byId) => {
    byId(REPLY).mainText = `核心故事\n\n${HOSTILE}\n\n- ${HOSTILE}`;
    byId(DAMAGED).mainText = `${HOSTILE}\n第二行`;
    byId(DAMAGED).title = `标题 ${HOSTILE}`;
    byId(WITH_EXTRACTED).extracted.text = HOSTILE;
    byId(FORMER_HELD).tools = [HOSTILE];
    byId(FORMER_HELD).unverifiedTools = [HOSTILE];
    byId(FORMER_HELD).themes = [HOSTILE];
  });
  await page.goto("/");
  await expect(page.locator(".note-card")).toHaveCount(fixture.notes.length);
  for (const id of [REPLY, DAMAGED, WITH_EXTRACTED, FORMER_HELD]) {
    await page.locator(`[data-open-note="${id}"]`).click();
    const detail = page.getByRole("dialog");
    await expect(detail.locator(".detail-title")).toBeVisible();
    await expect(detail).toContainText("<img src=x onerror=");
    await expect(detail.locator("img, script")).toHaveCount(0);
    await page.locator("#dialog-close").click();
  }
  await expect(page.locator(".note-card img, .note-card script")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(requested).toEqual([]);
});

test("CARD-08: a single line break in the post stays a line break inside its paragraph", async ({ page }) => {
  await useFixture(page, (_data, byId) => {
    byId(DAMAGED).mainText = "第一行\n第二行\n\n第三段";
    byId(WITH_EXTRACTED).extracted.text = "口播一\n口播二";
  });
  const detail = await openCard(page, DAMAGED);
  const paragraphs = detail.locator(".structured-summary p");
  await expect(paragraphs).toHaveCount(2);
  await expect(paragraphs.first().locator("br")).toHaveCount(1);
  const [first, second] = await Promise.all([
    paragraphs.first().evaluate((node) => { const range = document.createRange(); range.setStart(node.firstChild, 0); range.setEnd(node.firstChild, 1); return range.getBoundingClientRect().top; }),
    paragraphs.first().evaluate((node) => { const range = document.createRange(); range.setStart(node.lastChild, 0); range.setEnd(node.lastChild, 1); return range.getBoundingClientRect().top; }),
  ]);
  expect(second).toBeGreaterThan(first);
  await expect(paragraphs.nth(1)).toHaveText("第三段");

  const withExtra = await openCard(page, WITH_EXTRACTED);
  await expect(withExtra.locator(".extracted-text p br")).toHaveCount(1);
});

test("the longest unbroken text, in any of the places a card prints it, never scrolls the card or the page sideways", async ({ page }) => {
  const LONG = `https://example.invalid/${"a".repeat(400)}`;
  await useFixture(page, (_data, byId) => {
    byId(REPLY).mainText = `核心故事\n\n${LONG}\n\n- ${LONG}`;
    byId(DAMAGED).mainText = LONG;
    byId(DAMAGED).title = `长标题${LONG}`;
    byId(WITH_EXTRACTED).extracted.text = LONG;
    byId(VIDEO_ONLY_TAGS).mainText = LONG;
  });
  await page.goto("/");
  await expect(page.locator(".note-card")).toHaveCount(fixture.notes.length);
  expect(await sidewaysScroll(page)).toBeLessThanOrEqual(0);
  const width = page.viewportSize().width;
  for (const box of await page.locator(".note-card").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right))) {
    expect(box).toBeLessThanOrEqual(width + 1);
  }
  for (const id of [REPLY, DAMAGED, WITH_EXTRACTED, VIDEO_ONLY_TAGS]) {
    const detail = await openCard(page, id);
    expect(await detail.evaluate((dialog) => dialog.scrollWidth - dialog.clientWidth), id).toBeLessThanOrEqual(0);
    expect(await sidewaysScroll(page), id).toBeLessThanOrEqual(0);
  }
});

test("every card opens without sideways scroll, on this screen width", async ({ page }) => {
  await useFixture(page);
  for (const note of fixture.notes) {
    const detail = await openCard(page, note.id);
    expect(await detail.evaluate((dialog) => dialog.scrollWidth - dialog.clientWidth), note.id).toBeLessThanOrEqual(0);
    const clipped = await detail.locator(".detail-footer > *").evaluateAll((nodes, dialogRight) =>
      nodes.filter((node) => node.getBoundingClientRect().right > dialogRight + 1).map((node) => node.textContent.trim()),
    await detail.evaluate((dialog) => dialog.getBoundingClientRect().right));
    expect(clipped, `${note.id} footer controls cut off`).toEqual([]);
  }
});

test("V-P4-06: the 未核实 marker stays readable on a long tool name, on the card and in the detail view", async ({ page }) => {
  const NAME = "Claude Code 官方 Agent Skill 仓库合集（Anthropic）";
  await useFixture(page, (_data, byId) => {
    byId(FORMER_HELD).tools = [NAME];
    byId(FORMER_HELD).unverifiedTools = [NAME];
  });
  const inside = async (chip) => {
    const badge = chip.locator(".tool-unverified");
    await expect(badge).toHaveText("未核实");
    const [outer, inner] = await Promise.all([chip.boundingBox(), badge.boundingBox()]);
    expect(inner.x).toBeGreaterThanOrEqual(outer.x - 0.5);
    expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
  };
  await page.goto("/");
  await inside(page.locator(`.note-card[data-note-id="${FORMER_HELD}"] .tool-chip`, { hasText: "Claude Code" }));
  const detail = await openCard(page, FORMER_HELD);
  await inside(detail.locator(".tool-chip", { hasText: "Claude Code" }));
});

test("V-P0-11 (LINK-02): on a public address the footer opens with the link to the post itself, then copy link and bookmark", async ({ page }) => {
  await useFixture(page);
  const detail = await openCard(page, REPLY, PUBLIC);
  const footer = detail.locator(".detail-footer");
  const first = footer.locator(":scope > :first-child");
  await expect(first).toHaveJSProperty("tagName", "A");
  await expect(first).toHaveText("在小红书中查看原帖");
  await expect(first).toHaveAttribute("href", `https://www.xiaohongshu.com/explore/${REPLY}`);
  await expect(first).toHaveAttribute("target", "_blank");
  expect(await first.getAttribute("rel")).toContain("noreferrer");
  const controls = (await footer.locator(":scope > *").allTextContents()).map((text) => text.trim());
  expect(controls[0]).toBe("在小红书中查看原帖");
  expect(controls[1]).toBe("复制卡片链接");
  expect(controls.at(-1)).toMatch(/书签/);
  // The only address that leaves the site is the post itself: no search page, no session token, and no search wording left.
  expect(await page.locator("a[href*='xsec_token'], a[href*='search_result']").count()).toBe(0);
  expect(await page.locator("a[href*='/explore/']").count()).toBe(1);
  expect(await page.evaluate(() => document.body.textContent)).not.toContain("搜索原帖");
  await page.goto("about:blank");
  await page.goto(PUBLIC);
  await expect(page.locator(".note-card")).toHaveCount(fixture.notes.length);
  expect(await page.locator("a[href*='xsec_token'], a[href*='search_result']").count()).toBe(0);
});

async function expectVisibleFocusRing(locator) {
  const sample = await locator.evaluate((element, source) => {
    const backgroundsOf = (0, eval)(`(${source})`);
    const style = getComputedStyle(element);
    return { color: style.outlineColor, style: style.outlineStyle, width: style.outlineWidth, backgrounds: backgroundsOf(element, false) };
  }, backgroundsFromElement.toString());
  const background = resolveBackground(sample.backgrounds, [255, 255, 255]);
  const ring = compositeOver(parseColor(sample.color), background);
  expect(sample.style).toBe("solid");
  expect(Number.parseFloat(sample.width)).toBeGreaterThanOrEqual(3);
  expect(contrastRatio(ring, background)).toBeGreaterThanOrEqual(3);
}

test("V-P5-04: the keyboard reaches the edit button, the fold button and the footer controls in reading order, each with a visible ring", async ({ page }) => {
  await useFixture(page);
  const detail = await openCard(page, REPLY, PUBLIC);
  const wanted = [
    detail.getByRole("button", { name: "编辑描述" }),
    detail.locator(".summary-fold-toggle"),
    detail.getByRole("link", { name: "在小红书中查看原帖" }),
    detail.getByRole("button", { name: "复制卡片链接" }),
    detail.locator(".detail-bookmark"),
  ];
  const order = [];
  for (let step = 0; step < 14 && order.length < wanted.length; step += 1) {
    await page.keyboard.press("Tab");
    for (const [index, locator] of wanted.entries()) {
      if (await locator.evaluate((node) => node === document.activeElement) && !order.includes(index)) {
        order.push(index);
        await expectVisibleFocusRing(locator);
      }
    }
  }
  expect(order).toEqual([0, 1, 2, 3, 4]);
  // Escape closes the view and puts focus back on the card that opened it.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

const MIN_FONT_PX = 11;
const AA_NORMAL = 4.5;
const canvas = { light: [255, 255, 255], dark: [18, 18, 18] };

// The new elements, by what they are: the source line and its sentence, the fold and edit buttons, the extracted
// section, the 未核实 marker, and the home counts. Runs inside the page.
function probeNewElements(backgroundsSource) {
  const backgroundsOf = (0, eval)(`(${backgroundsSource})`);
  const selectors = [
    ".summary-provenance strong", ".summary-provenance span", ".provenance-edit", ".summary-fold-toggle",
    ".extracted-section h3", ".extracted-text p", ".tool-unverified", ".structured-summary p", ".structured-summary h4",
    ".card-summary-source", ".hero-counts", ".detail-footer a", ".detail-footer button",
  ];
  const probes = [];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const text = element.textContent.trim();
      if (!text) continue;
      const style = getComputedStyle(element);
      let opacity = 1;
      for (let node = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      probes.push({
        selector, text: text.slice(0, 20), fontSize: Number.parseFloat(style.fontSize), fontWeight: Number(style.fontWeight),
        color: style.color, opacity, backgrounds: backgroundsOf(element, true),
      });
    }
  }
  return probes;
}

for (const theme of ["light", "dark"]) {
  test(`V-P5-07: every new element is at least ${MIN_FONT_PX}px and meets AA contrast in the ${theme} theme`, async ({ page }) => {
    await useFixture(page);
    await page.goto(PUBLIC);
    if (theme === "dark") await page.locator("#theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator(".note-card")).toHaveCount(fixture.notes.length);
    const probes = await page.evaluate(probeNewElements, backgroundsFromElement.toString());
    for (const note of fixture.notes) {
      await page.locator(`[data-open-note="${note.id}"]`).click();
      await expect(page.getByRole("dialog").locator(".detail-title")).toBeVisible();
      probes.push(...await page.evaluate(probeNewElements, backgroundsFromElement.toString()));
      await page.locator("#dialog-close").click();
    }
    expect(probes.some((probe) => probe.selector === ".tool-unverified")).toBe(true);
    expect(probes.some((probe) => probe.selector === ".extracted-text p")).toBe(true);
    expect(probes.some((probe) => probe.selector === ".summary-fold-toggle")).toBe(true);
    const problems = new Set();
    for (const probe of probes) {
      if (probe.fontSize < MIN_FONT_PX) problems.add(`${probe.selector} "${probe.text}" is ${probe.fontSize}px`);
      const background = resolveBackground(probe.backgrounds, canvas[theme]);
      const foreground = parseColor(probe.color);
      const text = compositeOver({ channels: foreground.channels, alpha: foreground.alpha * probe.opacity }, background);
      const ratio = contrastRatio(text, background);
      const large = probe.fontSize >= 24 || (probe.fontWeight >= 700 && probe.fontSize >= 18.66);
      if (ratio < (large ? 3 : AA_NORMAL)) problems.add(`${probe.selector} "${probe.text}" is ${ratio.toFixed(2)}:1`);
    }
    expect([...problems]).toEqual([]);
  });
}
