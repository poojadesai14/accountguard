import { test, expect, MOCK_API, signIn, mockRequests } from "./fixtures";

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
  const calls = await mockRequests(request);
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
  await request.post(`${MOCK_API}/__telemetry-history`);
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
  await request.post(`${MOCK_API}/__telemetry-history`);
  await signIn(page);
  await page.getByRole("link", { name: "Telemetry", exact: true }).click();
  const totals = page.locator(".decision-trends .trend-heading strong");
  await expect(totals).toHaveText(["324", "5", "3"]);
  await request.post(`${MOCK_API}/__unavailable`);
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
  await request.post(`${MOCK_API}/__recover`);
  await page.getByRole("button", { name: /Refresh$/ }).click();
  await expect(totals).toHaveText(["65", "2", "1"]);
  await expect(
    page.getByRole("button", { name: "24 hours", exact: true }),
  ).toHaveClass("selected");
  await request.post(`${MOCK_API}/__unavailable`);
  await page.getByRole("button", { name: /Refresh$/ }).click();
  await expect(
    page.locator(".dashboard > .api-error[role=alert]"),
  ).toContainText("Showing the last successful snapshot");
  await expect(totals).toHaveText(["65", "2", "1"]);
});

test("a single held incident has a visible, keyboard-readable chart", async ({
  page,
  request,
}) => {
  await request.post(`${MOCK_API}/__single-bucket`);
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
