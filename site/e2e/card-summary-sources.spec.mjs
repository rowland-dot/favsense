import { test, expect } from "@playwright/test";

// Issue #99: what a knowledge card shows as its summary, and the label that says where it came from.
// The cards are real published cards frozen in scripts/fixtures/card-summary-sources.json.

const headers = { "X-FavSense-Test": "favsense-synthetic-v1" };
const DIANDIAN_CARD = "6a7dc92600000000250090ff";

// The test server is shared by every spec: put it back on its default data so later specs never see these cards.
test.afterEach(async ({ page }) => {
  await page.request.post("http://127.0.0.1:8766/__test/reset", { headers });
});

async function openCard(page, noteId) {
  await page.request.post("http://127.0.0.1:8766/__test/reset", { headers });
  await page.request.post("http://127.0.0.1:8766/__test/scenario", { headers, data: { scenario: "card-sources" } });
  await page.goto(`/#note=${noteId}`);
  const detail = page.getByRole("dialog");
  await expect(detail.locator(".detail-title")).toBeVisible();
  return detail;
}

test("a card with a usable DianDian reply shows only that reply, formatted, without its opening line", async ({ page }) => {
  const detail = await openCard(page, DIANDIAN_CARD);
  const body = detail.locator(".structured-summary");

  await expect(body.locator("h4", { hasText: "核心故事" })).toHaveCount(1);
  await expect(detail.locator(".summary-provenance strong")).toHaveText("点点 AI 深度总结");

  // The reply's own sub-headings and its four questions come out as headings and a list; the words are unchanged.
  const questions = body.locator("h4", { hasText: "让 AI 敢下判断的 4 个问题" }).locator("xpath=following-sibling::*[1]");
  await expect(questions).toHaveJSProperty("tagName", "OL");
  await expect(questions.locator("li")).toHaveText(["哪条数据异常了？", "为什么会异常？", "对账号影响有多大？", "下周具体发什么、怎么改？"]);

  // Neither the stored opening line nor the curation summary that used to stand in for the reply.
  await expect(detail).not.toContainText("根据你引用的笔记");
  await expect(detail).not.toContainText("作者披露的三天搭建");
});

// Every card in the frozen set, with the label its source earns and wording it must never carry.
const FAILURE_WORDING = ["失败", "未尝试", "需重新核验", "尚未开始深度整理", "总结已保存，尚未完成证据核验"];
const SOURCE_CASES = [
  { name: "usable DianDian reply, later run failed", id: "69f693110000000037037db1", label: "点点 AI 深度总结" },
  { name: "no DianDian reply, never asked (video)", id: "6a4afd18000000001101092b", label: "本机视频证据整理", text: "EdgeOne Makers", explanation: /本机保存的视频转写/ },
  { name: "no DianDian reply, run failed (video)", id: "6a2a81d1000000001702d3de", label: "本机视频证据整理", text: "last30days Skill", explanation: /本机保存的视频转写/ },
  { name: "no DianDian reply, round stopped before it (video)", id: "6a2e130d0000000007011c4a", label: "本机视频证据整理", explanation: /本机保存的视频转写/ },
  { name: "no usable DianDian reply, reply saved but refused (video)", id: "6a3fdfbf000000001101ca6f", label: "本机视频证据整理", explanation: /本机保存的视频转写/ },
  { name: "no usable DianDian reply, stale record (image-text)", id: "6a5626a70000000006031d80", label: "本机图片文字整理", explanation: /本机保存的图片文字/ },
  { name: "no DianDian reply (image-text)", id: "6a4ccf88000000001101d144", label: "本机图片文字整理", explanation: /本机保存的图片文字/ },
  { name: "evidence incomplete, not started (video)", id: "6a5b1bee000000000f007345", label: "证据未补齐，暂不发布", text: "最强AI已无需确认", explanation: /已完成复核/ },
  { name: "evidence incomplete, reply saved (video)", id: "6a3a0665000000002201a15d", label: "证据未补齐，暂不发布", explanation: /已完成复核/ },
  { name: "evidence incomplete, reply saved (image-text)", id: "67c81ab6000000002901724c", label: "证据未补齐，暂不发布", explanation: /已完成复核/ },
  { name: "original post no longer reachable", id: "6a1fd8a2000000003601ff7a", label: "已完成（原帖不可访问）", text: "丧尸清道夫" },
];

