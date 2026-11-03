import {
  test,
  expect,
  MOCK_API,
  id,
  RESOLVE,
  signIn,
  openAccount,
} from "./fixtures";

test("legitimate approval refreshes membership while preserving the original hold score", async ({
  page,
  request,
}) => {
  await request.post(`${MOCK_API}/v1/keys/key_prod_1/unblock`, {
    headers: { Authorization: "Bearer fixture-analyst-token" },
    data: { actor: "fixture", reason: "Key secured", confirm: "acc_acme" },
  });
  await signIn(page);
  const card = await openAccount(page);
  await card.getByLabel("Your name").fill("Pooja");
  await card
    .getByLabel("Reason", { exact: true })
    .fill("Confirmed legitimate traffic with the owner.");
  // No outcome is preselected: "Legitimate" teaches the baseline, so an
  // unread submit must not record it.
  await expect(card.getByLabel("Legitimate")).not.toBeChecked();
  await expect(card.getByLabel("Takeover")).not.toBeChecked();
  await expect(card.getByRole("button", { name: RESOLVE })).toBeDisabled();
  await card.getByLabel("Legitimate").check();
  await card.locator(".resolve-warning input").fill("acc_acme");
  await card.getByRole("button", { name: RESOLVE }).click();
  await expect(card.getByRole("status")).toContainText(
    "Nothing else is open on this account, so it moves to Healthy.",
  );
  await page.goto("/");
  await page
    .getByRole("button", { name: "View healthy accounts", exact: true })
    .click();
  const approved = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Open acc_acme", exact: true }),
  });
  // The verdict leads; the original hold and its score stay underneath.
  await expect(approved).toContainText("Marked legitimate");
  await expect(approved).toContainText("Was hold");
  await expect(approved.locator(".badge-hold")).toHaveCount(0);
  await expect(approved.locator(".score-number")).toHaveText("75");
});

test("the review message names the restore and links to it, and a restore confirms in place", async ({
  page,
}) => {
  await signIn(page);
  const card = await openAccount(page);
  await card.getByLabel("Legitimate").check();
  await card.locator(".resolve-warning input").fill("acc_acme");
  await card.getByLabel("Your name").fill("Pooja");
  await card
    .getByLabel("Reason", { exact: true })
    .fill("Owner confirmed the new network.");
  await card.getByRole("button", { name: RESOLVE }).click();
  const message = card.getByRole("status");
  await expect(message).toContainText(
    "key_prod_1 is still suspended: restore access to finish.",
  );
  await card.getByRole("link", { name: "Restore key_prod_1" }).click();
  await expect(page).toHaveURL(/\/accounts\/acc_acme\?restore=key_prod_1/);
  // The link opens the key's restore form, ready; the restore confirms in place.
  const keyLine = page.locator(".key-line").first();
  await keyLine.getByLabel("Your name").fill("Pooja");
  await keyLine.getByLabel("Reason", { exact: true }).fill("Key rotated.");
  // The key was stopped for a young domain: restoring is typed.
  await keyLine.locator(".resolve-warning input").fill("acc_acme");
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
  const card = await openAccount(page);
  await card.getByLabel("Legitimate").check();
  await card.locator(".resolve-warning input").fill("acc_acme");
  await card.getByLabel("Your name").fill("Pooja");
  await card.getByLabel("Reason", { exact: true }).fill("Owner confirmed.");
  await card.getByRole("button", { name: RESOLVE }).click();
  await expect(card.getByRole("status")).toContainText("still suspended");
  await page.goto("/");
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
  await expect(card.locator(":scope > summary")).toContainText(
    "1 open review · 1 held email · 1 suspended key",
  );
  const submit = card.getByRole("button", { name: RESOLVE });
  await expect(submit).toBeDisabled();
  await card.getByLabel("Legitimate").check();
  await page.locator(".resolve-warning input").fill("acc_acme");
  await expect(card).toContainText("Release 1 held email: they will be sent.");
  await expect(card).toContainText(
    "Restore key_prod_1: it stays suspended (tick the box to restore).",
  );
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
  await card.getByLabel("Legitimate").check();
  await page.locator(".resolve-warning input").fill("acc_acme");
  await card.getByLabel("Also restore 1 automatically suspended key").check();
  await card.getByLabel("Your name").fill("Pooja");
  await card.getByLabel("Reason", { exact: true }).fill("Key rotated.");
  await card.getByRole("button", { name: RESOLVE }).click();
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
  await card.getByLabel("Takeover").check();
  await expect(card).toContainText("Drop 1 held email: never sent.");
  await expect(card).toContainText("Restore any key or release any email.");
  await expect(
    card.getByLabel("Also restore 1 automatically suspended key"),
  ).toHaveCount(0);
  await card.getByLabel("Your name").fill("Pooja");
  await card
    .getByLabel("Reason", { exact: true })
    .fill("Confirmed with owner.");
  // The attacker sends again after the page loaded.
  await request.post(`${MOCK_API}/__newer-review`);
  await card.getByRole("button", { name: RESOLVE }).click();
  await expect(card.getByRole("alert")).toContainText(
    "open reviews changed since you loaded it",
  );
});

test("legitimate over takeover evidence needs the account typed, and a wrong call can be corrected", async ({
  page,
  request,
}) => {
  await request.post(`${MOCK_API}/__risky-review`);
  await signIn(page, "/accounts/acc_acme");
  const card = page
    .locator(".resolve-card", { hasText: "Resolve account" })
    .first();
  await card.getByLabel("Legitimate").check();
  const warning = card.locator(".resolve-warning");
  await expect(warning).toContainText("young domain");
  await expect(warning).toContainText("docs-share-portal.com");
  const submit = card.getByRole("button", { name: RESOLVE });
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

test("resolving spells out what it will and won't do, lists the reviews and names the button", async ({
  page,
}) => {
  await signIn(page, "/accounts/acc_acme");
  const card = page.locator(".resolve-card", { hasText: "Resolve account" });
  // The reviews are one click away, each linked to its page.
  await card.getByText("See the 1 review this resolves").click();
  await expect(card.locator(".resolve-list li")).toHaveCount(1);
  await expect(card.locator(".resolve-list")).toContainText(
    "hold 75 · new asn · email held",
  );
  await expect(card.locator(".resolve-list a")).toHaveAttribute(
    "href",
    `/decisions/${id}`,
  );
  await expect(card).toContainText(
    "Choose an outcome to see exactly what it will and won't change.",
  );

  await card.getByLabel("Takeover").check();
  const effects = card.locator(".resolve-effects");
  await expect(effects).toContainText("Label 1 review takeover.");
  await expect(effects).toContainText("Drop 1 held email: never sent.");
  await expect(effects).toContainText("Suspend key_prod_1 on your authority");
  await expect(effects).toContainText(
    "Teach the baseline anything from these emails.",
  );
  await expect(
    card.getByRole("button", { name: "Resolve 1 review as takeover" }),
  ).toBeVisible();

  await card.getByLabel("Legitimate").check();
  await expect(effects).toContainText(
    "Release 1 held email: they will be sent.",
  );
  await expect(effects).toContainText(
    "Restore key_prod_1: it stays suspended (tick the box to restore).",
  );
  await card.getByLabel("Also restore 1 automatically suspended key").check();
  await expect(effects).toContainText("Restore key_prod_1: it can send again.");
  await expect(effects).not.toContainText("it stays suspended");
  await expect(
    card.getByRole("button", { name: "Resolve 1 review as legitimate" }),
  ).toBeVisible();
});
