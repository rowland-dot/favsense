import { test, expect } from "@playwright/test";

test("primary controls keep a 44px pointer target across public and manager views", async ({ page }) => {
  for (const origin of ["http://127.0.0.1:8767", "http://127.0.0.1:8766"]) {
    await page.goto(origin);

    for (const view of ["知识卡", "资源索引", "同步设置"]) {
      await page.getByRole("button", { name: view, exact: true }).click();
      const undersized = await page.locator("button, input, select, .brand, .creator-space-link, .resource-actions a").evaluateAll((elements) =>
        elements
          .filter((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          })
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              label: element.getAttribute("aria-label") || element.textContent.trim().slice(0, 40),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            };
          })
          .filter(({ width, height }) => width < 44 || height < 44)
      );

      expect(undersized, `${origin} ${view} has undersized controls`).toEqual([]);
    }
  }
});

test("resource actions stay compact while preserving their pointer targets", async ({ page }) => {
  await page.goto("http://127.0.0.1:8767");
  await page.getByRole("button", { name: "资源索引", exact: true }).click();
  const actions = page.locator(".resource-card").first().locator(".resource-actions a");
  expect(await actions.count()).toBeGreaterThan(0);
  const styles = await actions.evaluateAll((links) => links.map((link) => {
    const style = getComputedStyle(link);
    const rect = link.getBoundingClientRect();
    return {
      flexGrow: style.flexGrow,
      borderRadius: Number.parseFloat(style.borderRadius),
      width: rect.width,
      height: rect.height,
    };
  }));
  expect(styles.every(({ flexGrow, borderRadius, height }) =>
    flexGrow === "0" && borderRadius >= 20 && height >= 44
  )).toBe(true);
});
