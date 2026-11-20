import { test, expect, id, signIn, mockRequests } from "./fixtures";

test("password gate, signed cookie, return path, logout, and token privacy", async ({
  page,
  context,
}) => {
  await page.goto("/?q=acme");
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByText("Not a production product")).toBeVisible();
  await page.getByLabel("Workspace password").fill("wrong-password");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "doesn't match" }),
  ).toBeVisible();
  await page.getByLabel("Workspace password").fill("dashboard-test-password");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(page).toHaveURL(/\/\?q=acme/);
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
  const calls = await mockRequests(request);
  expect(calls.some((call: { body?: unknown }) => call.body)).toBe(false);
});
