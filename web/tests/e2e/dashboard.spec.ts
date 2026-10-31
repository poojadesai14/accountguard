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
  await expect
    .poll(() =>
      page
        .getByRole("img", { name: "Resend", exact: true })
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
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

test("dashboard metrics and telemetry charts use real API data and date filters", async ({
  page,
  request,
}) => {
  await signIn(page);
  await expect(
    page.getByRole("heading", { name: "Account reviews" }),
  ).toBeVisible();
  await expect(page.locator(".dashboard-metrics .stat-number")).toHaveText([
    "3",
    "1",
    "2",
    "1",
  ]);
  await page.getByRole("button", { name: "Telemetry", exact: true }).click();
  for (const action of ["FLAG", "QUARANTINE", "BLOCK"])
    await expect(
      page.getByRole("figure", { name: `${action} decisions over time` }),
    ).toBeVisible();
  await expect(page.getByText("new domain", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "30 days", exact: true }).click();
  await expect(page).toHaveURL(/period=30d/);
  const calls = await (
    await request.get("http://127.0.0.1:3102/__requests")
  ).json();
  expect(
    calls.some((call: { path: string }) => call.path.includes("bucket=1d")),
  ).toBe(true);
  await page.getByText("View chart data", { exact: true }).click();
  const table = page.getByRole("table", { name: "Elevated activity data" });
  const values = await table
    .locator("tbody tr")
    .evaluateAll((rows) =>
      rows.map((row) =>
        [...row.querySelectorAll("td")].map((cell) => Number(cell.textContent)),
      ),
    );
  expect(values.reduce((sum, row) => sum + row[0], 0)).toBe(24);
  expect(values.reduce((sum, row) => sum + row[1], 0)).toBe(12);
  expect(values.reduce((sum, row) => sum + row[2], 0)).toBe(4);
  expect(values.some((row) => row.every((value) => value === 0))).toBe(true);
  await page.getByText("View chart data", { exact: true }).click();
  await page.screenshot({
    path: "test-results/dashboard-telemetry.png",
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

test("a single quarantined incident has a visible, keyboard-readable chart", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:3102/__single-bucket");
  await signIn(page, "/?tab=telemetry&period=all");
  const chart = page.getByRole("figure", {
    name: "QUARANTINE decisions over time",
  });
  await expect(chart).toBeVisible();
  await chart.getByRole("application").focus();
  await page.keyboard.press("ArrowRight");
  await expect(chart.locator(".recharts-tooltip-wrapper")).toContainText(
    "QUARANTINE",
  );
  await expect(chart.locator(".recharts-tooltip-wrapper")).toContainText("1");
  await page.getByText("View chart data", { exact: true }).click();
  const table = page.getByRole("table", { name: "Elevated activity data" });
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody td")).toHaveText(["0", "1", "0"]);
});

test("event selection, filters, and copy controls keep the investigation panels in sync", async ({
  page,
}) => {
  await signIn(page, "/accounts/acc_acme");
  const workspace = page.getByRole("region", {
    name: "Event investigation workspace",
  });
  const selected = workspace.getByRole("region", {
    name: "Selected event investigation",
  });
  const metadata = workspace.getByRole("complementary", {
    name: "Selected event metadata",
  });
  await expect(
    selected.getByRole("heading", { name: "QUARANTINE", exact: true }),
  ).toBeVisible();
  await expect(
    selected.getByRole("table", { name: "Selected event signals" }),
  ).toContainText("30");
  await workspace
    .getByRole("button", { name: "Inspect evt_normal_001", exact: true })
    .click();
  await expect(
    selected.getByRole("heading", { name: "ALLOW", exact: true }),
  ).toBeVisible();
  await expect(
    selected.getByRole("heading", { name: "No scoring signals fired" }),
  ).toBeVisible();
  await expect(
    metadata.getByRole("region", { name: "Network metadata" }),
  ).toContainText("198.51.100.20");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          document.documentElement.dataset.copiedMetadata = value;
        },
      },
    });
  });
  await metadata.getByRole("button", { name: "Copy network metadata" }).click();
  await expect(
    metadata.getByText("Copied to clipboard", { exact: true }),
  ).toBeVisible();
  const copied = await page.evaluate(
    () => document.documentElement.dataset.copiedMetadata,
  );
  expect(JSON.parse(copied!)).toMatchObject({
    ip: "198.51.100.20",
    asn: 16509,
  });
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Clipboard permission denied");
        },
      },
    });
  });
  await metadata.getByRole("button", { name: "Copy event metadata" }).click();
  await expect(
    metadata.getByText("Copy failed. Select and copy the text above."),
  ).toBeVisible();
  await workspace
    .getByRole("button", { name: "Inspect evt_unscored_001", exact: true })
    .click();
  await expect(
    selected.getByRole("heading", { name: "UNSCORED", exact: true }),
  ).toBeVisible();
  await expect(
    selected.getByRole("heading", { name: "No decision recorded" }),
  ).toBeVisible();
  await expect(
    selected.getByRole("link", { name: "Open full review" }),
  ).toHaveCount(0);
  await workspace
    .getByRole("combobox", { name: "Filter event outcomes" })
    .selectOption("hold");
  await expect(
    workspace.getByRole("button", {
      name: "Inspect evt_normal_001",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    selected.getByRole("heading", { name: "QUARANTINE", exact: true }),
  ).toBeVisible();
  await workspace
    .getByRole("searchbox", { name: "Filter event stream" })
    .fill("new domain");
  await expect(
    selected.getByRole("heading", { name: "QUARANTINE", exact: true }),
  ).toBeVisible();
  await workspace
    .getByRole("searchbox", { name: "Filter event stream" })
    .fill("missing-key");
  await expect(
    workspace.getByRole("heading", { name: "No matching events" }),
  ).toBeVisible();
  await expect(
    workspace.getByRole("region", { name: "Selected event investigation" }),
  ).toHaveCount(0);
  await workspace
    .getByRole("searchbox", { name: "Filter event stream" })
    .fill("AS14061");
  await selected.getByRole("link", { name: "Open full review" }).click();
  await expect(page).toHaveURL(`/decisions/${id}`);
  await expect(
    page.getByRole("heading", { name: "Why this decision was made" }),
  ).toBeVisible();
});

