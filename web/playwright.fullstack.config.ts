import { defineConfig, devices } from "@playwright/test";

// Full-stack scenarios: a real browser, the production UI build, the real Go API
// and a throwaway local Postgres database (scripts/fullstack-api.sh). Data comes
// from the ingest API in tests/fullstack/world.ts, scored by the real engine.
// Run: npm run build && npm run test:fullstack
export default defineConfig({
  testDir: "./tests/fullstack",
  globalSetup: "./tests/fullstack/world.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: { baseURL: "http://localhost:3201", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "../scripts/fullstack-api.sh",
      url: "http://127.0.0.1:3202/healthz",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npm run start -- --port 3201",
      url: "http://localhost:3201/login",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        API_BASE_URL: "http://127.0.0.1:3202",
        ANALYST_TOKEN: "fullstack-analyst-token",
        UI_PASSWORD: "fullstack-password",
      },
    },
  ],
});
