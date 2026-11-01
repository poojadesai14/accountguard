import test from "node:test";
import assert from "node:assert/strict";
import {
  dashboardQuery,
  dashboardURL,
  dashboardScope,
  dashboardSnapshotError,
} from "../src/lib/dashboard";
import type { DashboardAccount, DashboardSnapshot } from "../src/lib/types";

test("dashboard query rejects malformed and unbounded filter parameters", () => {
  const query = dashboardQuery({
    tab: "unknown",
    view: ["holds"],
    severity: ["block"],
    sort: ["recent"],
    page: "-4",
    q: "x".repeat(500),
    before_id: "9007199254740992",
    decision: "not-a-uuid",
    inspect: ["account"],
    review: "delete_all",
  });
  assert.equal(query.tab, "attention");
  assert.equal(query.view, "accounts");
  assert.equal(query.severity, "all");
  assert.equal(query.sort, "priority");
  assert.equal(query.page, "1");
  assert.equal(query.q.length, 200);
  assert.equal(query.before_id, "");
  assert.equal(query.decision, "");
  assert.equal(query.inspect, "");
  assert.equal(query.review, "");
});
test("dashboard links preserve search and sorting and safely encode inspected account IDs", () => {
  const query = dashboardQuery({
    tab: "baseline",
    view: "healthy",
    q: "AS14061",
    severity: "hold",
    sort: "recent",
    page: "2",
    inspect: "account / one",
    decision: "11111111-1111-4111-8111-111111111111",
  });
  const url = new URL(dashboardURL(query), "https://dashboard.invalid");
  assert.equal(url.searchParams.get("inspect"), "account / one");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("q"), "AS14061");
  assert.equal(url.searchParams.get("sort"), "recent");
  assert.equal(url.searchParams.get("view"), "healthy");
  assert.equal(url.searchParams.has("severity"), false);
  const closed = new URL(
    dashboardURL(query, { inspect: "", decision: "", review: "" }),
    url,
  );
  assert.equal(closed.searchParams.has("inspect"), false);
  assert.equal(closed.searchParams.get("tab"), "baseline");
  assert.equal(closed.searchParams.get("sort"), "recent");
  assert.equal(closed.searchParams.get("view"), "healthy");
});

test("metric views persist in links and clear when switching to an incompatible tab", () => {
  const cases = [
    { tab: "attention", view: "holds", nextTab: "baseline" },
    { tab: "attention", view: "keys", nextTab: "baseline" },
    { tab: "baseline", view: "healthy", nextTab: "attention" },
  ] as const;
  for (const item of cases) {
    const query = dashboardQuery({
      ...item,
      q: "AS14061",
      sort: "recent",
      page: "2",
    });
    const url = new URL(dashboardURL(query), "https://dashboard.invalid");
    assert.equal(url.searchParams.get("view"), item.view);
    assert.equal(
      dashboardQuery(Object.fromEntries(url.searchParams)).view,
      item.view,
    );
    const changed = new URL(
      dashboardURL(query, { tab: item.nextTab, page: "1" }),
      url,
    );
    assert.equal(changed.searchParams.has("view"), false);
    assert.equal(changed.searchParams.has("page"), false);
    assert.equal(changed.searchParams.get("q"), "AS14061");
    assert.equal(changed.searchParams.get("sort"), "recent");
  }
});

test("severity filters stay on attention and cannot hide baselines through old links", () => {
  const attention = dashboardQuery({
    severity: "block",
    q: "key_good",
    sort: "recent",
  });
  assert.equal(attention.severity, "block");
  for (const tab of ["baseline", "telemetry"] as const) {
    const url = new URL(
      dashboardURL(attention, { tab }),
      "https://dashboard.invalid",
    );
    assert.equal(url.searchParams.has("severity"), false);
    assert.equal(url.searchParams.get("q"), "key_good");
    assert.equal(url.searchParams.get("sort"), "recent");
    for (const severity of ["flag", "hold", "block"])
      assert.equal(dashboardQuery({ tab, severity }).severity, "all");
  }
});

test("dashboard sort accepts highest score and omits the default from links", () => {
  for (const input of [undefined, "priority", "recent", "unknown"]) {
    const query = dashboardQuery({ sort: input });
    const expected = input === "recent" ? "recent" : "priority";
    assert.equal(query.sort, expected);
    const url = new URL(dashboardURL(query), "https://dashboard.invalid");
    assert.equal(
      url.searchParams.get("sort"),
      expected === "priority" ? null : expected,
    );
  }
});

