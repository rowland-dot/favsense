import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// Faithful cards (spec AC-CARD): every card shows its own text with one honest source line.
// The cards are frozen in scripts/fixtures/faithful-cards.json: four real cards from the owner-approved mockups
// (docs/designs/2026-10-14-card-design-rewrite.html, cases 1 to 4) plus synthetic ones for the other states.

const headers = { "X-FavSense-Test": "favsense-synthetic-v1" };
const fixture = JSON.parse(readFileSync(new URL("../../scripts/fixtures/faithful-cards.json", import.meta.url), "utf8"));
const card = (id) => fixture.notes.find((note) => note.id === id);
const REPLY = "6a7dc92600000000250090ff";
const DAMAGED = "6a44938c0000000006021e9e";
const FORMER_HELD = "6ab3dfdc00000000140023f9";
const VIDEO_ONLY_TAGS = "6a2a81d1000000001702d3de";
const BANNERS = ["证据未补齐", "暂不发布", "总结未通过审核", "本篇总结失败", "本次未尝试", "需重新核验", "尚未开始深度整理", "总结已保存，尚未完成证据核验", "待审核"];
const DAMAGED_SENTENCE = "保存的点点回复缺了内容（是我们采集出错），下一轮重新获取；在那之前先显示原帖自己的文字。";
const UNREACHABLE_SENTENCE = "原帖可能已被作者隐藏或删除；已保留现有记录并结束补证，不作为正式核验结果发布。";

// The test server is shared by every spec: put it back on its default data so later specs never see these cards.
test.afterEach(async ({ page }) => {
  await page.request.post("http://127.0.0.1:8766/__test/reset", { headers });
});

async function useFixture(page) {
  await page.request.post("http://127.0.0.1:8766/__test/reset", { headers });
  await page.request.post("http://127.0.0.1:8766/__test/scenario", { headers, data: { scenario: "faithful-cards" } });
}

async function openCard(page, id) {
  await useFixture(page);
  // A new document every time: changing only the address fragment would leave the previous card open.
  await page.goto("about:blank");
  await page.goto(`/#note=${id}`);
  const detail = page.getByRole("dialog");
  await expect(detail.locator(".detail-title")).toBeVisible();
  return detail;
}

const sourceLabel = (detail) => detail.locator(".summary-provenance strong");
const explanation = (detail) => detail.locator(".summary-provenance span");

test("no card in the grid carries a status banner, with or without a filter", async ({ page }) => {
  await useFixture(page);
  await page.goto("/");
  await expect(page.locator(".note-card")).toHaveCount(fixture.notes.length);
  const labels = await page.locator(".note-card .card-summary-source").allTextContents();
  for (const label of labels) for (const banner of BANNERS) expect(label).not.toContain(banner);
  expect(await page.evaluate(() => document.body.textContent)).not.toContain("证据未补齐，暂不发布");

  await page.locator('#kind-filter [data-kind="Note"]').click();
  await page.locator('#category-list [data-category="AI自媒体"]').click();
  const expected = fixture.notes.filter((note) => note.kind === "Note" && note.category === "AI自媒体");
  await expect(page.locator(".note-card")).toHaveCount(expected.length);
  expect(expected.length).toBeGreaterThan(0);
  for (const label of await page.locator(".note-card .card-summary-source").allTextContents()) {
    for (const banner of BANNERS) expect(label).not.toContain(banner);
  }
});

test("every card's detail title is the card's own title", async ({ page }) => {
  await useFixture(page);
  await page.goto("/");
  for (const note of fixture.notes) {
    await page.locator(`[data-open-note="${note.id}"]`).click();
    await expect(page.getByRole("dialog").locator(".detail-title")).toHaveText(note.title);
    await page.locator("#dialog-close").click();
    await expect(page.getByRole("dialog")).toBeHidden();
  }
});

