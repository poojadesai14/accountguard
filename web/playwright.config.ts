import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: "list",
  use: { baseURL: "http://localhost:3101", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node --import tsx tests/mock-api.ts",
      url: "http://127.0.0.1:3102/healthz",
      reuseExistingServer: false,
      timeout: 20_000,
    },
    {
      command: "npm run start -- --port 3101",
      url: "http://localhost:3101/login",
      reuseExistingServer: false,
      timeout: 40_000,
      env: {
        API_BASE_URL: "http://127.0.0.1:3102",
        ANALYST_TOKEN: "fixture-analyst-token",
        UI_PASSWORD: "dashboard-test-password",
      },
    },
  ],
});
