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
  await page.goto("/?q=acme");
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByText("Not an official Resend product")).toBeVisible();
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

test("dashboard metrics and telemetry charts use real API data and date filters", async ({
  page,
  request,
}) => {
  await signIn(page);
  await expect(
    page.getByRole("heading", { name: "Review queue" }),
  ).toBeVisible();
  await expect(page.locator(".view-counts .view-count")).toHaveText([
    "3",
    "1",
    "2",
    "1",
  ]);
  await page.getByRole("link", { name: "Telemetry", exact: true }).click();
  for (const action of ["FLAG", "HOLD", "BLOCK"])
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

test("telemetry chart totals follow each selected range", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:3102/__telemetry-history");
  await signIn(page);
  await page.getByRole("link", { name: "Telemetry", exact: true }).click();
  for (const { range, totals } of [
    { range: "7 days", totals: ["324", "5", "3"] },
    { range: "24 hours", totals: ["65", "2", "1"] },
    { range: "30 days", totals: ["354", "10", "7"] },
    { range: "All time", totals: ["364", "17", "15"] },
    { range: "24 hours", totals: ["65", "2", "1"] },
  ]) {
    await page.getByRole("button", { name: range, exact: true }).click();
    await expect(
      page.locator(".decision-trends .trend-heading strong"),
    ).toHaveText(totals);
  }
});

test("failed telemetry range changes hide old totals and recover without losing the selected range", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:3102/__telemetry-history");
  await signIn(page);
  await page.getByRole("link", { name: "Telemetry", exact: true }).click();
  const totals = page.locator(".decision-trends .trend-heading strong");
  await expect(totals).toHaveText(["324", "5", "3"]);
  await request.post("http://127.0.0.1:3102/__unavailable");
  await page.getByRole("button", { name: "24 hours", exact: true }).click();
  await expect(page).toHaveURL(/period=24h/);
  await expect(
    page.getByText("Telemetry for this range is unavailable", { exact: true }),
  ).toBeVisible();
  await expect(totals).toHaveCount(0);
  await expect(
    page.getByText("Risk drivers for this range are unavailable", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Audit history for this range is unavailable", {
      exact: true,
    }),
  ).toBeVisible();
  await request.post("http://127.0.0.1:3102/__recover");
  await page.getByRole("button", { name: /Refresh$/ }).click();
  await expect(totals).toHaveText(["65", "2", "1"]);
  await expect(
    page.getByRole("button", { name: "24 hours", exact: true }),
  ).toHaveClass("selected");
  await request.post("http://127.0.0.1:3102/__unavailable");
  await page.getByRole("button", { name: /Refresh$/ }).click();
  await expect(
    page.locator(".dashboard > .api-error[role=alert]"),
  ).toContainText("Showing the last successful snapshot");
  await expect(totals).toHaveText(["65", "2", "1"]);
});

