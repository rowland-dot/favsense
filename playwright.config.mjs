import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./site/e2e",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  use: { baseURL: "http://127.0.0.1:8766", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "node scripts/serve-qa-fixture.mjs", url: "http://127.0.0.1:8766/__health", reuseExistingServer: false, timeout: 20_000 },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } } },
  ],
});