test("CARD-03: a complete DianDian reply is the text, folded, with its length stated once", async ({ page }) => {
  const detail = await openCard(page, REPLY);
  const length = card(REPLY).mainText.trim().length;
  await expect(sourceLabel(detail)).toHaveText("点点 AI 深度总结");
  await expect(explanation(detail)).toContainText(`点点 AI 的完整回复，原文未改动，共 ${length} 字`);
  await expect(detail).not.toContainText("根据你引用的笔记");

  const body = detail.locator(".summary-fold-body");
  const toggle = detail.locator(".summary-fold-toggle");
  const height = async () => (await body.boundingBox()).height;
  await expect(toggle).toHaveText(`展开全文 · ${length} 字`);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await height()).toBeLessThanOrEqual(421);

  await toggle.click();
  await expect(toggle).toHaveText("收起");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(await height()).toBeGreaterThan(421);
  // The headings and the list of four questions are all there once unfolded.
  await expect(detail.locator(".structured-summary h4", { hasText: "核心故事" })).toHaveCount(1);
  const questions = detail.locator(".structured-summary h4", { hasText: "让 AI 敢下判断的 4 个问题" }).locator("xpath=following-sibling::*[1]");
  await expect(questions).toHaveJSProperty("tagName", "OL");
  await expect(questions.locator("li")).toHaveText(["哪条数据异常了？", "为什么会异常？", "对账号影响有多大？", "下周具体发什么、怎么改？"]);

  await toggle.click();
  await expect(toggle).toHaveText(`展开全文 · ${length} 字`);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  expect(await height()).toBeLessThanOrEqual(421);

  for (const topic of card(REPLY).themes) await expect(detail.locator(".tool-chip", { hasText: topic })).toHaveCount(1);
});

test("CARD-04: a cut reply gives way to the post's own text, and says whose fault the cut is", async ({ page }) => {
  const detail = await openCard(page, DAMAGED);
  await expect(sourceLabel(detail)).toHaveText("原帖公开文字");
  await expect(explanation(detail)).toHaveText(DAMAGED_SENTENCE);
  await expect(detail.locator(".structured-summary")).toHaveText(card(DAMAGED).mainText, { useInnerText: true });
  await expect(detail.locator(".summary-fold-toggle")).toHaveCount(0);
  for (const topic of ["Agent Skill", "Skill仓库", "内容创作"]) await expect(detail.locator(".tool-chip", { hasText: topic })).toHaveCount(1);
});

test("CARD-05: a formerly held card shows its reply, and a tool nobody confirmed is marked 未核实", async ({ page }) => {
  const detail = await openCard(page, FORMER_HELD);
  await expect(sourceLabel(detail)).toHaveText("点点 AI 深度总结");
  const chip = detail.locator(".tool-chip", { hasText: "Seedance 导演 Skill" });
  await expect(chip.locator(".tool-unverified")).toHaveText("未核实");
  for (const banner of BANNERS) await expect(detail).not.toContainText(banner);
});

test("CARD-06: a tags-only video post shows its transcript and says why", async ({ page }) => {
  const detail = await openCard(page, VIDEO_ONLY_TAGS);
  await expect(sourceLabel(detail)).toHaveText("视频转写与画面文字");
  await expect(explanation(detail)).toContainText("原帖只有话题标签、没有正文");
  expect(await detail.locator(".structured-summary").innerText()).toMatch(/^记住这个地表超强AI搜索引擎项目/);

  const withDamagedReply = await openCard(page, "fixture-damaged-transcript");
  await expect(explanation(withDamagedReply)).toContainText("保存的点点回复缺了内容（是我们采集出错），下一轮重新获取；原帖只有话题标签");
});

test("CARD-07 [mockup state: posttranscript]: the post's text first, then the transcript as its own labelled section above the footer", async ({ page }) => {
  const detail = await openCard(page, "fixture-post-and-transcript");
  await expect(detail.locator(".structured-summary")).toHaveText(card("fixture-post-and-transcript").mainText, { useInnerText: true });
  const section = detail.locator('section[aria-label="视频转写与画面文字"]');
  await expect(section.locator("h3")).toHaveText("视频转写与画面文字");
  await expect(section).toContainText(card("fixture-post-and-transcript").extracted.text);
  const [text, extra, footer] = await Promise.all([
    detail.locator(".structured-summary").boundingBox(), section.boundingBox(), detail.locator(".detail-footer").boundingBox(),
  ]);
  expect(extra.y).toBeGreaterThan(text.y + text.height - 1);
  expect(footer.y).toBeGreaterThan(extra.y + extra.height - 1);
});

