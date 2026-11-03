// Local-only API for the browser tests: the route table and the state the tests
// drive through /__ control routes. Fixture data lives in mock-fixtures.ts.
import { createServer } from "node:http";
import type {
  DashboardAccount,
  DecisionDetail,
  GlobalAuditAction,
} from "../src/lib/types";
import {
  config,
  decisionId,
  event,
  hits,
  hours,
  initialDetail,
  series,
  stats,
  telemetryStats,
  timeline,
} from "./mock-fixtures";

let detail: DecisionDetail;
let suspended = true;
// The attacker's backup key: created by an account change, never sent.
let backupSuspended = false;
let newerReview = false; // a review the page hasn't seen yet
let requests: { path: string; body?: Record<string, string> }[] = [];
let empty = false;
let unavailable = false;
let singleBucket = false;
let telemetryHistory = false;
let manyAccounts = false;
let legacyDashboard = false;
let auditRecords: GlobalAuditAction[] = [];
function reset() {
  detail = initialDetail();
  suspended = true;
  backupSuspended = false;
  newerReview = false;
  requests = [];
  empty = false;
  unavailable = false;
  singleBucket = false;
  telemetryHistory = false;
  manyAccounts = false;
  legacyDashboard = false;
  auditRecords = [];
}
reset();

// Mirrors store.RiskySignals: "legitimate" over these needs the account ID typed.
const risky = () =>
  detail.decision.hits.some((h) =>
    [
      "young_domain",
      "lookalike_domain",
      "recipient_spike",
      "freemail_reply_to",
    ].includes(h.name),
  );

// Test controls: each switches the API into one scenario until the next reset.
const CONTROLS: Record<string, () => void> = {
  "/__reset": reset,
  "/__risky-review": () => {
    detail.decision.hits = [
      ...detail.decision.hits,
      {
        name: "young_domain",
        category: "content",
        points: 20,
        detail: "docs-share-portal.com registered 6 days ago",
      },
    ];
  },
  "/__newer-review": () => (newerReview = true),
  "/__empty": () => (empty = true),
  "/__unavailable": () => (unavailable = true),
  "/__single-bucket": () => (singleBucket = true),
  "/__telemetry-history": () => (telemetryHistory = true),
  "/__many-accounts": () => (manyAccounts = true),
  "/__legacy-dashboard": () => (legacyDashboard = true),
  "/__recover": () => {
    unavailable = false;
    legacyDashboard = false;
  },
};