function snapshot(
  total: number,
  view?: DashboardSnapshot["view"],
  page = 1,
): DashboardSnapshot {
  const row: DashboardAccount = {
    account_id: "account",
    events_seen: 100,
    active_hours: 100,
    baseline_ready: true,
    open_reviews: 1,
    suspended_keys: 0,
    key_status: "active",
    decision_id: null,
    event_id: "event",
    api_key_id: "key",
    action: "flag",
    score: 40,
    enforced: false,
    label: null,
    review_status: "open",
    hold_status: null,
    occurred_at: "2026-10-31T00:00:00Z",
    ip: "203.0.113.9",
    asn: 14061,
    asn_org: "Example",
    primary_driver: "new_asn",
    hits: [],
  };
  return {
    view,
    total,
    page,
    limit: 50,
    items: Array.from(
      { length: Math.min(50, Math.max(0, total - (page - 1) * 50)) },
      (_, i) => ({ ...row, account_id: `account_${i}` }),
    ),
    metrics: {
      attention_accounts: total,
      pending_quarantines: 1,
      suspended_keys: 2,
      healthy_baselines: 1,
    },
    generated_at: "2026-10-31T00:00:00Z",
    engine_mode: "shadow",
  };
}

test("dashboard refuses mismatched API views and verifies card totals before showing rows", () => {
  const cases = [
    {
      name: "legacy default account view is compatible",
      query: {},
      data: snapshot(3),
      error: false,
    },
    {
      name: "legacy API ignored held-event drilldown",
      query: { view: "holds" },
      data: snapshot(95),
      error: true,
    },
    {
      name: "legacy API ignored key drilldown",
      query: { view: "keys" },
      data: snapshot(95),
      error: true,
    },
    {
      name: "legacy API returned learning baselines for healthy card",
      query: { tab: "baseline", view: "healthy" },
      data: snapshot(110),
      error: true,
    },
    {
      name: "held-event count agrees with its card",
      query: { view: "holds" },
      data: snapshot(1, "holds"),
      error: false,
    },
    {
      name: "healthy API view still has the wrong total",
      query: { tab: "baseline", view: "healthy" },
      data: snapshot(2, "healthy"),
      error: true,
    },
    {
      name: "global totals differ legitimately after searching",
      query: { q: "account_0" },
      data: { ...snapshot(1), metrics: { ...snapshot(3).metrics } },
      error: false,
    },
    {
      name: "global totals differ legitimately after severity filtering",
      query: { severity: "block" },
      data: { ...snapshot(1), metrics: { ...snapshot(3).metrics } },
      error: false,
    },
    {
      name: "50 visible rows represent 95 total accounts",
      query: {},
      data: snapshot(95),
      error: false,
    },
    {
      name: "missing page rows must not be counted as complete",
      query: {},
      data: { ...snapshot(95), items: snapshot(49).items },
      error: true,
    },
    {
      name: "an out-of-range page is explicitly empty",
      query: { page: "3" },
      data: snapshot(95, "accounts", 3),
      error: false,
    },
    {
      name: "all legitimate baselines can exceed the healthy count",
      query: { tab: "baseline" },
      data: snapshot(2),
      error: false,
    },
  ];
  for (const item of cases)
    assert.equal(
      Boolean(dashboardSnapshotError(dashboardQuery(item.query), item.data)),
      item.error,
      item.name,
    );
});

test("cached table rows belong to their exact view filters sort and page", () => {
  const query = dashboardQuery({});
  const scope = dashboardScope(query);
  for (const patch of [
    { view: "holds" },
    { tab: "baseline" },
    { q: "key" },
    { severity: "block" },
    { sort: "recent" },
    { page: "2" },
  ])
    assert.notEqual(
      dashboardScope(dashboardQuery({ ...query, ...patch })),
      scope,
    );
  assert.equal(
    dashboardScope(
      dashboardQuery({
        ...query,
        inspect: "account",
        decision: "11111111-1111-4111-8111-111111111111",
      }),
    ),
    scope,
  );
  assert.equal(
    dashboardScope(dashboardQuery({ ...query, period: "30d" })),
    scope,
  );
});
