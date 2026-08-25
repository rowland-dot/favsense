import { test, expect } from "@playwright/test";

const headers = { "X-FavSense-Test": "favsense-synthetic-v1" };

test("confirmed Skill fixture exposes the complete review metadata", async ({ page }) => {
  // Regression: QA-001 — the synthetic confirmed Skill omitted review metadata
  // Found by /qa on 2026-08-25
  // Report: docs/reports/qa/2026-08-25-favsense-end-to-end-organization-recovery-qa-report.md
  await page.request.post("http://127.0.0.1:8766/__test/reset");
  await page.request.post("http://127.0.0.1:8766/__test/scenario", {
    headers,
    data: { scenario: "success" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "资源索引" }).click();

  const resource = page.getByText("Official synthetic Skill", { exact: true }).last();
  const card = resource.locator("xpath=ancestor::*[contains(@class, 'resource-card')]");
  await expect(card).toContainText("许可证");
  await expect(card).toContainText("MIT");
  await expect(card).toContainText("Skill manifest");
  await expect(card).toContainText("SKILL.md");
  await expect(card).toContainText("核验日期");
  await expect(card).toContainText("2026-08-23");
  await expect(card).toContainText("4");
  await expect(card).toContainText("兼容性");
  await expect(card).toContainText("Codex");
});