function dashboardAccounts(): DashboardAccount[] {
  const base: DashboardAccount = {
    account_id: "acc_acme",
    events_seen: 6200,
    active_hours: 260,
    baseline_ready: true,
    open_reviews: detail.decision.review_status === "open" ? 1 : 0,
    suspended_keys: suspended ? 1 : 0,
    key_status: suspended ? "suspended" : "active",
    decision_id: decisionId,
    event_id: event.event_id,
    api_key_id: "key_prod_1",
    action: "hold",
    score: 75,
    enforced: true,
    label: detail.decision.label,
    review_status: detail.decision.review_status,
    hold_status: detail.decision.hold_status,
    hold_expires_at: detail.decision.hold_expires_at,
    event_type: "email.send",
    change_kind: null,
    key_suspended_by: suspended ? "auto" : null,
    key_suspended_at: suspended ? hours[11] : null,
    restore_pending:
      suspended &&
      detail.decision.review_status !== "open" &&
      detail.decision.label === "legitimate",
    occurred_at: hours[10],
    ip: "203.0.113.9",
    asn: 14061,
    asn_org: "DIGITALOCEAN-ASN",
    primary_driver: "new_asn",
    hits,
  };
  return empty
    ? []
    : [
        base,
        {
          ...base,
          account_id: "acc_beta",
          decision_id: null,
          api_key_id: "key_beta",
          action: "flag",
          score: 40,
          suspended_keys: 0,
          key_status: "active",
          key_suspended_by: null,
          key_suspended_at: null,
          open_reviews: 1,
          label: null,
        },
        {
          ...base,
          account_id: "acc_high",
          decision_id: null,
          api_key_id: "key_high",
          action: "block",
          score: 80,
          suspended_keys: 1,
          key_status: "suspended",
          key_suspended_by: "analyst",
          key_suspended_at: hours[9],
          open_reviews: 1,
          label: null,
        },
        {
          ...base,
          account_id: "acc_good",
          decision_id: null,
          api_key_id: "key_good",
          action: "allow",
          score: 5,
          suspended_keys: 0,
          key_status: "active",
          key_suspended_by: null,
          key_suspended_at: null,
          open_reviews: 0,
          label: null,
        },
        {
          ...base,
          account_id: "acc_learning",
          decision_id: null,
          api_key_id: "key_learning",
          action: "allow",
          score: 0,
          suspended_keys: 0,
          key_status: "active",
          key_suspended_by: null,
          key_suspended_at: null,
          open_reviews: 0,
          events_seen: 1,
          active_hours: 1,
          baseline_ready: false,
          label: null,
        },
        ...(manyAccounts
          ? Array.from({ length: 55 }, (_, index) => ({
              ...base,
              account_id: `acc_bulk_${String(index).padStart(3, "0")}`,
              api_key_id: `key_bulk_${String(index).padStart(3, "0")}`,
              action: index === 54 ? "flag" : base.action,
              score: index === 54 ? 99 : base.score,
              occurred_at: index === 54 ? hours[11] : base.occurred_at,
              decision_id: null,
            }))
          : []),
      ];
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1:3102");
  const reply = (status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === "/healthz") return reply(200, { ok: true });
  if (url.pathname === "/v1/config") return reply(200, config);
  const control = CONTROLS[url.pathname];
  if (control && req.method === "POST") {
    control();
    return reply(200, {});
  }
  if (url.pathname === "/__requests") return reply(200, requests);
  if (req.headers.authorization !== "Bearer fixture-analyst-token")
    return reply(401, { error: "missing token" });
  if (unavailable) return reply(503, { error: "unavailable" });
  if (req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: url.pathname, body });
    auditRecords.unshift({
      id: auditRecords.length + 1,
      account_id: "acc_acme",
      api_key_id: "key_prod_1",
      decision_id: decisionId,
      action: url.pathname.endsWith("/suspend")
        ? "suspend_key"
        : url.pathname.endsWith("/correct")
          ? "correct_to_takeover"
          : "unblock_key",
      actor: body.actor ?? "owner",
      reason: body.reason ?? "Owner response",
      created_at: new Date().toISOString(),
    });
    if (url.pathname === "/v1/keys/key_backup_2/suspend") {
      backupSuspended = true;
      return reply(200, {
        api_key_id: "key_backup_2",
        status: "suspended",
        holds_dropped: 0,
      });
    }
    if (url.pathname.endsWith("/suspend")) {
      if (suspended) return reply(409, { error: "key is already suspended" });
      suspended = true;
      const dropped = detail.decision.hold_status === "pending" ? 1 : 0;
      if (dropped) detail.decision.hold_status = "dropped";
      return reply(200, {
        api_key_id: "key_prod_1",
        status: "suspended",
        holds_dropped: dropped,
      });
    }
    if (url.pathname.endsWith("/correct")) {
      if (
        detail.decision.label !== "legitimate" ||
        JSON.stringify(body.decision_ids) !== JSON.stringify([decisionId])
      )
        return reply(409, {
          error: "decision is not marked legitimate; reload and try again",
        });
      detail.decision.label = "takeover";
      suspended = true;
      return reply(200, {
        corrected: 1,
        holds_dropped: 0,
        keys_suspended: ["key_prod_1"],
      });
    }
    if (
      url.pathname.endsWith("/unblock") &&
      detail.decision.label === "takeover" &&
      body.confirm !== "acc_acme"
    )
      return reply(409, {
        error:
          "this key was locked for a confirmed takeover: type the account ID to confirm the owner has secured the account and rotated credentials",
      });
    if (
      url.pathname.endsWith("/unblock") &&
      risky() &&
      body.confirm !== "acc_acme"
    )
      return reply(409, {
        error:
          "restoring lets this key send again, and the emails it was stopped for show young_domain: type the account ID to confirm",
      });
    if (url.pathname.endsWith("/unblock")) {
      suspended = false;
      return reply(200, { status: "active" });
    }
    if (url.pathname.endsWith("/resolve")) {
      // Mirrors the API: only the reviews the analyst saw, and only a key they suspended.
      const open = detail.decision.review_status === "open";
      const pending = detail.decision.hold_status === "pending";
      if (body.outcome === "takeover" && body.restore_keys)
        return reply(400, {
          error: "keys can only be restored when resolving as legitimate",
        });
      if (!open)
        return reply(409, { error: "nothing to resolve on this account" });
      if (
        risky() &&
        body.outcome === "legitimate" &&
        body.confirm !== "acc_acme"
      )
        return reply(409, {
          error:
            "these reviews show young_domain: type the account ID to confirm they are legitimate",
        });
      const openIds = newerReview ? [decisionId, "newer"] : [decisionId];
      if (JSON.stringify(body.decision_ids) !== JSON.stringify(openIds))
        return reply(409, {
          error:
            "this account's open reviews changed since you loaded it; reload and review again",
        });
      const restorable = suspended && detail.decision.label !== "takeover";
      detail.decision.label = body.outcome;
      detail.decision.review_status = "resolved";
      if (pending)
        detail.decision.hold_status =
          body.outcome === "legitimate" ? "released" : "dropped";
      const restored = body.restore_keys && restorable ? ["key_prod_1"] : [];
      if (restored.length) suspended = false;
      const takenOver = body.outcome === "takeover" ? ["key_prod_1"] : [];
      if (takenOver.length) suspended = true;
      return reply(200, {
        outcome: body.outcome,
        resolved: 1,
        holds_released: pending && body.outcome === "legitimate" ? 1 : 0,
        holds_dropped: pending && body.outcome === "takeover" ? 1 : 0,
        keys_restored: restored,
        keys_suspended: takenOver,
      });
    }
    if (url.pathname.endsWith("/owner-response")) {
      detail.decision.hold_status =
        body.response === "this_was_me" ? "released" : "dropped";
      detail.decision.label =
        body.response === "this_was_me" ? "legitimate" : "takeover";
      detail.decision.review_status = "resolved";
      return reply(200, detail.decision);
    }
    return reply(404, {});
  }
  requests.push({ path: url.pathname + url.search });
  if (url.pathname === "/v1/dashboard") {
    const view = legacyDashboard
      ? "accounts"
      : (url.searchParams.get("view") ?? "accounts");
    const all = dashboardAccounts();
    const baseline = (item: DashboardAccount) =>
      !item.open_reviews &&
      !item.suspended_keys &&
      (item.action === "allow" || item.label === "legitimate");
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const filtered = all
      .filter((item) => {
        if (view === "holds")
          return item.hold_status === "pending" && item.decision_id != null;
        if (view === "keys") return item.key_status === "suspended";
        if (view === "flagged")
          return (
            !item.open_reviews &&
            !item.suspended_keys &&
            item.action === "flag" &&
            item.label !== "legitimate"
          );
        if (url.searchParams.get("segment") === "baseline")
          return baseline(item) && (view !== "healthy" || item.baseline_ready);
        return !!(item.open_reviews || item.suspended_keys);
      })
      .filter((item) =>
        ["hold", "block"].includes(url.searchParams.get("severity") ?? "")
          ? item.action === url.searchParams.get("severity")
          : true,
      )
      .filter((item) =>
        [
          item.account_id,
          item.api_key_id,
          item.ip,
          `AS${item.asn}`,
          item.primary_driver,
          item.primary_driver.replaceAll("_", " "),
        ].some((value) => (value ?? "").toLowerCase().includes(q)),
      );
    const priority = { allow: 0, flag: 1, hold: 2, block: 3 };
    filtered.sort((a, b) => {
      const scores = (b.score ?? -1) - (a.score ?? -1);
      const recency =
        Date.parse(b.occurred_at ?? "1970-01-01") -
        Date.parse(a.occurred_at ?? "1970-01-01");
      return (
        (url.searchParams.get("sort") === "recent" ? recency : 0) ||
        (b.action ? priority[b.action] : -1) -
          (a.action ? priority[a.action] : -1) ||
        scores ||
        Date.parse(b.occurred_at ?? "1970-01-01") -
          Date.parse(a.occurred_at ?? "1970-01-01") ||
        a.account_id.localeCompare(b.account_id)
      );
    });
    const page = Number(url.searchParams.get("page") ?? 1),
      limit = 50;
    return reply(200, {
      ...(legacyDashboard ? {} : { view }),
      metrics: {
        attention_accounts: all.filter(
          (item) => item.open_reviews || item.suspended_keys,
        ).length,
        pending_quarantines: empty
          ? 0
          : detail.decision.hold_status === "pending"
            ? 1
            : 0,
        suspended_keys: all.reduce(
          (total, item) => total + item.suspended_keys,
          0,
        ),
        flagged_accounts: all.filter(
          (item) =>
            !item.open_reviews &&
            !item.suspended_keys &&
            item.action === "flag" &&
            item.label !== "legitimate",
        ).length,
        healthy_baselines: all.filter(
          (item) => baseline(item) && item.baseline_ready,
        ).length,
      },
      items: filtered.slice((page - 1) * limit, page * limit),
      total: filtered.length,
      page,
      limit,
      generated_at: new Date().toISOString(),
      engine_mode: "shadow",
    });
  }
  if (url.pathname === "/v1/analyst-actions") {
    const before = Number(url.searchParams.get("before_id") ?? 0);
    const actions = auditRecords.filter((item) => !before || item.id < before);
    return reply(200, {
      items: actions.slice(0, 50),
      next_before_id: actions.length > 50 ? actions[49].id : null,
    });
  }
  if (url.pathname === "/v1/stats")
    return reply(
      200,
      empty
        ? {
            totals: { events: 0, allow: 0, flag: 0, hold: 0, block: 0 },
            series: null,
            top_signals: null,
            review_queue: null,
          }
        : singleBucket
          ? {
              ...stats,
              totals: { events: 1, allow: 0, flag: 0, hold: 1, block: 0 },
              series: [{ t: hours[10], flag: 0, hold: 1, block: 0 }],
            }
          : telemetryHistory
            ? telemetryStats(url)
            : stats,
    );
  if (url.pathname.endsWith("/profile")) {
    if (!url.pathname.includes("acc_acme"))
      return reply(404, { error: "not found" });
    return reply(200, {
      profile: {
        account_id: "acc_acme",
        first_seen_at: "2026-09-01T10:00:00Z",
        events_seen: 6200,
        key_asns: { key_prod_1: { "16509": 6200 } },
        known_domains: { "stripe.com": 400, "twitter.com": 120 },
        sender_domains: ["acme.com"],
        used_freemail_reply_to: false,
        hourly_ewma: 41.5,
        active_hours: 260,
        read_resources: ["domains"],
        last_change_at: hours[8],
      },
      legitimate_decisions:
        detail.decision.label === "legitimate"
          ? [
              {
                decision_id: decisionId,
                occurred_at: hours[10],
                action: "hold",
                score: 75,
                api_key_id: "key_prod_1",
                primary_driver: "new_asn",
              },
            ]
          : [],
      open: {
        reviews: detail.decision.review_status === "open" ? 1 : 0,
        pending_holds: detail.decision.hold_status === "pending" ? 1 : 0,
        suspended_keys: suspended ? 1 : 0,
        restorable_keys:
          suspended &&
          (detail.decision.review_status === "open" ||
            detail.decision.label === "legitimate")
            ? 1
            : 0,
        decision_ids:
          detail.decision.review_status === "open" ? [decisionId] : [],
        list:
          detail.decision.review_status === "open"
            ? [
                {
                  decision_id: decisionId,
                  occurred_at: hours[10],
                  action: "hold",
                  score: 75,
                  hold_status: detail.decision.hold_status,
                  hold_expires_at:
                    detail.decision.hold_status === "pending"
                      ? detail.decision.hold_expires_at
                      : null,
                  api_key_id: "key_prod_1",
                  primary_driver: "new_asn",
                  detail:
                    "AS14061 DIGITALOCEAN-ASN first seen for key key_prod_1",
                },
              ]
            : [],
        suspended_key_ids: suspended ? ["key_prod_1"] : [],
        restorable_key_ids:
          suspended &&
          (detail.decision.review_status === "open" ||
            detail.decision.label === "legitimate")
            ? ["key_prod_1"]
            : [],
        review_key_ids:
          detail.decision.review_status === "open" ? ["key_prod_1"] : [],
        holds_expire_at:
          detail.decision.hold_status === "pending"
            ? detail.decision.hold_expires_at
            : null,
        warnings:
          risky() && detail.decision.review_status === "open"
            ? [
                {
                  signal: "young_domain",
                  detail: "docs-share-portal.com registered 6 days ago",
                },
              ]
            : [],
      },
      key_status: [
        {
          api_key_id: "key_prod_1",
          account_id: "acc_acme",
          status: suspended ? "suspended" : "active",
          reason: "auto",
          takeover: detail.decision.label === "takeover",
          warnings:
            suspended && detail.decision.label !== "takeover" && risky()
              ? [
                  {
                    signal: "young_domain",
                    detail: "invoice-portal.net was registered 4 days ago",
                  },
                ]
              : [],
          decision_id: decisionId,
          updated_at: hours[11],
        },
        ...(backupSuspended
          ? [
              {
                api_key_id: "key_backup_2",
                account_id: "acc_acme",
                status: "suspended",
                reason: "analyst",
                decision_id: null,
                updated_at: hours[11],
              },
            ]
          : []),
      ],
      created_keys: [{ api_key_id: "key_backup_2", created_at: hours[8] }],
    });
  }
  if (url.pathname.endsWith("/series")) return reply(200, series);
  if (url.pathname.endsWith("/timeline")) return reply(200, timeline);
  if (url.pathname === `/v1/decisions/${decisionId}`)
    return reply(200, {
      ...detail,
      key: {
        api_key_id: "key_prod_1",
        account_id: "acc_acme",
        status: suspended ? "suspended" : "active",
        reason: "auto",
        decision_id: decisionId,
        updated_at: hours[11],
        // Same as the profile's key_status: the real API builds both alike.
        takeover: detail.decision.label === "takeover",
        warnings:
          suspended && detail.decision.label !== "takeover" && risky()
            ? [
                {
                  signal: "young_domain",
                  detail: "invoice-portal.net was registered 4 days ago",
                },
              ]
            : [],
      },
    });
  return reply(404, { error: "not found" });
}).listen(3102, "127.0.0.1", () =>
  console.log("Local fixture API listening on 3102"),
);
