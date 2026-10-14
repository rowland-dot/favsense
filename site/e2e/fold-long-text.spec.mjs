import { test, expect } from "@playwright/test";

// Issue 114 (owner ruling 2026-10-14, faithful-cards brief Decision 3): long video transcripts and picture text fold
// behind the same "展开全文 · N 字" button as a DianDian reply, and short ones show in full. A card prints this text in
// two places: as the card's own text (when the post has none) and as a labelled section after the post's text.
// Each case edits the frozen cards in flight, so no shared fixture file is touched. The suite runs on a desktop and
// a phone project, so every case below is checked on both.

const headers = { "X-FavSense-Test": "favsense-synthetic-v1" };
const FOLDED_HEIGHT = 421; // the fold's 420px limit plus a pixel of rounding, as in faithful-cards.spec.mjs
const WITH_EXTRACTED = "fixture-post-and-transcript"; // post text + an extracted video transcript
const VIDEO_AS_TEXT = "6a2a81d1000000001702d3de"; // tags-only video post: the transcript is the card's text
const IMAGE_AS_TEXT = "fixture-image-text"; // tags-only picture post: the picture text is the card's text

const LONG = Array.from({ length: 40 }, (_, index) => `第${index + 1}段口播：这一段讲的是怎么把收藏的内容整理成可以反复查看的知识卡片，并且保持原话不改动。`).join("\n\n");
const SHORT = "这是一句很短的口播。";

test.afterEach(async ({ page }) => {
  // The test server is shared by every spec: put it back on its default data so later specs never see these cards.
  await page.request.post("http://127.0.0.1:8766/__test/reset", { headers });
});

async function openCard(page, id, edit) {
  await page.request.post("http://127.0.0.1:8766/__test/reset", { headers });
  await page.request.post("http://127.0.0.1:8766/__test/scenario", { headers, data: { scenario: "faithful-cards" } });
  await page.route("**/data/knowledge.json", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    edit(data.notes.find((note) => note.id === id));
    await route.fulfill({ response, json: data });
  });
  // A new document every time: changing only the address fragment would leave the previous card open.
  await page.goto("about:blank");
  await page.goto(`/#note=${id}`);
  const detail = page.getByRole("dialog");
  await expect(detail.locator(".detail-title")).toBeVisible();
  return detail;
}

// Where the text is printed: the labelled section after the post's text, or the card's own text block.
const PLACES = [
  { name: "a video transcript after the post's text", id: WITH_EXTRACTED, section: true, set: (note, text) => { note.extracted.text = text; } },
  { name: "picture text after the post's text", id: WITH_EXTRACTED, section: true, set: (note, text) => { note.extracted = { kind: "image-text", text }; } },
  { name: "a video transcript that is the card's own text", id: VIDEO_AS_TEXT, section: false, set: (note, text) => { note.mainText = text; } },
  { name: "picture text that is the card's own text", id: IMAGE_AS_TEXT, section: false, set: (note, text) => { note.mainText = text; } },
];

for (const place of PLACES) {
  test(`${place.name}: long text starts folded and opens and closes on the button`, async ({ page }) => {
    const detail = await openCard(page, place.id, (note) => place.set(note, LONG));
    const length = LONG.trim().length;
    const scope = place.section ? detail.locator(".extracted-section") : detail;
    const body = scope.locator(".summary-fold-body");
    const toggle = scope.locator(".summary-fold-toggle");
    const height = async () => (await body.boundingBox()).height;

    await expect(toggle).toHaveText(`展开全文 · ${length} 字`);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(await height()).toBeLessThanOrEqual(FOLDED_HEIGHT);

    await toggle.click();
    await expect(toggle).toHaveText("收起");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await height()).toBeGreaterThan(FOLDED_HEIGHT);
    await expect(body).toContainText("第40段口播");

    await toggle.click();
    await expect(toggle).toHaveText(`展开全文 · ${length} 字`);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(await height()).toBeLessThanOrEqual(FOLDED_HEIGHT);
  });

  test(`${place.name}: short text is shown whole with no fold button`, async ({ page }) => {
    const detail = await openCard(page, place.id, (note) => place.set(note, SHORT));
    await expect(detail).toContainText(SHORT);
    await expect(detail.locator(".summary-fold-toggle")).toHaveCount(0);
    // It is inside the same fold as a long one, settled open: no fade at the bottom.
    await expect(detail.locator(".summary-fold-body")).toHaveCSS("mask-image", "none");
  });
}

test("the fold button is reachable on the screen the reader is using", async ({ page }) => {
  const detail = await openCard(page, WITH_EXTRACTED, (note) => { note.extracted.text = LONG; });
  const toggle = detail.locator(".extracted-section .summary-fold-toggle");
  await toggle.scrollIntoViewIfNeeded();
  const box = await toggle.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
});

test("an opened transcript stays open when the card is re-drawn, and folds again after closing", async ({ page }) => {
  const detail = await openCard(page, WITH_EXTRACTED, (note) => { note.extracted.text = LONG; });
  const length = LONG.trim().length;
  const toggle = detail.locator(".extracted-section .summary-fold-toggle");
  await toggle.click();
  await expect(toggle).toHaveText("收起");
  // Adding a bookmark re-draws the open card.
  await detail.getByRole("button", { name: "添加书签" }).click();
  await expect(detail.getByRole("button", { name: "已加书签" })).toBeVisible();
  await expect(detail.locator(".extracted-section .summary-fold-toggle")).toHaveText("收起");

  await page.getByRole("button", { name: "关闭详情" }).click();
  await page.locator(`[data-open-note="${WITH_EXTRACTED}"]`).click();
  await expect(page.getByRole("dialog").locator(".extracted-section .summary-fold-toggle")).toHaveText(`展开全文 · ${length} 字`);
});

test("the post's own text next to a transcript is not folded, however long", async ({ page }) => {
  const detail = await openCard(page, WITH_EXTRACTED, (note) => { note.mainText = LONG; note.extracted.text = SHORT; });
  await expect(detail.locator(".structured-summary")).toContainText("第40段口播");
  await expect(detail.locator(".structured-summary.summary-fold-body")).toHaveCount(0);
  await expect(detail.locator(".summary-fold-toggle")).toHaveCount(0);
});
