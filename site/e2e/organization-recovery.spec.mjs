import { test, expect } from "@playwright/test";

const headers = { "X-FavSense-Test": "favsense-synthetic-v1" };

async function scenario(page, name) {
  await page.request.post("http://127.0.0.1:8766/__test/reset");
  await page.request.post("http://127.0.0.1:8766/__test/scenario", { headers, data: { scenario: name } });
}

test("confirmed Skill detail exposes repository and ZIP through the real mount", async ({ page }) => {
  await scenario(page, "success");
  await page.goto("/");
  await page.getByRole("button", { name: "查看总结" }).first().click();
  await expect(page.getByRole("link", { name: /Official synthetic Skill 官方仓库/ })).toHaveAttribute("href", "https://github.com/owner/repo");
  await expect(page.getByRole("link", { name: /Official synthetic Skill 下载 ZIP/ })).toHaveAttribute("href", /main\.zip$/);
});
test("build and publish failure transitions never claim full completion", async ({ page }) => {
  await scenario(page, "build-failed");
  await page.goto("/");
  await page.getByRole("button", { name: "同步设置" }).click();
  await page.getByRole("button", { name: "开始整理" }).click();
  const organizationStatus = page.locator("#manual-sync-control");
  await expect(organizationStatus).toContainText("构建失败，已保留上一版");
  await expect(organizationStatus).toContainText("核心收藏已保存");
  await expect(organizationStatus).not.toContainText("本次整理完成，本地知识库与网页已经更新");
});

test("local note detail shows captured summary as pending review without publishing it", async ({ page }) => {
  await scenario(page, "success");
  await page.goto("/");
  await page.getByRole("button", { name: "查看总结" }).nth(1).click();
  const overlay = page.getByRole("status", { name: "本机待审核证据" });
  await expect(overlay).toContainText("总结已捕获，等待审核");
  await expect(overlay).toContainText("Captured private synthetic summary");
  await expect(overlay).toContainText("点点总结");
});

test("public origin never mounts or requests the private pending overlay", async ({ page }) => {
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("http://127.0.0.1:8767/");
  await page.getByRole("button", { name: "查看总结" }).nth(1).click();
  await expect(page.getByText("待审核证据", { exact: true })).toHaveCount(0);
  expect(requests.some((url) => url.includes("/notes/organization-status"))).toBe(false);
});
