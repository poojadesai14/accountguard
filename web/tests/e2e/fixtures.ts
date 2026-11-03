import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

export { expect };

// The local mock API (tests/mock-api.ts) the dashboard is started against.
export const MOCK_API = "http://127.0.0.1:3102";
// The one held decision in the mock fixtures, on acc_acme.
export const id = "11111111-1111-4111-8111-111111111111";
// The Resolve button names what it will do once an outcome is chosen.
export const RESOLVE =
  /^Resolve (account|\d+ reviews? as (legitimate|takeover))$/;

// Every test starts from the mock API's initial fixtures.
export const test = base.extend<{ resetMockApi: void }>({
  resetMockApi: [
    async ({ request }, use) => {
      await request.post(`${MOCK_API}/__reset`);
      await use();
    },
    { auto: true },
  ],
});

export async function signIn(page: Page, path = "/") {
  await page.goto(path);
  await page.getByLabel("Workspace password").fill("dashboard-test-password");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

// Opens acc_acme from the queue: the row leads to the account page, where the
// incident is decided. Returns its Resolve card.
export async function openAccount(page: Page) {
  await page.getByRole("link", { name: "Open acc_acme", exact: true }).click();
  await expect(page).toHaveURL(/\/accounts\/acc_acme$/);
  return page.locator(".resolve-card", { hasText: "Resolve account" });
}

export type MockRequest = { path: string; body?: Record<string, unknown> };

// The requests the mock API has received since the last reset, oldest first.
export async function mockRequests(
  request: APIRequestContext,
): Promise<MockRequest[]> {
  return (await request.get(`${MOCK_API}/__requests`)).json();
}