for (const source of SOURCE_CASES) {
  test(`the label matches where the text came from: ${source.name}`, async ({ page }) => {
    const detail = await openCard(page, source.id);
    const provenance = detail.locator(".summary-provenance");
    await expect(provenance.locator("strong")).toHaveText(source.label);
    if (source.explanation) await expect(provenance).toContainText(source.explanation);
    if (source.text) await expect(detail.locator(".structured-summary")).toContainText(source.text);
    if (source.label !== "点点 AI 深度总结") await expect(provenance).not.toContainText("来自点点");
    for (const wording of FAILURE_WORDING) await expect(provenance).not.toContainText(wording);
  });
}

test("the detail view is compact: no heading row, no repeated evidence section, no next-step box", async ({ page }) => {
  const detail = await openCard(page, DIANDIAN_CARD);
  for (const gone of ["核心结论", "原帖摘要", "具体用法", "整理依据"]) {
    await expect(detail.getByRole("heading", { name: gone })).toHaveCount(0);
  }
  await expect(detail.locator(".action-box")).toHaveCount(0);
  await expect(detail).not.toContainText("下一步");
  await expect(detail).not.toContainText("原视频和分析画面只保存在本机");

  // The title is no longer held to a narrow column.
  await expect(detail.locator(".detail-title")).toHaveCSS("max-width", "none");

  // The edit button sits inside the source box, at its right end, and still opens the editor.
  const provenance = detail.locator(".summary-provenance");
  const edit = provenance.getByRole("button", { name: "编辑描述" });
  await expect(edit).toBeVisible();
  const [box, label, button] = await Promise.all([provenance.boundingBox(), provenance.locator("strong").boundingBox(), edit.boundingBox()]);
  expect(button.x).toBeGreaterThan(label.x + label.width);
  expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width);
  expect(button.y).toBeGreaterThanOrEqual(box.y);
  expect(button.y + button.height).toBeLessThanOrEqual(box.y + box.height);
  await edit.click();
  await expect(detail.getByRole("textbox", { name: "知识卡描述" })).toBeVisible();
});

test("the detail view never scrolls sideways", async ({ page }) => {
  const detail = await openCard(page, DIANDIAN_CARD);
  expect(await detail.evaluate((dialog) => dialog.scrollWidth - dialog.clientWidth)).toBeLessThanOrEqual(0);
});

test("the card preview in the grid shows the same text and label as the detail view", async ({ page }) => {
  await page.request.post("http://127.0.0.1:8766/__test/reset", { headers });
  await page.request.post("http://127.0.0.1:8766/__test/scenario", { headers, data: { scenario: "card-sources" } });
  await page.goto("/");
  const card = (id) => page.locator(`.note-card[data-note-id="${id}"]`);

  await expect(card(DIANDIAN_CARD).locator(".card-summary-source")).toContainText("点点 AI 深度总结");
  await expect(card(DIANDIAN_CARD).locator(".card-summary")).toContainText("作者原本每月做小红书账号复盘");
  await expect(card(DIANDIAN_CARD).locator(".card-summary")).not.toContainText("根据你引用的笔记");
  await expect(card(DIANDIAN_CARD).locator(".card-summary")).not.toContainText("作者披露的三天搭建");

  await expect(card("6a2a81d1000000001702d3de").locator(".card-summary-source")).toContainText("本机视频证据整理");
  await expect(card("6a4ccf88000000001101d144").locator(".card-summary-source")).toContainText("本机图片文字整理");
  await expect(card("6a5b1bee000000000f007345").locator(".card-summary-source")).toContainText("证据未补齐，暂不发布");
  for (const wording of FAILURE_WORDING) {
    await expect(page.locator(".note-card .card-summary-source").filter({ hasText: wording })).toHaveCount(0);
  }
});