test("review requires a reason and records actor, action, evidence and audit history", async ({
  page,
  request,
}) => {
  await signIn(page, `/decisions/${id}`);
  await expect(page.locator(".score-overview .badge")).toHaveText("QUARANTINE");
  await expect(page.locator(".hit-row")).toHaveCount(3);
  await expect(page.locator(".hit-points").first()).toHaveText("+30pts");
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
    page.getByText("Your review queue is clear.", { exact: true }),
  ).toBeVisible();
  await page.goto("/accounts");
  await expect(
    page.getByText("No accounts yet.", { exact: true }),
  ).toBeVisible();
  await request.post("http://127.0.0.1:3102/__unavailable");
  await page.goto("/");
  await expect(
    page.getByRole("alert").filter({ hasText: "Dashboard update failed" }),
  ).toBeVisible();
});

test("mobile layout supports navigation without document overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await expect(
    page.getByRole("heading", { name: "Account reviews" }),
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
    page.getByRole("heading", { name: "Accounts", level: 1 }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/accounts-mobile.png",
    fullPage: true,
  });
  await page.goto(`/decisions/${id}`);
  const evidence = await page.locator(".hit-list").boundingBox();
  const review = await page.locator(".review-form").boundingBox();
  expect(evidence!.y).toBeLessThan(review!.y);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("dashboard filters and pagination are reflected in the URL", async ({
  page,
  request,
}) => {
  await signIn(page);
  await expect(
    page.getByRole("table", { name: "Dashboard accounts" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  const table = page.getByRole("table", { name: "Dashboard accounts" });
  await page.getByRole("button", { name: "High ≥80", exact: true }).click();
  await expect(page).toHaveURL(/severity=high/);
  await expect(
    table.getByRole("button", { name: "Inspect acc_high", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("button", { name: "Inspect acc_acme", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Legitimate baselines", exact: true })
    .click();
  await expect(
    page.getByRole("group", { name: "Risk score filter" }),
  ).toHaveCount(0);
  await expect(page).not.toHaveURL(/severity=/);
  await expect(page.getByRole("combobox", { name: "Sort by" })).toBeVisible();
  await expect(
    table.getByRole("button", { name: "Inspect acc_good", exact: true }),
  ).toBeVisible();
  await expect(table).toContainText("Learning baseline");
  await page
    .getByRole("searchbox", { name: "Search dashboard" })
    .fill("key_good");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/q=key_good/);
  await expect(
    table.getByRole("button", { name: "Inspect acc_learning", exact: true }),
  ).toHaveCount(0);
  await page.goto("/?tab=baseline&severity=high&sort=score_desc");
  await expect(
    table.getByRole("button", { name: "Inspect acc_good", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("button", { name: "Inspect acc_learning", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Risk score filter" }),
  ).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Sort by" })).toHaveValue(
    "score_desc",
  );
  await request.post("http://127.0.0.1:3102/__many-accounts");
  await page.goto("/");
  await expect(
    page.getByRole("group", { name: "Risk score filter" }),
  ).toBeVisible();
  await expect(page.locator(".dashboard-pagination")).toContainText(
    "Showing 1–50 of 58 accounts",
  );
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(table.locator("tbody tr")).toHaveCount(8);
  await expect(page.locator(".dashboard-pagination")).toContainText(
    "Showing 51–58 of 58 accounts",
  );
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page).not.toHaveURL(/page=2/);
});

test("metric cards open matching drilldowns and retain selection through reload and history", async ({
  page,
  request,
}) => {
  await signIn(page, "/?q=missing&severity=high&page=2&sort=score_desc");
  const table = page.getByRole("table", { name: "Dashboard accounts" });
  const holds = page.getByRole("button", {
    name: "View events on hold",
    exact: true,
  });
  const keys = page.getByRole("button", {
    name: "View suspended api keys",
    exact: true,
  });
  const healthy = page.getByRole("button", {
    name: "View healthy accounts",
    exact: true,
  });
  const attention = page.getByRole("button", {
    name: "View accounts to review",
    exact: true,
  });

  await holds.click();
  await expect(page).toHaveURL(/view=holds/);
  await expect(page).not.toHaveURL(/q=|severity=|page=2/);
  await expect(holds).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("heading", { name: "Events on hold", exact: true }),
  ).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table.locator("tbody tr").first()).toContainText("acc_acme");
  await expect(
    page.locator(".dashboard-table-controls .count-pill"),
  ).toHaveText("1 event");
  await page.reload();
  await expect(holds).toHaveAttribute("aria-pressed", "true");
  await expect(table.locator("tbody tr")).toHaveCount(1);

  await keys.click();
  await expect(page).toHaveURL(/view=keys/);
  await expect(keys).toHaveAttribute("aria-pressed", "true");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table).not.toContainText("acc_beta");
  await expect(
    page.locator(".dashboard-table-controls .count-pill"),
  ).toHaveText("2 keys");

  await healthy.click();
  await expect(page).toHaveURL(/tab=baseline/);
  await expect(page).toHaveURL(/view=healthy/);
  await expect(healthy).toHaveAttribute("aria-pressed", "true");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("acc_good");
  await expect(table).not.toContainText("acc_learning");
  await expect(
    page.getByRole("group", { name: "Risk score filter" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Clear view", exact: true }).click();
  await expect(page).not.toHaveURL(/view=/);
  await expect(healthy).toHaveAttribute("aria-pressed", "false");
  await expect(table).toContainText("acc_learning");
  await expect(
    page.getByText("Includes healthy accounts and accounts still learning."),
  ).toBeVisible();

  await keys.click();
  await expect(page).toHaveURL(/view=keys/);
  await attention.click();
  await expect(page).not.toHaveURL(/view=|tab=/);
  await expect(attention).toHaveAttribute("aria-pressed", "true");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await page.goBack();
  await expect(keys).toHaveAttribute("aria-pressed", "true");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await page.goForward();
  await expect(attention).toHaveAttribute("aria-pressed", "true");

  await holds.focus();
  await page.keyboard.press("Enter");
  await expect(holds).toHaveAttribute("aria-pressed", "true");
  await request.post("http://127.0.0.1:3102/__empty");
  await page.reload();
  await expect(healthy).toBeEnabled();
  await healthy.click();
  await expect(
    page.getByRole("heading", { name: "No healthy accounts yet" }),
  ).toBeVisible();
  await expect(healthy).toHaveAttribute("aria-pressed", "true");
});

test("an older API cannot relabel an account list as held events or healthy accounts", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:3102/__legacy-dashboard");
  await signIn(page);
  await expect(
    page.getByRole("table", { name: "Dashboard accounts" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "View events on hold", exact: true })
    .click();
  await expect(page.locator(".dashboard > .api-error")).toContainText(
    "do not match the selected view",
  );
  await expect(
    page.getByRole("table", { name: "Dashboard accounts" }),
  ).toHaveCount(0);
  await expect(
    page.locator(".dashboard-table-controls .count-pill"),
  ).toHaveText("Unavailable");
  await page
    .getByRole("button", { name: "View healthy accounts", exact: true })
    .click();
  await expect(
    page.getByRole("table", { name: "Dashboard accounts" }),
  ).toHaveCount(0);
  await expect(page.locator(".dashboard > .api-error")).toContainText(
    "do not match the selected view",
  );
  await page
    .getByRole("button", { name: "View accounts to review", exact: true })
    .click();
  await expect(
    page.getByRole("table", { name: "Dashboard accounts" }),
  ).toBeVisible();
  await expect(
    page.locator(".dashboard-table-controls .count-pill"),
  ).toHaveText("3 accounts");
});

test("failed filter changes never show cached rows under a different bucket", async ({
  page,
  request,
}) => {
  await signIn(page);
  await expect(
    page.getByRole("table", { name: "Dashboard accounts" }),
  ).toBeVisible();
  await request.post("http://127.0.0.1:3102/__unavailable");
  await page
    .getByRole("button", { name: "View suspended api keys", exact: true })
    .click();
  await expect(page.locator(".dashboard > .api-error")).toContainText(
    "Results for this view are unavailable",
  );
  await expect(
    page.getByRole("table", { name: "Dashboard accounts" }),
  ).toHaveCount(0);
  await expect(
    page.locator(".dashboard-table-controls .count-pill"),
  ).toHaveText("Unavailable");
  await request.post("http://127.0.0.1:3102/__recover");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Dashboard accounts" }),
  ).toBeVisible();
  await expect(
    page.locator(".dashboard-table-controls .count-pill"),
  ).toHaveText("2 keys");
  await expect(page.locator(".dashboard-pagination")).toContainText(
    "Showing 1–2 of 2 keys",
  );
});

test("highest score sorts across pages, preserves filters, and explains monitoring mode", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:3102/__many-accounts");
  await signIn(page, "/?q=acc_&page=2");
  const table = page.getByRole("table", { name: "Dashboard accounts" });
  const sort = page.getByRole("combobox", { name: "Sort by" });
  await expect(sort).toHaveValue("priority");
  await expect(
    page.getByText("Monitoring only", { exact: true }),
  ).toHaveAttribute("title", /not enforced automatically/);
  await expect(
    page.getByText(/Database reachable|Database unverified/),
  ).toHaveCount(0);

  await sort.selectOption("score_desc");
  await expect(page).toHaveURL(/sort=score_desc/);
  await expect(page).not.toHaveURL(/page=2/);
  await expect(page).toHaveURL(/q=acc_/);
  await expect(table.locator("tbody tr").first()).toContainText("acc_bulk_054");
  await expect(
    table.locator("tbody tr").first().locator(".score-number"),
  ).toHaveText("99");
  await page.getByRole("button", { name: "High ≥80", exact: true }).click();
  await expect(page).toHaveURL(/severity=high/);
  await expect(sort).toHaveValue("score_desc");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await page.reload();
  await expect(sort).toHaveValue("score_desc");
  await expect(table.locator("tbody tr").first()).toContainText("acc_bulk_054");

  const calls: { path: string }[] = await (
    await request.get("http://127.0.0.1:3102/__requests")
  ).json();
  expect(
    calls.some(({ path }) => {
      const url = new URL(path, "http://fixture.invalid");
      return (
        url.pathname === "/v1/dashboard" &&
        url.searchParams.get("sort") === "score_desc" &&
        url.searchParams.get("severity") === "high" &&
        url.searchParams.get("q") === "acc_"
      );
    }),
  ).toBe(true);

  await sort.selectOption("priority");
  await expect(page).not.toHaveURL(/sort=/);
  await expect(table.locator("tbody tr").first()).toContainText("acc_high");
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(sort).toBeVisible();
    expect(
      await table.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    if (width === 1440)
      await expect(
        table.locator(".dashboard-row-action .button").first(),
      ).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (width === 320 || width === 1440)
      await page.screenshot({
        path: `test-results/dashboard-sort-${width}.png`,
        fullPage: true,
      });
  }
});

test("inspection drawer traps focus, closes with Escape, and records audited suspension", async ({
  page,
  request,
}) => {
  await signIn(page);
  const trigger = page.getByRole("button", {
    name: "Inspect acc_acme",
    exact: true,
  });
  await trigger.click();
  const drawer = page.getByRole("dialog", { name: "acc_acme", exact: true });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/inspect=acc_acme/);
  const evidence = await drawer.locator(".hit-list").boundingBox();
  const review = await drawer.locator(".review-form").boundingBox();
  const metadata = await drawer
    .locator(".drawer-disclosure")
    .first()
    .boundingBox();
  expect(evidence!.y).toBeLessThan(review!.y);
  expect(review!.y).toBeLessThan(metadata!.y);
  await drawer.screenshot({ path: "test-results/dashboard-drawer.png" });
  const close = drawer.getByRole("button", { name: "Close inspection" });
  await close.focus();
  await page.keyboard.press("Shift+Tab");
  expect(
    await page.evaluate(() => !!document.activeElement?.closest("dialog")),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page
    .getByRole("row")
    .filter({ has: trigger })
    .getByRole("button", { name: "Review", exact: true })
    .click();
  await drawer.getByLabel("Review outcome").selectOption("confirm_takeover");
  await expect(
    drawer.getByText("Affected key:", { exact: false }),
  ).toContainText("key_prod_1");
  await drawer.getByLabel("Your name").fill("Pooja");
  await drawer
    .getByLabel("Reason", { exact: true })
    .fill("Confirmed account takeover with the owner.");
  await drawer.getByRole("button", { name: "Record review" }).click();
  await expect(drawer.locator(".dashboard-toast")).toContainText(
    "Action recorded",
  );
  await expect(drawer.locator(".drawer-score > strong")).toHaveText("75 / 100");
  await expect(
    drawer.getByText("Reviewed: takeover", { exact: true }),
  ).toBeVisible();
  const calls = await (
    await request.get("http://127.0.0.1:3102/__requests")
  ).json();
  expect(
    calls.findLast((call: { body?: unknown }) => !!call.body).body,
  ).toEqual({
    action: "confirm_takeover",
    actor: "Pooja",
    reason: "Confirmed account takeover with the owner.",
  });
  await close.click();
  await page.getByRole("button", { name: "Telemetry", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Analyst audit stream" }),
  ).toContainText("Pooja");
});

test("legitimate approval refreshes membership while preserving the original quarantine score", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:3102/v1/keys/key_prod_1/unblock", {
    headers: { Authorization: "Bearer fixture-analyst-token" },
    data: { actor: "fixture", reason: "Key secured" },
  });
  await signIn(page);
  const row = page.getByRole("row").filter({
    has: page.getByRole("button", { name: "Inspect acc_acme", exact: true }),
  });
  await row.getByRole("button", { name: "Review", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "acc_acme", exact: true });
  await drawer.getByLabel("Your name").fill("Pooja");
  await drawer
    .getByLabel("Reason", { exact: true })
    .fill("Confirmed legitimate traffic with the owner.");
  await drawer.getByRole("button", { name: "Record review" }).click();
  await expect(drawer.locator(".dashboard-toast")).toContainText(
    "Action recorded",
  );
  await expect(drawer.locator(".drawer-score > strong")).toHaveText("75 / 100");
  await expect(
    drawer.getByText("Reviewed: legitimate", { exact: true }),
  ).toBeVisible();
  await drawer.getByRole("button", { name: "Close inspection" }).click();
  await page
    .getByRole("button", { name: "Legitimate baselines", exact: true })
    .click();
  const approved = page.getByRole("row").filter({
    has: page.getByRole("button", { name: "Inspect acc_acme", exact: true }),
  });
  await expect(approved).toContainText("QUARANTINE");
  await expect(approved).toContainText("legitimate");
  await expect(approved.locator(".score-number")).toHaveText("75");
});

test("polling pauses for review drafts and hidden pages, and keeps the last snapshot on failure", async ({
  page,
  request,
}) => {
  await page.clock.install();
  await signIn(page);
  const count = async () => {
    const calls = await (
      await request.get("http://127.0.0.1:3102/__requests")
    ).json();
    return calls.filter((call: { path: string }) =>
      call.path.startsWith("/v1/dashboard"),
    ).length;
  };
  await page
    .getByRole("button", { name: "Inspect acc_acme", exact: true })
    .click();
  const drawer = page.getByRole("dialog", { name: "acc_acme", exact: true });
  await drawer.getByLabel("Your name").fill("Draft analyst");
  await drawer
    .getByLabel("Reason", { exact: true })
    .fill("Evidence still being reviewed.");
  const before = await count();
  await page.clock.runFor(31_000);
  expect(await count()).toBe(before);
  await expect(drawer.getByLabel("Reason", { exact: true })).toHaveValue(
    "Evidence still being reviewed.",
  );
  page.once("dialog", (dialog) => dialog.accept());
  await drawer.getByRole("button", { name: "Close inspection" }).click();
  await expect(drawer).toHaveCount(0);
  await page.evaluate(() =>
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    }),
  );
  const hiddenCount = await count();
  await page.clock.runFor(31_000);
  expect(await count()).toBe(hiddenCount);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(count).toBeGreaterThan(hiddenCount);
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();
  await request.post("http://127.0.0.1:3102/__unavailable");
  await page.clock.runFor(31_000);
  await expect(
    page.locator(".dashboard > .api-error[role=alert]"),
  ).toContainText("Showing the last successful snapshot");
  await expect(
    page.getByRole("button", { name: "Inspect acc_acme", exact: true }),
  ).toBeVisible();
  await request.post("http://127.0.0.1:3102/__recover");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".dashboard > .api-error[role=alert]")).toHaveCount(
    0,
  );
});

test("automatic refresh never overlaps a pending dashboard request", async ({
  page,
}) => {
  await page.clock.install();
  await signIn(page);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let heldRequests = 0;
  await page.route("**/*", async (route) => {
    if (
      route.request().method() === "POST" &&
      route.request().headers()["next-action"]
    ) {
      heldRequests++;
      await gate;
    }
    await route.continue();
  });
  try {
    await page.clock.runFor(30_000);
    await expect.poll(() => heldRequests).toBe(1);
    await page.clock.runFor(90_000);
    expect(heldRequests).toBe(1);
  } finally {
    release();
  }
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();
});

test("an unavailable inspection has a clear error and can be closed", async ({
  page,
}) => {
  await signIn(page, "/?inspect=missing-account");
  const drawer = page.getByRole("dialog", {
    name: "missing-account",
    exact: true,
  });
  await expect(drawer.getByRole("alert")).toContainText("could not be found");
  await expect(
    drawer.getByRole("button", { name: "Record review" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(
    page.getByRole("table", { name: "Dashboard accounts" }),
  ).toBeVisible();
});
