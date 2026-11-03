import {
  test,
  expect,
  MOCK_API,
  id,
  RESOLVE,
  signIn,
  openAccount,
  mockRequests,
} from "./fixtures";

test("empty results and backend failures have explicit states", async ({
  page,
  request,
}) => {
  await request.post(`${MOCK_API}/__empty`);
  await signIn(page);
  await expect(
    page.getByText("Your review queue is clear.", { exact: true }),
  ).toBeVisible();
  await request.post(`${MOCK_API}/__unavailable`);
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
  const review = await page.locator(".incident-decide").boundingBox();
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
    table.getByRole("link", { name: "Open acc_high", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("link", { name: "Open acc_acme", exact: true }),
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
    table.getByRole("link", { name: "Open acc_good", exact: true }),
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
    table.getByRole("link", { name: "Open acc_learning", exact: true }),
  ).toHaveCount(0);
  await page.goto("/?tab=baseline&severity=high&sort=recent");
  await expect(
    table.getByRole("link", { name: "Open acc_good", exact: true }),
  ).toBeVisible();
  await expect(
    table.getByRole("link", { name: "Open acc_learning", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Filter by decision" }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("group", { name: "Sort by" })
      .getByRole("button", { name: "Newest", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await request.post(`${MOCK_API}/__many-accounts`);
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
    table.getByRole("link", { name: /^key_high on acc_high/ }),
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
  await request.post(`${MOCK_API}/__empty`);
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
  await request.post(`${MOCK_API}/__legacy-dashboard`);
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
  await request.post(`${MOCK_API}/__unavailable`);
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
  await request.post(`${MOCK_API}/__recover`);
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
  await request.post(`${MOCK_API}/__many-accounts`);
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
  await page.getByRole("button", { name: "Block", exact: true }).click();
  await expect(page).toHaveURL(/severity=block/);
  await expect(newest).toHaveAttribute("aria-pressed", "true");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await page.reload();
  await expect(newest).toHaveAttribute("aria-pressed", "true");
  await expect(table.locator("tbody tr").first()).toContainText("acc_bulk_054");

  const calls: { path: string }[] = await mockRequests(request);
  expect(
    calls.some(({ path }) => {
      const url = new URL(path, "http://fixture.invalid");
      return (
        url.pathname === "/v1/dashboard" &&
        url.searchParams.get("sort") === "recent" &&
        url.searchParams.get("severity") === "block" &&
        url.searchParams.get("q") === "acc_"
      );
    }),
  ).toBe(true);

  await severe.click();
  await expect(page).not.toHaveURL(/sort=/);
  // The Block filter is still applied, so severity order starts with the
  // highest-scoring block.
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

test("a queue row opens the account page to decide, and Back returns to the filtered queue", async ({
  page,
  request,
}) => {
  await signIn(page, "/?q=acme");
  const card = await openAccount(page);
  await card.getByLabel("Takeover").check();
  await expect(card.locator(".resolve-effects")).toContainText(
    "Suspend key_prod_1 on your authority",
  );
  await card.getByLabel("Your name").fill("Pooja");
  await card
    .getByLabel("Reason", { exact: true })
    .fill("Confirmed account takeover with the owner.");
  await card.getByRole("button", { name: RESOLVE }).click();
  await expect(card.getByRole("status")).toContainText("Resolved as takeover");
  const calls = await mockRequests(request);
  expect(
    calls.findLast((call: { body?: unknown }) => !!call.body)?.body,
  ).toEqual({
    decision_ids: [id],
    outcome: "takeover",
    restore_keys: false,
    actor: "Pooja",
    reason: "Confirmed account takeover with the owner.",
  });
  await page.goBack();
  await expect(page).toHaveURL(/\/\?q=acme$/);
  // The queue row leads with the verdict, the original hold underneath.
  const row = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Open acc_acme", exact: true }),
  });
  await expect(row.locator(".dashboard-decision")).toContainText(
    "Confirmed takeover",
  );
  await expect(row.locator(".dashboard-decision")).toContainText("Was hold");
  await page.getByRole("link", { name: "Telemetry", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Analyst audit stream" }),
  ).toContainText("Pooja");
});

test("polling pauses for hidden pages, and keeps the last snapshot on failure", async ({
  page,
  request,
}) => {
  await page.clock.install();
  await signIn(page);
  const count = async () => {
    const calls = await mockRequests(request);
    return calls.filter((call: { path: string }) =>
      call.path.startsWith("/v1/dashboard"),
    ).length;
  };
  await page.evaluate(() =>
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    }),
  );
  const hiddenCount = await count();
  await page.clock.runFor(31_000);
  await page.waitForTimeout(1_000);
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
  await request.post(`${MOCK_API}/__unavailable`);
  await page.clock.runFor(31_000);
  await expect(
    page.locator(".dashboard > .api-error[role=alert]"),
  ).toContainText("Showing the last successful snapshot");
  await expect(
    page.getByRole("link", { name: "Open acc_acme", exact: true }),
  ).toBeVisible();
  await request.post(`${MOCK_API}/__recover`);
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

test("a page past the end of the list does not claim the queue is empty", async ({
  page,
}) => {
  await signIn(page, "/?page=999");
  await expect(
    page.getByText("No accounts on this page", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Your review queue is clear.")).toHaveCount(0);
});
