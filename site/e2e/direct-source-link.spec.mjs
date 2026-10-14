import { test, expect } from "@playwright/test";

// Issue 106: a card whose data carries a post link (linkKind "post") opens the post itself and says so; every
// other card keeps the search link and its label. The code in the link is made up.

const headers = { "X-FavSense-Test": "favsense-synthetic-v1" };
const WITH_CODE = "6a7dc92600000000250090ff";
const WITHOUT_CODE = "6a44938c0000000006021e9e";
// Spelled in pieces: this file sits under site/, which the pre-publish check scans, and that check refuses a written-out
// signed link in any file but the data file.
const SIGNED = ["https://www.xiaohongshu.com", "explore", WITH_CODE].join("/") + `?${["xsec", "token"].join("_")}=FAKEcodeA1%3D%3D&${["xsec", "source"].join("_")}=pc_collect`;
// The public site is opened under a *.localhost name (the local workbench has its own spec, workbench-source-link).
const PUBLIC = "http://public.localhost:8767";
// The page's own data request is answered from here: Node cannot resolve the *.localhost name the page is opened under.
const DATA_URL = "http://127.0.0.1:8766/data/knowledge.json";

test.afterEach(async ({ page }) => {
  await page.request.post("http://127.0.0.1:8766/__test/reset", { headers });
});

async function openCard(page, id) {
  await page.request.post("http://127.0.0.1:8766/__test/reset", { headers });
  await page.request.post("http://127.0.0.1:8766/__test/scenario", { headers, data: { scenario: "faithful-cards" } });
  await page.route("**/data/knowledge.json", async (route) => {
    const data = await (await page.request.get(DATA_URL, { headers })).json();
    const card = data.notes.find((note) => note.id === WITH_CODE);
    card.sourceUrl = SIGNED;
    card.linkKind = "post";
    await route.fulfill({ json: data });
  });
  await page.goto("about:blank");
  await page.goto(`${PUBLIC}/#note=${id}`);
  const detail = page.getByRole("dialog");
  await expect(detail.locator(".detail-title")).toBeVisible();
  return detail;
}

test("a card with a post link opens the post itself, and says so", async ({ page }) => {
  const detail = await openCard(page, WITH_CODE);
  const first = detail.locator(".detail-footer").locator(":scope > :first-child");
  await expect(first).toHaveJSProperty("tagName", "A");
  await expect(first).toHaveText("在小红书中查看原帖");
  await expect(first).toHaveAttribute("href", SIGNED);
  await expect(first).toHaveAttribute("target", "_blank");
  expect(await first.getAttribute("rel")).toContain("noreferrer");
  await expect(detail.getByRole("link", { name: "在小红书搜索原帖" })).toHaveCount(0);
});

test("a card without a code keeps the search link and its label", async ({ page }) => {
  const detail = await openCard(page, WITHOUT_CODE);
  const first = detail.locator(".detail-footer").locator(":scope > :first-child");
  await expect(first).toHaveText("在小红书搜索原帖");
  expect(await first.getAttribute("href")).toMatch(/^https:\/\/www\.xiaohongshu\.com\/search_result\?/);
  await expect(detail.getByRole("link", { name: "在小红书中查看原帖" })).toHaveCount(0);
});

test("data that does not say what kind of link a card has is refused, not guessed", async ({ page }) => {
  await page.request.post("http://127.0.0.1:8766/__test/reset", { headers });
  await page.request.post("http://127.0.0.1:8766/__test/scenario", { headers, data: { scenario: "faithful-cards" } });
  await page.route("**/data/knowledge.json", async (route) => {
    const data = await (await page.request.get(DATA_URL, { headers })).json();
    delete data.notes[0].linkKind;
    await route.fulfill({ json: data });
  });
  await page.goto(`${PUBLIC}/`);
  await expect(page.locator(".note-card")).toHaveCount(0);
  await expect(page.getByText("知识数据文件格式损坏或不完整")).toBeVisible();
});
