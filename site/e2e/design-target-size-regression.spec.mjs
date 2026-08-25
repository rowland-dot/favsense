import { test, expect } from "@playwright/test";

test("primary controls keep a 44px pointer target in every top-level view", async ({ page }) => {
  await page.goto("http://127.0.0.1:8767/");

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

    expect(undersized, `${view} has undersized controls`).toEqual([]);
  }
});