test("a personal revision still wins over the DianDian reply, and restoring brings the reply back", async ({ page }) => {
  const detail = await openCard(page, DIANDIAN_CARD);
  await detail.getByRole("button", { name: "编辑描述" }).click();
  const editor = detail.getByRole("textbox", { name: "知识卡描述" });
  // The editor starts from the text on screen: the reply without its opening line.
  await expect(editor).toHaveValue(/^核心故事/);
  await editor.fill("我自己改写的一句话。");
  await detail.getByRole("button", { name: "保存修改" }).click();

  await expect(detail.locator(".structured-summary")).toHaveText("我自己改写的一句话。");
  await expect(detail.locator(".summary-fold")).toHaveCount(0);
  await expect(detail).toContainText("已使用你的个人修订");
  await expect(page.locator(`.note-card[data-note-id="${DIANDIAN_CARD}"] .card-summary-source`)).toContainText("个人修订 · 点点 AI 深度总结");

  await detail.getByRole("button", { name: "编辑描述" }).click();
  await detail.getByRole("button", { name: "恢复系统版本" }).click();
  await expect(detail.locator(".summary-fold-toggle")).toHaveText("展开全文 · 805 字");
  await expect(detail.locator(".structured-summary h4", { hasText: "核心故事" })).toHaveCount(1);
});

test("a short DianDian reply that fits is shown whole, with no fold button", async ({ page }) => {
  const detail = await openCard(page, "6a4a67ca000000001603daba");
  const body = detail.locator(".structured-summary");
  await expect(body.locator("h4", { hasText: "项目简介" })).toHaveCount(1);
  await expect(detail.locator(".summary-fold-toggle")).toHaveCount(0);
  expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  await expect(detail.locator(".summary-fold-body")).toHaveCSS("mask-image", "none");
});

test("an opened reply stays open when the card is re-drawn, and folds again after closing", async ({ page }) => {
  const detail = await openCard(page, DIANDIAN_CARD);
  const toggle = detail.locator(".summary-fold-toggle");
  await toggle.click();
  await expect(toggle).toHaveText("收起");
  // Adding a bookmark re-draws the open card.
  await detail.getByRole("button", { name: "添加书签" }).click();
  await expect(detail.getByRole("button", { name: "已加书签" })).toBeVisible();
  await expect(detail.locator(".summary-fold-toggle")).toHaveText("收起");

  await page.getByRole("button", { name: "关闭详情" }).click();
  await page.locator(`[data-open-note="${DIANDIAN_CARD}"]`).click();
  await expect(page.getByRole("dialog").locator(".summary-fold-toggle")).toHaveText("展开全文 · 805 字");
});

test("the DianDian reply starts folded and opens to the full text and back", async ({ page }) => {
  const detail = await openCard(page, DIANDIAN_CARD);
  const body = detail.locator(".summary-fold-body");
  const toggle = detail.locator(".summary-fold-toggle");
  const height = async () => (await body.boundingBox()).height;

  await expect(toggle).toHaveText("展开全文 · 805 字");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await height()).toBeLessThanOrEqual(421);
  expect(await body.evaluate((element) => element.scrollHeight)).toBeGreaterThan(421);

  await toggle.click();
  await expect(toggle).toHaveText("收起");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await height()).toBeGreaterThan(421);
  // Nothing is cut off any more: the box is as tall as its text.
  expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);

  await toggle.click();
  await expect(toggle).toHaveText("展开全文 · 805 字");
  expect(await height()).toBeLessThanOrEqual(421);
});
