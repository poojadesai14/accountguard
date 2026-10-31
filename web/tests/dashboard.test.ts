import test from "node:test";
import assert from "node:assert/strict";
import { dashboardQuery, dashboardURL } from "../src/lib/dashboard";

test("dashboard query rejects malformed and unbounded filter parameters", () => {
  const query = dashboardQuery({
    tab: "unknown",
    severity: ["high"],
    page: "-4",
    q: "x".repeat(500),
    before_id: "9007199254740992",
    decision: "not-a-uuid",
    inspect: ["account"],
    review: "delete_all",
  });
  assert.equal(query.tab, "attention");
  assert.equal(query.severity, "all");
  assert.equal(query.page, "1");
  assert.equal(query.q.length, 200);
  assert.equal(query.before_id, "");
  assert.equal(query.decision, "");
  assert.equal(query.inspect, "");
  assert.equal(query.review, "");
});
test("dashboard links preserve filters and safely encode inspected account IDs", () => {
  const query = dashboardQuery({
    tab: "baseline",
    q: "AS14061",
    severity: "medium",
    page: "2",
    inspect: "account / one",
    decision: "11111111-1111-4111-8111-111111111111",
  });
  const url = new URL(dashboardURL(query), "https://dashboard.invalid");
  assert.equal(url.searchParams.get("inspect"), "account / one");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("q"), "AS14061");
  const closed = new URL(
    dashboardURL(query, { inspect: "", decision: "", review: "" }),
    url,
  );
  assert.equal(closed.searchParams.has("inspect"), false);
  assert.equal(closed.searchParams.get("tab"), "baseline");
});
