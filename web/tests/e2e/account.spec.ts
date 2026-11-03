import { test, expect, id, signIn } from "./fixtures";

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
  await page.getByRole("link", { name: "Open acc_acme", exact: true }).click();
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