test("account search, shared-time charts, timeline and baseline", async ({
  page,
}) => {
  // /accounts is gone: old links land on the queue search with their query.
  await signIn(page, "/accounts?q=acme");
  await expect(page).toHaveURL(/\/\?q=acme$/);
  await expect(
    page.getByRole("searchbox", { name: "Search dashboard" }),
  ).toHaveValue("acme");
  await expect(page.getByText("acc_beta", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Inspect acc_acme", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "acc_acme" })
    .getByRole("link", { name: "Open account" })
    .click();
  await expect(
    page.getByRole("heading", { name: "acc_acme", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Baseline", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /Hourly recipients/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: /ASN observations/ }),
  ).toBeVisible();
  // Events are listed once, in the stream, below the charts.
  await expect(
    page.getByRole("heading", { name: "Event stream" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Event timeline" }),
  ).toHaveCount(0);
  await page.screenshot({
    path: "test-results/account-desktop.png",
    fullPage: true,
  });
});

test("a single held incident has a visible, keyboard-readable chart", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:3102/__single-bucket");
  await signIn(page, "/?tab=telemetry&period=all");
  const chart = page.getByRole("figure", {
    name: "HOLD decisions over time",
  });
  await expect(chart).toBeVisible();
  await chart.getByRole("application").focus();
  await page.keyboard.press("ArrowRight");
  await expect(chart.locator(".recharts-tooltip-wrapper")).toContainText(
    "HOLD",
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
    selected.getByRole("heading", { name: "HOLD", exact: true }),
  ).toBeVisible();
  await expect(
    selected.getByRole("list", { name: "Selected event signals" }),
  ).toContainText("+30");
  // Raw metadata starts collapsed so the signals are read first.
  await expect(metadata).toBeHidden();
  await workspace
    .getByRole("button", { name: "Inspect evt_normal_001", exact: true })
    .click();
  await expect(
    selected.getByRole("heading", { name: "ALLOW", exact: true }),
  ).toBeVisible();
  await expect(
    selected.getByRole("heading", { name: "No scoring signals fired" }),
  ).toBeVisible();
  await selected.getByText("Raw metadata", { exact: true }).click();
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
    .getByRole("group", { name: "Filter event outcomes" })
    .getByRole("button", { name: "Hold", exact: true })
    .click();
  await expect(
    workspace.getByRole("button", {
      name: "Inspect evt_normal_001",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    selected.getByRole("heading", { name: "HOLD", exact: true }),
  ).toBeVisible();
  await workspace
    .getByRole("searchbox", { name: "Filter event stream" })
    .fill("new domain");
  await expect(
    selected.getByRole("heading", { name: "HOLD", exact: true }),
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
    page.getByRole("heading", { name: "Why", exact: true }),
  ).toBeVisible();
});

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
  // The key's line stays as confirmation, now muted and active.
  await expect(page.locator(".key-line").first()).toContainText(
    "key_prod_1 active",
  );
  await expect(page.getByText("Restore access", { exact: true })).toHaveCount(
    0,
  );
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
    page.getByRole("heading", { name: "Review queue" }),
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
  await page.getByRole("link", { name: "Telemetry", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Telemetry", level: 1 }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/telemetry-mobile.png",
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
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(page).toHaveURL(/severity=block/);
  await expect(
    table.getByRole("button", { name: "Inspect acc_high", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("button", { name: "Inspect acc_acme", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "View healthy accounts", exact: true })
    .click();
  await page.getByRole("button", { name: "Clear view", exact: true }).click();
  await expect(
    page.getByRole("group", { name: "Filter by decision" }),
  ).toHaveCount(0);
  await expect(page).not.toHaveURL(/severity=/);
  await expect(page.getByRole("group", { name: "Sort by" })).toBeVisible();
  await expect(
    table.getByRole("button", { name: "Inspect acc_good", exact: true }),
  ).toBeVisible();
  await expect(table).toContainText("Learning baseline");
  await page
    .getByRole("searchbox", { name: "Search dashboard" })
    .fill("key_good");
  await page
    .getByRole("searchbox", { name: "Search dashboard" })
    .press("Enter");
  await expect(page).toHaveURL(/q=key_good/);
  await expect(
    table.getByRole("button", { name: "Inspect acc_learning", exact: true }),
  ).toHaveCount(0);
  await page.goto("/?tab=baseline&severity=high&sort=recent");
  await expect(
    table.getByRole("button", { name: "Inspect acc_good", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("button", { name: "Inspect acc_learning", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Filter by decision" }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("group", { name: "Sort by" })
      .getByRole("button", { name: "Newest", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await request.post("http://127.0.0.1:3102/__many-accounts");
  await page.goto("/");
  await expect(
    page.getByRole("group", { name: "Filter by decision" }),
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
  await signIn(page, "/?q=missing&severity=high&page=2&sort=recent");
  const table = page.getByRole("table", { name: "Dashboard accounts" });
  const holds = page.getByRole("button", {
    name: "View events on hold",
    exact: true,
  });
  const keys = page.getByRole("button", {
    name: "View suspended API keys",
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
  // Held events show how long until they are dropped, not the account state.
  await expect(table.locator("thead")).toContainText("Held event");
  await expect(table.locator("tbody tr").first()).toContainText("Email ·");
  await expect(table.locator("tbody tr").first()).toContainText(
    /Expires in \d+h/,
  );
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
  // Keys lead with the key and say who suspended it, so the list is not a
  // copy of the account queue.
  await expect(table.locator("thead")).toContainText("API key");
  await expect(table.locator("thead")).toContainText("Suspension");
  const firstKey = table.locator("tbody tr").first().locator("td").first();
  await expect(firstKey.locator(".account-inspect")).toHaveText("key_high");
  await expect(firstKey).toContainText("Account acc_high");
  await expect(
    table.getByRole("button", { name: /^key_high on acc_high/ }),
  ).toBeVisible();
  await expect(table).toContainText("Suspended automatically");
  await expect(table).toContainText("Suspended by an analyst");
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
    page.getByRole("group", { name: "Filter by decision" }),
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
    .getByRole("button", { name: "View suspended API keys", exact: true })
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
  await page.getByRole("button", { name: /Refresh$/ }).click();
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

test("newest-first sorts across pages, preserves filters, and explains monitoring mode", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:3102/__many-accounts");
  await signIn(page, "/?q=acc_&page=2");
  const table = page.getByRole("table", { name: "Dashboard accounts" });
  const sort = page.getByRole("group", { name: "Sort by" });
  const severe = sort.getByRole("button", { name: "Most severe", exact: true });
  const newest = sort.getByRole("button", { name: "Newest", exact: true });
  await expect(severe).toHaveAttribute("aria-pressed", "true");
  // The engine mode is stated once, globally, in the top bar.
  await expect(page.locator(".workspace-topbar .mode-chip")).toHaveText(
    "Shadow · not enforced",
  );
  await expect(
    page.getByText(/Database reachable|Database unverified/),
  ).toHaveCount(0);

  await newest.click();
  await expect(page).toHaveURL(/sort=recent/);
  await expect(page).not.toHaveURL(/page=2/);
  await expect(page).toHaveURL(/q=acc_/);
  await expect(table.locator("tbody tr").first()).toContainText("acc_bulk_054");
  await expect(
    table.locator("tbody tr").first().locator(".score-number"),
  ).toHaveText("99");
  await page.getByRole("button", { name: "Flag", exact: true }).click();
  await expect(page).toHaveURL(/severity=flag/);
  await expect(newest).toHaveAttribute("aria-pressed", "true");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await page.reload();
  await expect(newest).toHaveAttribute("aria-pressed", "true");
  await expect(table.locator("tbody tr").first()).toContainText("acc_bulk_054");

  const calls: { path: string }[] = await (
    await request.get("http://127.0.0.1:3102/__requests")
  ).json();
  expect(
    calls.some(({ path }) => {
      const url = new URL(path, "http://fixture.invalid");
      return (
        url.pathname === "/v1/dashboard" &&
        url.searchParams.get("sort") === "recent" &&
        url.searchParams.get("severity") === "flag" &&
        url.searchParams.get("q") === "acc_"
      );
    }),
  ).toBe(true);

  await severe.click();
  await expect(page).not.toHaveURL(/sort=/);
  // The Flag filter is still applied, so severity order starts with the
  // highest-scoring flag.
  await expect(table.locator("tbody tr").first()).toContainText("acc_bulk_054");
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(sort).toBeVisible();
    expect(
      await table.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    if (width === 1440)
      await expect(table.locator(".account-inspect").first()).toBeInViewport();
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
  // The light drawer reads top to bottom: evidence, the review form, then
  // links to the full decision and the account.
  const links = await drawer.locator(".drawer-links").boundingBox();
  expect(evidence!.y).toBeLessThan(review!.y);
  expect(review!.y).toBeLessThan(links!.y);
  await expect(
    drawer.getByRole("link", { name: "Open full decision" }),
  ).toHaveAttribute("href", `/decisions/${id}`);
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
  await trigger.click();
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
  await page.getByRole("link", { name: "Telemetry", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Analyst audit stream" }),
  ).toContainText("Pooja");
});

test("legitimate approval refreshes membership while preserving the original hold score", async ({
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
  await row.getByRole("button", { name: /^Inspect / }).click();
  const drawer = page.getByRole("dialog", { name: "acc_acme", exact: true });
  await drawer.getByLabel("Your name").fill("Pooja");
  await drawer
    .getByLabel("Reason", { exact: true })
    .fill("Confirmed legitimate traffic with the owner.");
  // No outcome is preselected: "Mark legitimate" teaches the baseline, so an
  // unread submit must not record it.
  const outcome = drawer.getByLabel("Review outcome");
  await expect(outcome).toHaveValue("");
  await drawer.getByRole("button", { name: "Record review" }).click();
  await expect(drawer.locator(".dashboard-toast")).toHaveCount(0);
  await outcome.selectOption("mark_legitimate");
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
    .getByRole("button", { name: "View healthy accounts", exact: true })
    .click();
  const approved = page.getByRole("row").filter({
    has: page.getByRole("button", { name: "Inspect acc_acme", exact: true }),
  });
  await expect(approved).toContainText("HOLD");
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
  await expect(page.getByRole("button", { name: /Refresh$/ })).toBeEnabled();
  await request.post("http://127.0.0.1:3102/__unavailable");
  await page.clock.runFor(31_000);
  await expect(
    page.locator(".dashboard > .api-error[role=alert]"),
  ).toContainText("Showing the last successful snapshot");
  await expect(
    page.getByRole("button", { name: "Inspect acc_acme", exact: true }),
  ).toBeVisible();
  await request.post("http://127.0.0.1:3102/__recover");
  await page.getByRole("button", { name: /Refresh$/ }).click();
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
    // Keep advancing until the first refresh is in flight: on a slow runner the
    // polling timer may not be registered yet when the first 30 s elapse.
    await expect
      .poll(async () => {
        if (heldRequests === 0) await page.clock.runFor(30_000);
        return heldRequests;
      })
      .toBe(1);
    await page.clock.runFor(90_000);
    expect(heldRequests).toBe(1);
  } finally {
    release();
  }
  await expect(page.getByRole("button", { name: /Refresh$/ })).toBeEnabled();
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

test("a page past the end of the list does not claim the queue is empty", async ({
  page,
}) => {
  await signIn(page, "/?page=999");
  await expect(
    page.getByText("No accounts on this page", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Your review queue is clear.")).toHaveCount(0);
});

test("marking legitimate says the suspended key is the step left, and offers it", async ({
  page,
}) => {
  await signIn(page, `/decisions/${id}`);
  // The key's state is visible before the review, with restore inline.
  const keyLine = page.locator(".key-line");
  await expect(keyLine).toContainText("key_prod_1 suspended");
  await expect(
    keyLine.getByText("Restore access", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("Review outcome").selectOption("mark_legitimate");
  await page.getByLabel("Your name").fill("Pooja");
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Owner confirmed the new network.");
  await page.getByRole("button", { name: "Record review" }).click();
  // The page refreshes into the labeled state; the key line now says what is left.
  await expect(keyLine).toContainText(
    "Marked legitimate; restore access to finish.",
  );
  await expect(
    keyLine.getByText("Restore access", { exact: true }),
  ).toBeVisible();
});

test("the drawer's review message names the restore, and a restore confirms in place", async ({
  page,
}) => {
  await signIn(page);
  await page
    .getByRole("button", { name: "Inspect acc_acme", exact: true })
    .click();
  const drawer = page.getByRole("dialog", { name: "acc_acme" });
  await drawer.getByLabel("Review outcome").selectOption("mark_legitimate");
  await drawer.getByLabel("Your name").fill("Pooja");
  await drawer
    .getByLabel("Reason", { exact: true })
    .fill("Owner confirmed the new network.");
  await drawer.getByRole("button", { name: "Record review" }).click();
  await expect(drawer.locator(".dashboard-toast")).toContainText(
    "Key key_prod_1 is still suspended: restore access to finish.",
  );
  await drawer.getByRole("button", { name: "Close inspection" }).click();

  // Restoring on the decision page keeps its confirmation after the key turns active.
  await page.goto(`/decisions/${id}`);
  const keyLine = page.locator(".key-line");
  await keyLine.getByText("Restore access", { exact: true }).click();
  await keyLine.getByLabel("Your name").fill("Pooja");
  await keyLine.getByLabel("Reason", { exact: true }).fill("Key rotated.");
  await keyLine.getByRole("button", { name: "Restore key access" }).click();
  await expect(
    keyLine.getByText("Key access restored", { exact: false }),
  ).toBeVisible();
  await expect(keyLine).toContainText("key_prod_1 active");
});

test("a reviewed account whose key is still suspended reads as a restore, not a block", async ({
  page,
}) => {
  await signIn(page);
  const row = page.locator("tr", { hasText: "acc_acme" }).first();
  await expect(row.locator(".dashboard-decision .badge-hold")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Inspect acc_acme", exact: true })
    .click();
  const drawer = page.getByRole("dialog", { name: "acc_acme" });
  await drawer.getByLabel("Review outcome").selectOption("mark_legitimate");
  await drawer.getByLabel("Your name").fill("Pooja");
  await drawer.getByLabel("Reason", { exact: true }).fill("Owner confirmed.");
  await drawer.getByRole("button", { name: "Record review" }).click();
  await expect(drawer.locator(".dashboard-toast")).toContainText(
    "still suspended",
  );
  await drawer.getByRole("button", { name: "Close inspection" }).click();
  await page.reload();
  const decision = row.locator(".dashboard-decision");
  await expect(decision).toContainText("Marked legitimate");
  await expect(decision).toContainText("Was hold · 75");
  await expect(decision.locator(".badge-hold")).toHaveCount(0);
  await expect(row.locator(".dashboard-current-state")).toContainText(
    "Key still suspended",
  );
  await expect(row.locator(".dashboard-current-state")).toContainText(
    "Restore access to finish",
  );
  // The keys view keeps when the key was suspended.
  await page.goto("/?view=keys");
  const keyRow = page.locator("tr", { hasText: "acc_acme" }).first();
  await expect(keyRow.locator(".dashboard-decision")).toContainText(
    "Marked legitimate",
  );
  await expect(keyRow.locator(".dashboard-current-state")).toContainText(
    "Restore access to finish · suspended",
  );
});

test("an account's incident resolves in one audited step, keys only on request", async ({
  page,
}) => {
  await signIn(page, "/accounts/acc_acme");
  const card = page.locator(".resolve-card", { hasText: "Resolve account" });
  await expect(card.locator("summary")).toContainText(
    "1 open review · 1 held email · 1 suspended key",
  );
  await card.locator("summary").click();
  const submit = card.getByRole("button", { name: "Resolve account" });
  await expect(submit).toBeDisabled();
  await card.getByLabel("Legitimate").check();
  await expect(card).toContainText("releases 1 held email");
  const restore = card.getByLabel("Also restore 1 automatically suspended key");
  await expect(restore).not.toBeChecked();
  await card.getByLabel("Your name").fill("Pooja");
  await card.getByLabel("Reason", { exact: true }).fill("Owner confirmed.");
  await submit.click();
  await expect(card.getByRole("status")).toContainText(
    "Resolved as legitimate: 1 review closed, 1 hold released.",
  );
  await expect(submit).toBeDisabled();
  // The key stayed suspended because the box was left unticked; with no review
  // left, the card is gone and the key's own restore is the next step.
  await expect(page.locator(".key-line").first()).toContainText(
    "key_prod_1 suspended",
  );
  await page.reload();
  await expect(
    page.locator(".resolve-card", { hasText: "Resolve account" }),
  ).toHaveCount(0);
});

test("the restore box brings back only the key the resolved reviews suspended", async ({
  page,
}) => {
  await signIn(page, "/accounts/acc_acme");
  const card = page.locator(".resolve-card", { hasText: "Resolve account" });
  await card.locator("summary").click();
  await card.getByLabel("Legitimate").check();
  await card.getByLabel("Also restore 1 automatically suspended key").check();
  await card.getByLabel("Your name").fill("Pooja");
  await card.getByLabel("Reason", { exact: true }).fill("Key rotated.");
  await card.getByRole("button", { name: "Resolve account" }).click();
  await expect(card.getByRole("status")).toContainText("restored key_prod_1");
  await page.reload();
  await expect(
    page.locator(".resolve-card", { hasText: "Resolve account" }),
  ).toHaveCount(0);
  await expect(page.locator(".key-line").first()).toContainText(
    "key_prod_1 active",
  );
});

test("a resolution is refused when the account's reviews changed since it loaded", async ({
  page,
  request,
}) => {
  await signIn(page, "/accounts/acc_acme");
  const card = page.locator(".resolve-card", { hasText: "Resolve account" });
  await card.locator("summary").click();
  await card.getByLabel("Takeover").check();
  await expect(card).toContainText("drops 1 held email");
  await expect(
    card.getByLabel("Also restore 1 automatically suspended key"),
  ).toHaveCount(0);
  await card.getByLabel("Your name").fill("Pooja");
  await card
    .getByLabel("Reason", { exact: true })
    .fill("Confirmed with owner.");
  // The attacker sends again after the page loaded.
  await request.post("http://127.0.0.1:3102/__newer-review");
  await card.getByRole("button", { name: "Resolve account" }).click();
  await expect(card.getByRole("alert")).toContainText(
    "open reviews changed since you loaded it",
  );
});

test("legitimate over takeover evidence needs the account typed, and a wrong call can be corrected", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:3102/__risky-review");
  await signIn(page, "/accounts/acc_acme");
  const card = page
    .locator(".resolve-card", { hasText: "Resolve account" })
    .first();
  await card.locator("summary").click();
  await card.getByLabel("Legitimate").check();
  const warning = card.locator(".resolve-warning");
  await expect(warning).toContainText("young domain");
  await expect(warning).toContainText("docs-share-portal.com");
  const submit = card.getByRole("button", { name: "Resolve account" });
  await card.getByLabel("Also restore 1 automatically suspended key").check();
  await card.getByLabel("Your name").fill("Pooja");
  await card.getByLabel("Reason", { exact: true }).fill("Owner says fine.");
  await expect(submit).toBeDisabled();
  const confirm = warning.getByLabel(/to confirm they are legitimate/);
  await confirm.fill("acc_other");
  await expect(submit).toBeDisabled();
  await confirm.fill("acc_acme");
  await submit.click();
  await expect(card.getByRole("status")).toContainText("restored key_prod_1");

  // The wrong call is corrected: relabelled takeover and the key locked again.
  await page.reload();
  await expect(page.locator(".key-line").first()).toContainText(
    "key_prod_1 active",
  );
  const correction = page.locator(".resolve-card", {
    hasText: "Correct to takeover",
  });
  await expect(correction.locator("summary")).toContainText(
    "1 decision marked legitimate",
  );
  await correction.locator("summary").click();
  await expect(correction.getByRole("checkbox")).toBeChecked();
  await correction.getByLabel("Your name").fill("Pooja");
  await correction
    .getByLabel("Reason", { exact: true })
    .fill("Phishing domain, not the owner.");
  await correction.getByRole("button", { name: "Correct to takeover" }).click();
  await expect(correction.getByRole("status")).toContainText(
    "Corrected: 1 decision relabelled takeover, suspended key_prod_1",
  );
  await page.reload();
  await expect(page.locator(".key-line").first()).toContainText(
    "key_prod_1 suspended",
  );
  await expect(
    page.locator(".resolve-card", { hasText: "Correct to takeover" }),
  ).toHaveCount(0);
});

test("an active key can be suspended directly from its key line", async ({
  page,
}) => {
  await signIn(page, "/accounts/acc_acme");
  // Restore first, so the key is active.
  const keyLine = page.locator(".key-line").first();
  await keyLine.getByText("Restore access", { exact: true }).click();
  await keyLine.getByLabel("Your name").fill("Pooja");
  await keyLine.getByLabel("Reason", { exact: true }).fill("Rotated.");
  await keyLine.getByRole("button", { name: "Restore key access" }).click();
  await expect(keyLine).toContainText("key_prod_1 active");
  await page.reload();

  await keyLine.getByText("Suspend key", { exact: true }).click();
  await keyLine.getByLabel("Your name").fill("Pooja");
  await keyLine
    .getByLabel("Reason", { exact: true })
    .fill("Resolved as legitimate by mistake.");
  await keyLine.getByRole("button", { name: "Suspend key" }).click();
  await expect(keyLine.getByRole("status")).toContainText("Key suspended");
  await expect(keyLine).toContainText("key_prod_1 suspended");
});