test("CARD-08: paragraph breaks in the text become separate paragraphs", async ({ page }) => {
  const detail = await openCard(page, "fixture-paragraphs");
  await expect(detail.locator(".structured-summary p")).toHaveText(["第一段。", "第二段。"]);
});

test("an unreachable post keeps its own source label and sentence", async ({ page }) => {
  const detail = await openCard(page, "fixture-unreachable");
  await expect(sourceLabel(detail)).toHaveText("已完成（原帖不可访问）");
  await expect(explanation(detail)).toHaveText(UNREACHABLE_SENTENCE);
});

test("text taken from pictures is labelled as picture text", async ({ page }) => {
  const detail = await openCard(page, "fixture-image-text");
  await expect(sourceLabel(detail)).toHaveText("图片文字");
});

test("CARD-09: the home page counts what the reader can actually find", async ({ page }) => {
  await useFixture(page);
  await page.goto("/");
  const { noteCount, replyCount, transcriptCount } = fixture.meta;
  await expect(page.locator("#hero-counts")).toHaveText(`${noteCount} 条收藏 · ${replyCount} 条有完整点点总结 · ${transcriptCount} 条有视频转写`);
  const text = await page.evaluate(() => document.body.textContent);
  expect(text).not.toContain("条完成深度解读");
  expect(text).not.toContain("已完成视频内容核验");

  await page.locator('[data-view="method"]').click();
  await expect(page.locator("#proof-replies")).toHaveText(String(replyCount));
  await expect(page.locator("#proof-transcripts")).toHaveText(String(transcriptCount));
  const cells = await page.locator(".method-proof > div").evaluateAll((nodes) => nodes.map((node) => {
    const box = node.getBoundingClientRect();
    return { top: Math.round(box.top), left: box.left, right: box.right };
  }));
  expect(cells).toHaveLength(4);
  if (page.viewportSize().width > 840) {
    expect(new Set(cells.map((cell) => cell.top)).size).toBe(1);
    const note = await page.locator(".method-proof > p").boundingBox();
    expect(note.x).toBeGreaterThanOrEqual(Math.max(...cells.map((cell) => cell.right)) - 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("the footer controls and the source box keep their places", async ({ page, context }) => {
  const detail = await openCard(page, REPLY);
  // Local workbench: the first control is a button, never a link to the post.
  const first = detail.locator(".detail-footer > :first-child");
  await expect(first).toHaveJSProperty("tagName", "BUTTON");
  await expect(first).toHaveText(/打开原帖|请先启动 FavSense 本地服务/);
  const controls = (await detail.locator(".detail-footer > *").allTextContents()).map((text) => text.trim());
  expect(controls.indexOf("复制卡片链接")).toBeGreaterThan(0);
  expect(controls.at(-1)).toMatch(/书签/);
  expect(await detail.locator("a[href*='/explore/']").count()).toBe(0);

  // Public origin: same data, same order after the first control; the first control is the link to the post itself (LINK-02).
  await page.goto(`http://public.localhost:8767/#note=${REPLY}`);
  const publicDetail = page.getByRole("dialog");
  await expect(publicDetail.locator(".detail-title")).toBeVisible();
  await expect(publicDetail.locator(".detail-footer").getByRole("button", { name: "复制卡片链接" })).toBeVisible();
  await expect(publicDetail.locator(".detail-footer .detail-bookmark")).toBeVisible();
  const postLink = publicDetail.locator(".detail-footer > :first-child");
  await expect(postLink).toHaveText("在小红书中查看原帖");
  await expect(postLink).toHaveAttribute("href", `https://www.xiaohongshu.com/explore/${REPLY}`);
  expect(await page.locator("a[href*='xsec_token'], a[href*='search_result']").count()).toBe(0);

  // Source box: the edit button sits inside it, to the right of the label; on a phone the sentence has its own row.
  await page.goto(`/#note=${REPLY}`);
  const box = page.getByRole("dialog").locator(".summary-provenance");
  const edit = box.getByRole("button", { name: "编辑描述" });
  await expect(edit).toBeVisible();
  const [outer, label, sentence, button] = await Promise.all([
    box.boundingBox(), box.locator("strong").boundingBox(), box.locator("span").boundingBox(), edit.boundingBox(),
  ]);
  expect(button.x).toBeGreaterThan(label.x + label.width);
  expect(button.x + button.width).toBeLessThanOrEqual(outer.x + outer.width);
  expect(button.y).toBeGreaterThanOrEqual(outer.y);
  expect(button.y + button.height).toBeLessThanOrEqual(outer.y + outer.height);
  if (page.viewportSize().width <= 580) expect(sentence.y).toBeGreaterThanOrEqual(label.y + label.height - 1);
  await edit.click();
  const editor = page.getByRole("dialog").getByRole("textbox", { name: "知识卡描述" });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue(/^核心故事/);
  await page.getByRole("dialog").getByRole("button", { name: "取消" }).click();

  // Copying the card link puts it on the clipboard and says so.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("dialog").getByRole("button", { name: "复制卡片链接" }).click();
  await expect(page.locator("#toast")).toHaveText("卡片链接已复制");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`#note=${REPLY}$`));
});

test("a card in the grid shows the same source label and first text as its detail view", async ({ page }) => {
  await useFixture(page);
  await page.goto("/");
  for (const note of fixture.notes) {
    const gridCard = page.locator(`.note-card[data-note-id="${note.id}"]`);
    if (!note.mainText.trim()) {
      await expect(gridCard.locator(".card-summary-source")).toHaveCount(0);
      await expect(gridCard.locator(".card-summary")).toHaveCount(0);
      await expect(gridCard.locator(".card-title")).toHaveText(note.title);
      continue;
    }
    const gridLabel = (await gridCard.locator(".card-summary-source").innerText()).trim();
    const gridText = (await gridCard.locator(".card-summary").innerText()).replace(/\s+/g, " ").trim().slice(0, 20);
    await gridCard.locator("[data-open-note]").click();
    const detail = page.getByRole("dialog");
    await expect(sourceLabel(detail)).toHaveText(gridLabel);
    const detailText = (await detail.locator(".structured-summary").first().innerText()).replace(/\s+/g, " ").trim().slice(0, 20);
    expect(detailText, note.id).toBe(gridText);
    await page.locator("#dialog-close").click();
  }
});

test("the detail view never scrolls sideways, however long the text", async ({ page }) => {
  for (const id of [REPLY, VIDEO_ONLY_TAGS]) {
    const detail = await openCard(page, id);
    expect(await detail.evaluate((dialog) => dialog.scrollWidth - dialog.clientWidth)).toBeLessThanOrEqual(0);
  }
});

test("a personal revision wins over the reply, is kept in the browser only, and restoring brings the reply back", async ({ page }) => {
  const detail = await openCard(page, REPLY);
  const length = card(REPLY).mainText.trim().length;
  const served = async () => (await page.request.get("/data/knowledge.json")).text();
  const before = await served();

  await detail.getByRole("button", { name: "编辑描述" }).click();
  const editor = detail.getByRole("textbox", { name: "知识卡描述" });
  await expect(editor).toHaveValue(/^核心故事/);
  await editor.fill("我自己改写的一句话。");
  await detail.getByRole("button", { name: "保存修改" }).click();

  await expect(detail.locator(".structured-summary")).toHaveText("我自己改写的一句话。");
  await expect(detail.locator(".summary-fold")).toHaveCount(0);
  await expect(detail).toContainText("已使用你的个人修订");
  await expect(page.locator(`.note-card[data-note-id="${REPLY}"] .card-summary-source`)).toContainText("个人修订 · 点点 AI 深度总结");
  expect(await page.evaluate(() => Object.values(localStorage).some((value) => String(value).includes("我自己改写的一句话。")))).toBe(true);
  expect(await served()).toBe(before);

  await detail.getByRole("button", { name: "编辑描述" }).click();
  await detail.getByRole("button", { name: "恢复系统版本" }).click();
  await expect(detail.locator(".summary-fold-toggle")).toHaveText(`展开全文 · ${length} 字`);
  await expect(detail.locator(".structured-summary h4", { hasText: "核心故事" })).toHaveCount(1);
});

test("a short reply that fits is shown whole, with no fold button", async ({ page }) => {
  const detail = await openCard(page, "fixture-short-reply");
  const body = detail.locator(".structured-summary");
  await expect(body.locator("h4", { hasText: "项目简介" })).toHaveCount(1);
  await expect(detail.locator(".summary-fold-toggle")).toHaveCount(0);
  expect(await body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  await expect(detail.locator(".summary-fold-body")).toHaveCSS("mask-image", "none");
});

test("an opened reply stays open when the card is re-drawn, and folds again after closing", async ({ page }) => {
  const detail = await openCard(page, REPLY);
  const length = card(REPLY).mainText.trim().length;
  const toggle = detail.locator(".summary-fold-toggle");
  await toggle.click();
  await expect(toggle).toHaveText("收起");
  // Adding a bookmark re-draws the open card.
  await detail.getByRole("button", { name: "添加书签" }).click();
  await expect(detail.getByRole("button", { name: "已加书签" })).toBeVisible();
  await expect(detail.locator(".summary-fold-toggle")).toHaveText("收起");

  await page.getByRole("button", { name: "关闭详情" }).click();
  await page.locator(`[data-open-note="${REPLY}"]`).click();
  await expect(page.getByRole("dialog").locator(".summary-fold-toggle")).toHaveText(`展开全文 · ${length} 字`);
});

test("the detail view is compact: no heading row, no repeated evidence section, no next-step box", async ({ page }) => {
  const detail = await openCard(page, REPLY);
  for (const gone of ["核心结论", "原帖摘要", "具体用法", "整理依据"]) {
    await expect(detail.getByRole("heading", { name: gone })).toHaveCount(0);
  }
  await expect(detail.locator(".action-box")).toHaveCount(0);
  await expect(detail).not.toContainText("下一步");
  await expect(detail).not.toContainText("原视频和分析画面只保存在本机");
  await expect(detail.locator(".detail-title")).toHaveCSS("max-width", "none");
});

test("a card with no text at all shows its title and chips, and invents no wording", async ({ page }) => {
  const detail = await openCard(page, "fixture-no-text");
  await expect(detail.locator(".detail-title")).toHaveText(card("fixture-no-text").title);
  await expect(detail.locator(".tool-chip", { hasText: "占位主题" })).toHaveCount(1);
  await expect(detail.locator(".summary-provenance")).toHaveCount(0);
  await expect(detail.locator(".structured-summary")).toHaveCount(0);
  await expect(detail.locator(".extracted-section")).toHaveCount(0);
  await page.locator("#dialog-close").click();
  const gridCard = page.locator('.note-card[data-note-id="fixture-no-text"]');
  await expect(gridCard.locator(".card-summary-source")).toHaveCount(0);
});

test("search finds a phrase that only the post's text, or only a transcript, contains", async ({ page }) => {
  await useFixture(page);
  await page.goto("/");
  await page.locator("#search-input").fill("划时代的功能");
  await expect(page.locator(".note-card")).toHaveCount(1);
  await expect(page.locator(`.note-card[data-note-id="${DAMAGED}"]`)).toHaveCount(1);
  await page.locator("#search-input").fill("地表超强AI搜索引擎");
  await expect(page.locator(".note-card")).toHaveCount(1);
  await expect(page.locator(`.note-card[data-note-id="${VIDEO_ONLY_TAGS}"]`)).toHaveCount(1);
  await page.locator("#search-input").fill("只在传说中存在的短语");
  await expect(page.locator(".note-card")).toHaveCount(0);
});

test("D10: a cut reply that is the only text is shown as saved, and says so", async ({ page }) => {
  const detail = await openCard(page, "fixture-damaged-only-reply");
  await expect(sourceLabel(detail)).toHaveText("点点 AI 深度总结");
  const sentence = (await explanation(detail).innerText()).trim();
  expect(sentence.startsWith("保存的点点回复缺了内容（是我们采集出错），下一轮重新获取；")).toBe(true);
  expect(sentence.endsWith("先显示已保存的那部分点点回复。")).toBe(true);
  expect(sentence).not.toContain("点点 AI 的完整回复");
  await expect(detail.locator(".structured-summary")).toHaveText(card("fixture-damaged-only-reply").mainText, { useInnerText: true });
  for (const banner of BANNERS) await expect(detail).not.toContainText(banner);
  // It is not counted as a complete reply on the home page.
  const complete = fixture.notes.filter((note) => note.mainSource === "diandian" && !note.replyDamaged).length;
  expect(fixture.meta.replyCount).toBe(complete);
});
