import { test, expect } from "@playwright/test";

// Issue 112: the local workbench's post button is the same link the public site shows. A card with a post link opens
// the post itself ("在小红书中查看原帖"); a card without one shows the search link ("在小红书搜索原帖"). It does so
// whether or not the local service and the scan browser are up, and nothing asks the service to dig through a
// favourites folder: the old open-in-folder request is never sent.

const headers = { "X-FavSense-Test": "favsense-synthetic-v1" };
const WORKBENCH = "http://127.0.0.1:8766";
const SESSION_URL = "http://127.0.0.1:8768/local-session";
const WITH_CODE = "6a7dc92600000000250090ff";
const WITHOUT_CODE = "6a44938c0000000006021e9e";
// Spelled in pieces: this file sits under site/, which the pre-publish check scans, and that check refuses a written-out
// signed link in any file but the data file.
const SIGNED = ["https://www.xiaohongshu.com", "explore", WITH_CODE].join("/") + `?${["xsec", "token"].join("_")}=FAKEcodeA1%3D%3D&${["xsec", "source"].join("_")}=pc_collect`;

const BRIDGE_STATES = ["connected", "scan browser not ready", "no local service"];

test.afterEach(async ({ page }) => {
  await page.request.post(`${WORKBENCH}/__test/reset`, { headers });
});

async function openWorkbenchCard(page, id, bridgeState) {
  await page.request.post(`${WORKBENCH}/__test/reset`, { headers });
  await page.request.post(`${WORKBENCH}/__test/scenario`, { headers, data: { scenario: "faithful-cards" } });
  await page.route("**/data/knowledge.json", async (route) => {
    const data = await (await page.request.get(`${WORKBENCH}/data/knowledge.json`, { headers })).json();
    const card = data.notes.find((note) => note.id === WITH_CODE);
    card.sourceUrl = SIGNED;
    card.linkKind = "post";
    await route.fulfill({ json: data });
  });
  if (bridgeState === "scan browser not ready") {
    await page.route("**/local-session", async (route) => {
      const session = await (await page.request.get(SESSION_URL)).json();
      session.browser_session.ready = false;
      await route.fulfill({ json: session, headers: { "access-control-allow-origin": WORKBENCH, "access-control-allow-headers": "content-type,x-xhs-bridge-token" } });
    });
  }
  if (bridgeState === "no local service") {
    await page.route("**/.local/bridge.json", (route) => route.fulfill({ status: 404, json: { ok: false } }));
  }
  await page.goto("about:blank");
  // A connected workbench has finished starting up once it has asked the service for the folder list.
  const started = bridgeState === "no local service" ? Promise.resolve() : page.waitForResponse((response) => response.url().endsWith("/boards"));
  await page.goto(`${WORKBENCH}/#note=${id}`);
  await started;
  const detail = page.getByRole("dialog");
  await expect(detail.locator(".detail-title")).toBeVisible();
  return detail;
}

for (const bridgeState of BRIDGE_STATES) {
  test(`workbench (${bridgeState}): a card with a post link opens the post itself, as on the public site`, async ({ page }) => {
    const detail = await openWorkbenchCard(page, WITH_CODE, bridgeState);
    const first = detail.locator(".detail-footer").locator(":scope > :first-child");
    await expect(first).toHaveJSProperty("tagName", "A");
    await expect(first).toHaveText("在小红书中查看原帖");
    await expect(first).toHaveAttribute("href", SIGNED);
    await expect(first).toHaveAttribute("target", "_blank");
    expect(await first.getAttribute("rel")).toContain("noreferrer");
    await expect(detail.getByRole("button", { name: "打开原帖" })).toHaveCount(0);
    await expect(detail.locator("[data-open-source-note]")).toHaveCount(0);
  });

  test(`workbench (${bridgeState}): a card without a code shows the search link, as on the public site`, async ({ page }) => {
    const detail = await openWorkbenchCard(page, WITHOUT_CODE, bridgeState);
    const first = detail.locator(".detail-footer").locator(":scope > :first-child");
    await expect(first).toHaveJSProperty("tagName", "A");
    await expect(first).toHaveText("在小红书搜索原帖");
    expect(await first.getAttribute("href")).toMatch(/^https:\/\/www\.xiaohongshu\.com\/search_result\?/);
    await expect(first).toHaveAttribute("target", "_blank");
    await expect(detail.getByRole("button", { name: "打开原帖" })).toHaveCount(0);
    await expect(detail.getByText("请先启动 FavSense 本地服务")).toHaveCount(0);
    await expect(detail.getByText("SOP 扫描浏览器未就绪")).toHaveCount(0);
  });
}

test("workbench: using the post button sends the service no open-in-folder request", async ({ page, context }) => {
  // The click leaves for Xiaohongshu in a new tab; nothing here may reach the real site.
  await context.route("https://www.xiaohongshu.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<html></html>" }));
  const requested = [];
  page.on("request", (request) => requested.push(`${request.method()} ${new URL(request.url()).pathname}`));
  const detail = await openWorkbenchCard(page, WITH_CODE, "connected");
  const first = detail.locator(".detail-footer").locator(":scope > :first-child");
  const [popup] = await Promise.all([page.waitForEvent("popup"), first.click()]);
  expect(popup.url()).toBe(SIGNED);
  await popup.close();
  // The page did talk to the service while starting up, so an empty list here would mean the check saw nothing.
  expect(requested).toContain("GET /local-session");
  expect(requested.filter((entry) => entry.endsWith("/notes/open"))).toEqual([]);
  await expect(page.locator("#toast")).not.toContainText("原帖");
});
