import { test, expect } from "@playwright/test";

const headers = { "X-FavSense-Test": "favsense-synthetic-v1" };

test("confirmed Skill fixture exposes the complete review metadata", async ({ page }) => {
  // Regression: QA-001 — the synthetic confirmed Skill omitted review metadata
  // Found by /qa on 2026-08-25
  // Report: docs/reports/qa/2026-08-25-favsense-end-to-end-organization-recovery-qa-report.md
  await page.request.post("http://127.0.0.1:8766/__test/reset", { headers });
  await page.request.post("http://127.0.0.1:8766/__test/scenario", {
    headers,
    data: { scenario: "success" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "查看总结" }).first().click();

  const detail = page.getByRole("dialog");
  for (const expected of [
    "Official synthetic Skill",
    "许可证",
    "MIT",
    "Skill manifest",
    "SKILL.md",
    "核验日期",
    "2026-08-23",
    "4",
    "兼容性",
    "Codex",
  ]) {
    await expect(detail).toContainText(expected);
  }
  await expect(detail.getByRole("link", { name: /Official synthetic Skill 官方仓库/ })).toBeVisible();
  await expect(detail.getByRole("link", { name: /Official synthetic Skill 下载 ZIP/ })).toBeVisible();
  await expect(detail.getByRole("link", { name: /Official synthetic Skill 文档/ })).toBeVisible();

  const attributeRows = detail.locator(".detail-resource-attributes > span");
  await expect(attributeRows).toHaveCount(4);
  const boxes = await attributeRows.evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().toJSON()));
  for (let index = 1; index < boxes.length; index += 1) {
    expect(boxes[index - 1].bottom).toBeLessThanOrEqual(boxes[index].top);
  }
});
