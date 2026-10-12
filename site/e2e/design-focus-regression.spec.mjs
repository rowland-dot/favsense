import { test, expect } from "@playwright/test";
import { backgroundsFromElement, compositeOver, contrastRatio, parseColor, resolveBackground } from "./contrast-support.mjs";

async function tabTo(page, selector) {
  for (let index = 0; index < 20; index += 1) {
    await page.keyboard.press("Tab");
    if (await page.locator(selector).evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`Keyboard focus never reached ${selector}`);
}

async function focusRingMetrics(locator) {
  const sample = await locator.evaluate((element, backgroundsSource) => {
    const backgroundsFromElement = (0, eval)(`(${backgroundsSource})`);
    const style = getComputedStyle(element);
    return {
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      backgrounds: backgroundsFromElement(element, false),
    };
  }, backgroundsFromElement.toString());
  const background = resolveBackground(sample.backgrounds, [255, 255, 255]);
  const ring = compositeOver(parseColor(sample.outlineColor), background);
  return {
    contrast: contrastRatio(ring, background),
    style: sample.outlineStyle,
    width: Number.parseFloat(sample.outlineWidth),
  };
}

async function expectAccessibleFocusRing(locator) {
  const metrics = await focusRingMetrics(locator);
  expect(metrics.style).toBe("solid");
  expect(metrics.width).toBeGreaterThanOrEqual(3);
  expect(metrics.contrast).toBeGreaterThanOrEqual(3);
}

test("focus rings meet non-text contrast across public and manager controls", async ({ page }) => {
  await page.goto("http://127.0.0.1:8767/");

  for (const selector of ["#search-input", "#sort-select"]) {
    await tabTo(page, selector);
    await expect(page.locator(selector)).toBeFocused();
    await expectAccessibleFocusRing(page.locator(selector));
  }

  await page.goto("http://127.0.0.1:8766/");
  await page.getByRole("button", { name: "同步设置", exact: true }).click();
  await tabTo(page, "#manual-sync-start");
  await expectAccessibleFocusRing(page.locator("#manual-sync-start"));
  await tabTo(page, "[data-board-toggle]");
  await expectAccessibleFocusRing(page.locator("[data-board-toggle] + .board-toggle-track"));
});
