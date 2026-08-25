import { test, expect } from "@playwright/test";

async function tabTo(page, selector) {
  for (let index = 0; index < 20; index += 1) {
    await page.keyboard.press("Tab");
    if (await page.locator(selector).evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`Keyboard focus never reached ${selector}`);
}

test("text and select controls retain the shared visible keyboard focus ring", async ({ page }) => {
  await page.goto("http://127.0.0.1:8767/");

  for (const selector of ["#search-input", "#sort-select"]) {
    await tabTo(page, selector);
    await expect(page.locator(selector)).toBeFocused();
    expect(await page.locator(selector).evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
  }
});
