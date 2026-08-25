import { test, expect } from "@playwright/test";

async function tabTo(page, selector) {
  for (let index = 0; index < 20; index += 1) {
    await page.keyboard.press("Tab");
    if (await page.locator(selector).evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`Keyboard focus never reached ${selector}`);
}

async function focusRingMetrics(locator) {
  return locator.evaluate((element) => {
    const parseColor = (value) => {
      const rgb = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/);
      if (rgb) return { channels: rgb.slice(1, 4).map(Number), alpha: Number(rgb[4] || 1) };
      const srgb = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?/);
      if (srgb) return {
        channels: srgb.slice(1, 4).map((channel) => Number(channel) * 255),
        alpha: Number(srgb[4] || 1),
      };
      throw new Error(`Unsupported computed color: ${value}`);
    };
    const luminance = (channels) => {
      const [red, green, blue] = channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
    };
    const style = getComputedStyle(element);
    let ancestor = element.parentElement;
    let background = null;
    while (ancestor && !background) {
      const value = getComputedStyle(ancestor).backgroundColor;
      if (value !== "rgba(0, 0, 0, 0)") background = value;
      ancestor = ancestor.parentElement;
    }
    const backgroundChannels = parseColor(background || getComputedStyle(document.body).backgroundColor).channels;
    const foreground = parseColor(style.outlineColor);
    const compositedForeground = foreground.channels.map(
      (channel, index) => (channel * foreground.alpha) + (backgroundChannels[index] * (1 - foreground.alpha))
    );
    const foregroundLuminance = luminance(compositedForeground);
    const backgroundLuminance = luminance(backgroundChannels);
    return {
      contrast: (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
        / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
      style: style.outlineStyle,
      width: Number.parseFloat(style.outlineWidth),
    };
  });
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
