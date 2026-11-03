import {
  test,
  expect,
  MOCK_API,
  id,
  RESOLVE,
  signIn,
  mockRequests,
} from "./fixtures";

test("review requires a reason and records actor, action, evidence and audit history", async ({
  page,
  request,
}) => {
  await signIn(page, `/decisions/${id}`);
  await expect(page.locator(".decision-title .badge")).toHaveText("HOLD");
  // The header states the status once: no separate status card.
  await expect(page.locator(".decision-meta")).toContainText("Open review");
  await expect(page.locator(".hit-row")).toHaveCount(3);
  await expect(page.locator(".hit-points").first()).toHaveText("+30pts");
  const related = page.getByRole("region", {
    name: "Same infrastructure on other accounts",
  });
  await expect(related.locator(".related-verdict")).toHaveText(
    /2 accounts already confirmed as taken over/,
  );
  await expect(related.locator(".related-heading")).toContainText(
    "9 other accounts · 5 held or blocked · 2 confirmed takeovers",
  );
  await expect(related.getByRole("link", { name: "acc_beta" })).toHaveAttribute(
    "href",
    "/accounts/acc_beta",
  );
  // Five listed first; the rest open in place, then the unlisted remainder is counted.
  const accounts = related.locator(".related-accounts a");
  await expect(accounts).toHaveCount(5);
  const more = related.getByRole("button", { name: "Show 2 more accounts" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(accounts).toHaveCount(7);
  await expect(related.getByRole("link", { name: "acc_theta" })).toBeVisible();
  await expect(related.getByText("+2 more accounts not listed")).toBeVisible();
  await related.getByRole("button", { name: "Show fewer" }).click();
  await expect(accounts).toHaveCount(5);
  // The decision page is evidence; the incident is decided on the account page.
  await page
    .locator(".incident-decide")
    .getByRole("link", { name: "Decide on the account page" })
    .click();
  await expect(page).toHaveURL(/\/accounts\/acc_acme\?resolve=1$/);
  const decide = page.locator(".resolve-card", { hasText: "Resolve account" });
  await decide.getByLabel("Takeover").check();
  await decide.getByLabel("Your name").fill("Pooja");
  // No reason: the browser refuses the submit, nothing reaches the API.
  await decide.getByRole("button", { name: RESOLVE }).click();
  const before = await mockRequests(request);
  expect(before.some((call: { body?: unknown }) => call.body)).toBe(false);
  await decide
    .getByLabel("Reason", { exact: true })
    .fill("Confirmed unauthorized activity with the account owner.");
  await decide.getByRole("button", { name: RESOLVE }).click();
  await expect(decide.getByRole("status")).toContainText(
    "Resolved as takeover",
  );
  const after = await mockRequests(request);
  expect(after.find((call: { body?: unknown }) => call.body)?.body).toEqual({
    decision_ids: [id],
    outcome: "takeover",
    restore_keys: false,
    actor: "Pooja",
    reason: "Confirmed unauthorized activity with the account owner.",
  });
});

test("the decision page is evidence: it states the incident and its deadline, and links to decide", async ({
  page,
  request,
}) => {
  await signIn(page, `/decisions/${id}`);
  const decide = page.locator(".decision-decide");
  await expect(decide).toContainText("Part of an open incident");
  await expect(decide).toContainText(
    "1 open review · 1 held email · 1 suspended key",
  );
  await expect(decide.locator(".incident-deadline")).toContainText("Decide by");
  // No decision controls here: one place decides, the account page.
  await expect(decide.getByLabel("Takeover")).toHaveCount(0);
  await expect(
    decide.getByRole("link", { name: "Decide on the account page" }),
  ).toHaveAttribute("href", "/accounts/acc_acme?resolve=1");
  await request.post(`${MOCK_API}/v1/accounts/acc_acme/resolve`, {
    headers: { Authorization: "Bearer fixture-analyst-token" },
    data: {
      decision_ids: [id],
      outcome: "takeover",
      restore_keys: false,
      actor: "fixture",
      reason: "Resolved elsewhere",
    },
  });
  await page.reload();
  await expect(decide).toContainText("Reviewed: takeover");
  await expect(decide).toContainText("Nothing is open on this account.");
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
