import { test, expect } from "@playwright/test";

async function tabTo(page, selector) {
  for (let index = 0; index < 40; index += 1) {
    await page.keyboard.press("Tab");
    if (await page.locator(selector).evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`Keyboard focus never reached ${selector}`);
}

test("keyboard activation traverses all views and returns focus from the native dialog", async ({ page }) => {
  await page.goto("http://127.0.0.1:8767/");

  for (const [name, panel] of [
    ["资源索引", "#resources-view"],
    ["同步设置", "#method-view"],
    ["知识卡", "#notes-view"],
  ]) {
    const control = page.getByRole("button", { name, exact: true });
    await control.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(panel)).toBeVisible();
    await expect(control).toHaveAttribute("aria-current", "page");
  }

  const summaryButton = page.getByRole("button", { name: "查看总结" }).first();
  await summaryButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("dialog[open]")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(summaryButton).toBeFocused();
});

test("manager board and start controls remain operable and focused by keyboard", async ({ page }) => {
  await page.goto("http://127.0.0.1:8766/");
  const settings = page.getByRole("button", { name: "同步设置", exact: true });
  await settings.focus();
  await page.keyboard.press("Enter");

  const toggleSelector = "[data-board-toggle]";
  await tabTo(page, toggleSelector);
  await page.keyboard.press("Space");
  await expect(page.locator("#board-manager-status")).toContainText("设置已保存");
  await expect(page.locator(toggleSelector)).toBeFocused();

  await tabTo(page, "#manual-sync-start");
  await page.keyboard.press("Enter");
  await expect(page.locator("#manual-sync-start")).toHaveText(/整理中…|再次整理/);
});
