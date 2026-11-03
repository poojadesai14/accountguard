import { test, expect, RESOLVE, signIn, mockRequests } from "./fixtures";

test("suspended key can be restored with an audited reason", async ({
  page,
}) => {
  await signIn(page, "/accounts/acc_acme");
  const line = page.locator(".key-line").first();
  await line.getByText("Restore access", { exact: true }).click();
  await line.getByLabel("Your name").fill("Pooja");
  await line
    .getByLabel("Reason", { exact: true })
    .fill("Key rotated and account secured.");
  // The key was stopped for a young domain: restoring is typed.
  await line.locator(".resolve-warning input").fill("acc_acme");
  await line.getByRole("button", { name: "Restore key access" }).click();
  // The key's line stays as confirmation, now muted and active.
  await expect(page.locator(".key-line").first()).toContainText(
    "key_prod_1 active",
  );
  await expect(page.getByText("Restore access", { exact: true })).toHaveCount(
    0,
  );
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
  // The key was stopped for a young domain: restoring is typed.
  await keyLine.locator(".resolve-warning input").fill("acc_acme");
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

test("a key created by an account change shows before it ever sends, and can be suspended", async ({
  page,
  request,
}) => {
  await signIn(page, "/accounts/acc_acme");
  const backup = page.locator(".key-line", { hasText: "key_backup_2" });
  await expect(backup).toContainText("key_backup_2 active");
  await expect(backup.locator(".key-new")).toContainText(
    "no allowed sends yet",
  );
  // A key that has sent shows no such warning.
  await expect(
    page.locator(".key-line", { hasText: "key_prod_1" }).locator(".key-new"),
  ).toHaveCount(0);
  await backup.getByText("Suspend key", { exact: true }).click();
  await backup.getByLabel("Your name").fill("Pooja");
  await backup
    .getByLabel("Reason", { exact: true })
    .fill("Created during the takeover.");
  await backup.getByRole("button", { name: "Suspend key" }).click();
  await expect(backup.getByRole("status")).toContainText("Key suspended");
  await expect(backup).toContainText("key_backup_2 suspended");
  const calls = await mockRequests(request);
  expect(
    calls.some(
      (call: { path: string }) => call.path === "/v1/keys/key_backup_2/suspend",
    ),
  ).toBe(true);
});

test("after a confirmed takeover, restoring the key is recovery: typed, with a warning", async ({
  page,
}) => {
  await signIn(page, "/accounts/acc_acme");
  const decide = page.locator(".resolve-card", { hasText: "Resolve account" });
  await decide.getByLabel("Takeover").check();
  await decide.getByLabel("Your name").fill("Pooja");
  await decide.getByLabel("Reason", { exact: true }).fill("Owner said not me.");
  await decide.getByRole("button", { name: RESOLVE }).click();
  await expect(decide.getByRole("status")).toContainText(
    "Resolved as takeover",
  );

  await page.goto("/accounts/acc_acme");
  const line = page.locator(".key-line").first();
  await expect(line).toContainText("key_prod_1 suspended · confirmed takeover");
  await line.getByText("Restore after recovery", { exact: true }).click();
  await expect(line.locator(".resolve-warning")).toContainText(
    "locked for a confirmed takeover",
  );
  await line.getByLabel("Your name").fill("Pooja");
  await line
    .getByLabel("Reason", { exact: true })
    .fill("Owner rotated the key.");
  const restore = line.getByRole("button", { name: "Restore key access" });
  await expect(restore).toBeDisabled();
  await line.locator(".resolve-warning input").fill("acc_acme");
  await restore.click();
  await expect(line).toContainText("key_prod_1 active");
});

test("restoring a key stopped for risky signals shows that evidence and is typed", async ({
  page,
}) => {
  await signIn(page, "/accounts/acc_acme");
  const line = page.locator(".key-line").first();
  // The reason is visible before opening anything.
  await expect(line).toContainText(
    "key_prod_1 suspended · stopped for young domain",
  );
  await line.getByText("Restore access", { exact: true }).click();
  const warning = line.locator(".resolve-warning");
  await expect(warning).toContainText(
    "Restoring lets this key send again. It was stopped for:",
  );
  await expect(warning).toContainText(
    "young domain: invoice-portal.net was registered 4 days ago",
  );
  await line.getByLabel("Your name").fill("Pooja");
  await line
    .getByLabel("Reason", { exact: true })
    .fill("Owner confirmed the vendor.");
  const restore = line.getByRole("button", { name: "Restore key access" });
  await expect(restore).toBeDisabled();
  await warning.getByRole("textbox").fill("acc_other");
  await expect(restore).toBeDisabled();
  await warning.getByRole("textbox").fill("acc_acme");
  await restore.click();
  await expect(line).toContainText("key_prod_1 active");
});
