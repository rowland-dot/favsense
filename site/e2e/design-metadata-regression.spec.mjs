import { test, expect } from "@playwright/test";

test("missing optional metadata never leaks undefined into the rendered page", async ({ page }) => {
  await page.goto("http://127.0.0.1:8767/");

  await expect(page).toHaveTitle("FavSense · 拾光台 · 小红书收藏知识工作台");
  await expect(page.locator("#hero-eyebrow")).toHaveText("本期片场 · 收藏知识库");
  await expect(page.locator("body")).not.toContainText("undefined");
});
