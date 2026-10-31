import { test, expect, type Page } from "@playwright/test";

const id = "11111111-1111-4111-8111-111111111111";
async function signIn(page: Page, path = "/") {
  await page.goto(path);
  await page.getByLabel("Workspace password").fill("dashboard-test-password");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

test.beforeEach(async ({ request }) => {
  await request.post("http://127.0.0.1:3102/__reset");
});

test("password gate, signed cookie, return path, logout, and token privacy", async ({
  page,
  context,
}) => {
  await page.goto("/accounts?q=acme");
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel("Workspace password").fill("wrong-password");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "doesn't match" }),
  ).toBeVisible();
  await page.getByLabel("Workspace password").fill("dashboard-test-password");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page).toHaveURL(/\/accounts\?q=acme/);
  await expect(page.getByText("acc_acme", { exact: true })).toBeVisible();
  const cookie = (await context.cookies()).find(
    (item) => item.name === "ato_session",
  )!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.secure).toBe(true);
  expect(cookie.value).not.toContain("dashboard-test-password");
  expect(await page.content()).not.toContain("fixture-analyst-token");
  expect(await page.content()).not.toContain("dashboard-test-password");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
});

test("overview renders totals, charts, signals, queue, and date filters", async ({
  page,
  request,
}) => {
  await signIn(page);
  await expect(
    page.getByRole("heading", { name: "A view of what matters." }),
  ).toBeVisible();
  await expect(page.getByText("23,780", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: /Stacked chart/ })).toBeVisible();
  await expect(page.getByText("new domain", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "30 days", exact: true }).click();
  await expect(page).toHaveURL(/period=30d/);
  const calls = await (
    await request.get("http://127.0.0.1:3102/__requests")
  ).json();
  expect(
    calls.some((call: { path: string }) => call.path.includes("bucket=1d")),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/overview-desktop.png",
    fullPage: true,
  });
});

test("account search, shared-time charts, timeline and baseline", async ({
  page,
}) => {
  await signIn(page, "/accounts");
  await page.getByRole("searchbox", { name: "Search accounts" }).fill("acme");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("acc_beta", { exact: true })).toHaveCount(0);
  await page.getByText("acc_acme", { exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "acc_acme", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Learned baseline" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Hourly recipients/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /ASN observations/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Event timeline" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/account-desktop.png",
    fullPage: true,
  });
});

test("review requires a reason and records actor, action, evidence and audit history", async ({
  page,
  request,
}) => {
  await signIn(page, `/decisions/${id}`);
  await page.getByLabel("Review outcome").selectOption("confirm_takeover");
  await page.getByLabel("Your name").fill("Pooja");
  await page.getByRole("button", { name: "Record review" }).click();
  const before = await (
    await request.get("http://127.0.0.1:3102/__requests")
  ).json();
  expect(before.some((call: { body?: unknown }) => call.body)).toBe(false);
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Confirmed unauthorized activity with the account owner.");
  await page.getByRole("button", { name: "Record review" }).click();
  await expect(
    page.getByText("Review complete", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Confirmed unauthorized activity with the account owner.", {
      exact: true,
    }),
  ).toBeVisible();
  const after = await (
    await request.get("http://127.0.0.1:3102/__requests")
  ).json();
  expect(after.find((call: { body?: unknown }) => call.body).body).toEqual({
    action: "confirm_takeover",
    actor: "Pooja",
    reason: "Confirmed unauthorized activity with the account owner.",
  });
});

test("suspended key can be restored with an audited reason", async ({
  page,
}) => {
  await signIn(page, "/accounts/acc_acme");
  await page.getByText("Restore access", { exact: true }).click();
  await page.getByLabel("Your name").fill("Pooja");
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Key rotated and account secured.");
  await page.getByRole("button", { name: "Restore key access" }).click();
  await expect(page.getByText("active", { exact: true })).toBeVisible();
});

test("owner hold view remains gated and releases legitimate activity", async ({
  page,
}) => {
  await signIn(page, `/hold/${id}`);
  await expect(page.getByText(/Analyst sign-in is required/)).toBeVisible();
  await page.getByRole("button", { name: "This was me", exact: true }).click();
  await expect(
    page.getByText("This hold is released.", { exact: true }),
  ).toBeVisible();
});

test("owner can report unauthorized activity and a missing record has a clear view", async ({
  page,
}) => {
  await signIn(page, `/hold/${id}`);
  await page.getByRole("button", { name: "Not me", exact: true }).click();
  await expect(
    page.getByText("This hold is dropped.", { exact: true }),
  ).toBeVisible();
  await page.goto("/accounts/unknown-account");
  await expect(
    page.getByRole("heading", { name: "We couldn’t find that record." }),
  ).toBeVisible();
});

test("a tampered session cannot read a protected page or submit a review", async ({
  page,
  context,
  request,
}) => {
  await signIn(page);
  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === "ato_session")!;
  await context.addCookies([{ ...session, value: session.value + "tampered" }]);
  await page.goto(`/decisions/${id}`);
  await expect(page).toHaveURL(/\/login/);
  const response = await context.request.post(`/decisions/${id}`, {
    form: {
      action: "confirm_takeover",
      actor: "Untrusted",
      reason: "Forged request",
    },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(307);
  const calls = await (
    await request.get("http://127.0.0.1:3102/__requests")
  ).json();
  expect(calls.some((call: { body?: unknown }) => call.body)).toBe(false);
});

test("empty results and backend failures have explicit states", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:3102/__empty");
  await signIn(page);
  await expect(
    page.getByText("Ready for the first event.", { exact: true }),
  ).toBeVisible();
  await page.goto("/accounts");
  await expect(
    page.getByText("No accounts yet.", { exact: true }),
  ).toBeVisible();
  await request.post("http://127.0.0.1:3102/__unavailable");
  await page.goto("/");
  await expect(
    page.getByRole("alert").filter({ hasText: "Connection needs attention" }),
  ).toBeVisible();
});

test("mobile layout supports navigation without document overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(
    page.getByRole("heading", { name: "A view of what matters." }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/overview-mobile.png",
    fullPage: true,
  });
  const dimensions = await page.evaluate(() => ({
    width: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll("body *")]
      .filter((node) => node.getBoundingClientRect().right > window.innerWidth)
      .slice(0, 10)
      .map((node) => ({
        tag: node.tagName,
        className: node.getAttribute("class"),
        right: node.getBoundingClientRect().right,
      })),
  }));
  expect(dimensions.scroll, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.width,
  );
  await page.getByRole("link", { name: "Accounts", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Know the account. See the change." }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/accounts-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
});
