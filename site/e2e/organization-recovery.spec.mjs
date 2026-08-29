import { test, expect } from "@playwright/test";

const headers = { "X-FavSense-Test": "favsense-synthetic-v1" };

async function scenario(page, name) {
  await page.request.post("http://127.0.0.1:8766/__test/reset", { headers });
  await page.request.post("http://127.0.0.1:8766/__test/scenario", { headers, data: { scenario: name } });
}

test("synthetic fixture reset rejects requests without the test control header", async ({ request }) => {
  const unauthorized = await request.post("http://127.0.0.1:8766/__test/reset");
  expect(unauthorized.status()).toBe(403);

  const authorized = await request.post("http://127.0.0.1:8766/__test/reset", { headers });
  expect(authorized.status()).toBe(200);
});

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

test("running phases keep polling until the terminal organization state", async ({ page }) => {
  await scenario(page, "running-success");
  const statusResponses = [];
  page.on("response", (response) => {
    if (response.url().includes("/sync/status")) statusResponses.push(response.status());
  });
  await page.goto("/");
  await page.getByRole("button", { name: "同步设置" }).click();
  await page.getByRole("button", { name: "开始整理" }).click();
  await expect(page.getByRole("button", { name: "整理中…" })).toBeDisabled();
  await expect.poll(() => statusResponses.length, { timeout: 7000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("button", { name: "再次整理" })).toBeEnabled({ timeout: 8000 });
});

for (const [name, expected] of [
  ["summary-failed", "本篇总结失败，可在下次继续"],
  ["batch-aborted", "本次未尝试，可继续整理"],
  ["stale", "正文已变化，需重新核验"],
]) {
  test(`${name} exposes its distinct note recovery state`, async ({ page }) => {
    await scenario(page, name);
    await page.goto("/");
    await page.getByRole("button", { name: "查看总结" }).nth(1).click();
    await expect(page.getByText(expected, { exact: true }).first()).toBeVisible();
  });
}

for (const [name, expected] of [
  ["publish-failed", "发布失败，远端仍为上一版；本地结果已保留"],
  ["safety-stopped", "安全限制已触发，本轮已停止"],
]) {
  test(`${name} remains a truthful terminal run state`, async ({ page }) => {
    await scenario(page, name);
    await page.goto("/");
    await page.getByRole("button", { name: "同步设置" }).click();
    await page.getByRole("button", { name: "开始整理" }).click();
    await expect(page.locator("#manual-sync-control")).toContainText(expected);
  });
}

test("local note detail shows captured summary as pending review without publishing it", async ({ page }) => {
  await scenario(page, "success");
  await page.goto("/");
  await page.getByRole("button", { name: "查看总结" }).nth(1).click();
  const overlay = page.getByRole("status", { name: "本机补证内容" });
  await expect(overlay).toContainText("总结已保存，尚未完成证据核验");
  await expect(overlay).toContainText("Captured private synthetic summary");
  await expect(overlay).toContainText("点点总结");
});

test("public origin never mounts or requests the private pending overlay", async ({ page }) => {
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("http://127.0.0.1:8767/");
  await page.getByRole("button", { name: "查看总结" }).nth(1).click();
  await expect(page.getByText("补证内容", { exact: true })).toHaveCount(0);
  expect(requests.some((url) => url.includes("/notes/organization-status"))).toBe(false);
});
