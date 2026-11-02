import {
  test,
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { API, ANALYST, ATTACKED, QUIET } from "./world";

// The analyst's main journeys, end to end: browser → UI → real API → Postgres.
// One shared world (world.ts), so the scenarios run in order on separate accounts.
test.describe.configure({ mode: "serial" });

async function signIn(page: Page, path = "/") {
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await page.getByLabel("Workspace password").fill("fullstack-password");
  await page.locator("form button").first().click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

async function api<T>(request: APIRequestContext, path: string): Promise<T> {
  const res = await request.get(`${API}${path}`, { headers: ANALYST });
  expect(res.ok(), `${path}: HTTP ${res.status()}`).toBeTruthy();
  return (await res.json()) as T;
}

type Row = { account_id: string; decision_id: string; api_key_id: string };
const rows = async (request: APIRequestContext, query: string) =>
  (
    await api<{ items: Row[]; total: number }>(
      request,
      `/v1/dashboard?${query}`,
    )
  ).items;
type Profile = {
  profile: {
    key_asns: Record<string, Record<string, number>>;
    known_domains: Record<string, number>;
  };
  key_status: { api_key_id: string; status: string; reason: string }[] | null;
  open: { reviews: number; pending_holds: number };
};
const profile = (request: APIRequestContext, account: string) =>
  api<Profile>(request, `/v1/accounts/${account}/profile`);
const keyOf = async (request: APIRequestContext, account: string) =>
  (await profile(request, account)).key_status?.find(
    (k) => k.api_key_id === `${account}_key`,
  );

async function identity(scope: Locator, reason: string) {
  await scope.getByLabel("Your name").fill("Fullstack");
  await scope.getByLabel("Reason", { exact: true }).fill(reason);
}

const resolveCard = (page: Page) =>
  page.locator(".resolve-card", { hasText: "Resolve account" });

test("the engine's calls reach the queue: attacks queued, flags and quiet accounts not", async ({
  page,
  request,
}) => {
  const queued = (await rows(request, "limit=100")).map((r) => r.account_id);
  for (const account of Object.values(ATTACKED))
    expect(queued).toContain(account);
  expect(queued).not.toContain(QUIET.quiet);
  expect(queued).not.toContain(QUIET.flagged); // a flag never opens a review
  const keys = (await rows(request, "view=keys&limit=100")).map(
    (r) => r.api_key_id,
  );
  for (const account of Object.values(ATTACKED))
    expect(keys).toContain(`${account}_key`);

  await signIn(page);
  const table = page.getByRole("table").first();
  for (const account of Object.values(ATTACKED))
    await expect(table).toContainText(account);
  await expect(table).not.toContainText(QUIET.quiet);
});

test("a held send explains itself and links the campaign across accounts", async ({
  page,
  request,
}) => {
  const [hold] = await rows(request, `view=holds&q=${ATTACKED.takeover}`);
  await signIn(page, `/decisions/${hold.decision_id}`);
  const why = page.locator("section", { hasText: "Why" }).first();
  for (const signal of [
    "new asn",
    "new domain",
    "young domain",
    "invoice-portal.net",
  ])
    await expect(why).toContainText(signal);
  // The same young domain was sent by the other attacked accounts.
  const related = page.locator("section", {
    hasText: "Same infrastructure on other accounts",
  });
  await expect(related).toContainText(ATTACKED.vendor);
});

test("a takeover is resolved in one step: reviews closed, holds dropped, key kept suspended", async ({
  page,
  request,
}) => {
  const account = ATTACKED.takeover;
  await signIn(page, `/accounts/${account}`);
  const card = resolveCard(page);
  await card.locator("summary").click();
  await card.getByLabel("Takeover").check();
  await expect(card.locator(".resolve-warning")).toHaveCount(0); // no typing for takeover
  await identity(card, "New network and a 6-day-old domain.");
  await card.getByRole("button", { name: "Resolve account" }).click();
  await expect(card.getByRole("status")).toContainText("Resolved as takeover");

  const p = await profile(request, account);
  expect(p.open).toMatchObject({ reviews: 0, pending_holds: 0 });
  expect(await keyOf(request, account)).toMatchObject({
    status: "suspended",
    reason: "analyst",
  });
  // Still in the queue (its key is locked), led by the verdict.
  await page.goto(`/?q=${account}`);
  const row = page.locator("tr", { hasText: account }).first();
  await expect(row.locator(".dashboard-decision")).toContainText(
    "Confirmed takeover",
  );
  const actions = await api<{ items: { action: string; actor: string }[] }>(
    request,
    "/v1/analyst-actions?limit=200",
  );
  expect(
    actions.items.some(
      (a) => a.action === "confirm_takeover" && a.actor === "Fullstack",
    ),
  ).toBeTruthy();
});

test("a false positive over takeover evidence needs the account typed, then reaches Healthy", async ({
  page,
  request,
}) => {
  const account = ATTACKED.vendor;
  await signIn(page, `/accounts/${account}`);
  const card = resolveCard(page);
  await card.locator("summary").click();
  await card.getByLabel("Legitimate").check();
  const warning = card.locator(".resolve-warning");
  await expect(warning).toContainText("young domain");
  await card.getByLabel("Also restore 1 automatically suspended key").check();
  await identity(card, "Owner confirmed the new vendor.");
  const submit = card.getByRole("button", { name: "Resolve account" });
  await expect(submit).toBeDisabled();
  await warning.getByRole("textbox").fill(account);
  await submit.click();
  await expect(card.getByRole("status")).toContainText(
    `restored ${account}_key`,
  );

  expect(await keyOf(request, account)).toMatchObject({ status: "active" });
  const healthy = (
    await rows(request, `view=healthy&segment=baseline&q=${account}`)
  ).map((r) => r.account_id);
  expect(healthy).toContain(account);
  await page.goto(`/?tab=baseline&view=healthy&q=${account}`);
  await expect(
    page
      .locator("tr", { hasText: account })
      .first()
      .locator(".dashboard-decision"),
  ).toContainText("Marked legitimate");
});

test("a wrong legitimate call is corrected: relabelled, unlearned and re-locked", async ({
  page,
  request,
}) => {
  const account = ATTACKED.oops;
  await signIn(page, `/accounts/${account}`);
  const card = resolveCard(page);
  await card.locator("summary").click();
  await card.getByLabel("Legitimate").check();
  await card.getByLabel("Also restore 1 automatically suspended key").check();
  await card.locator(".resolve-warning").getByRole("textbox").fill(account);
  await identity(card, "Looked fine at first.");
  await card.getByRole("button", { name: "Resolve account" }).click();
  await expect(card.getByRole("status")).toContainText("restored");
  let p = await profile(request, account);
  expect(p.profile.key_asns[`${account}_key`]?.["14061"]).toBeGreaterThan(0);
  expect(p.profile.known_domains["invoice-portal.net"]).toBeGreaterThan(0);

  await page.reload();
  const correction = page.locator(".resolve-card", {
    hasText: "Correct to takeover",
  });
  await correction.locator("summary").click();
  await identity(correction, "The domain is a phishing kit.");
  await correction.getByRole("button", { name: "Correct to takeover" }).click();
  await expect(correction.getByRole("status")).toContainText(
    `suspended ${account}_key`,
  );

  p = await profile(request, account);
  expect(p.profile.key_asns[`${account}_key`]?.["14061"]).toBeUndefined();
  expect(p.profile.known_domains["invoice-portal.net"]).toBeUndefined();
  expect(await keyOf(request, account)).toMatchObject({
    status: "suspended",
    reason: "analyst",
  });
  await page.reload();
  await expect(
    page.locator(".resolve-card", { hasText: "Correct to takeover" }),
  ).toHaveCount(0);
});

test("one decision at a time: the review says what's left and links to it", async ({
  page,
  request,
}) => {
  const account = ATTACKED.stepwise;
  // The key row's decision is the block that suspended it.
  const [keyRow] = await rows(request, `view=keys&q=${account}`);
  await signIn(page, `/decisions/${keyRow.decision_id}`);
  await page.getByLabel("Review outcome").selectOption("mark_legitimate");
  await page.locator(".resolve-warning").getByRole("textbox").fill(account);
  await identity(page.locator(".review-form"), "Owner confirmed this send.");
  await page.getByRole("button", { name: "Record review" }).click();
  const feedback = page
    .getByRole("status")
    .filter({ hasText: "Marked legitimate" });
  await expect(feedback).toContainText("still open on this account");
  await expect(feedback).toContainText(`Key ${account}_key is still suspended`);

  await page.getByRole("link", { name: "Resolve the rest" }).click();
  await expect(page).toHaveURL(new RegExp(`/accounts/${account}\\?resolve=1`));
  const card = resolveCard(page);
  await card.getByLabel("Legitimate").check();
  await card.getByLabel("Also restore 1 automatically suspended key").check();
  await card.locator(".resolve-warning").getByRole("textbox").fill(account);
  await identity(card, "Same vendor, rest of the batch.");
  await card.getByRole("button", { name: "Resolve account" }).click();
  await expect(card.getByRole("status")).toContainText(
    `restored ${account}_key`,
  );
  const healthy = (
    await rows(request, `view=healthy&segment=baseline&q=${account}`)
  ).map((r) => r.account_id);
  expect(healthy).toContain(account);
});

test("any key can be suspended and restored by hand", async ({
  page,
  request,
}) => {
  const account = QUIET.quiet;
  await signIn(page, `/accounts/${account}`);
  const line = page.locator(".key-line", { hasText: `${account}_key` });
  await line.getByText("Suspend key", { exact: true }).click();
  await identity(line, "Owner reported a leaked key.");
  await line.getByRole("button", { name: "Suspend key" }).click();
  await expect(line.getByRole("status")).toContainText("Key suspended");
  expect(await keyOf(request, account)).toMatchObject({ status: "suspended" });
  expect(
    (await rows(request, `q=${account}`)).map((r) => r.account_id),
  ).toContain(account);

  await page.reload();
  await line.getByText("Restore access", { exact: true }).click();
  await identity(line, "Key rotated.");
  await line.getByRole("button", { name: "Restore key access" }).click();
  await expect(line).toContainText(`${account}_key active`);
  expect(
    (await rows(request, `view=healthy&segment=baseline&q=${account}`)).map(
      (r) => r.account_id,
    ),
  ).toContain(account);
});
