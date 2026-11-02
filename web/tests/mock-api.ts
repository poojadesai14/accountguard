// Local-only API fixture. Browser tests never write to the deployed API or Supabase.
import { createServer } from "node:http";
import type {
  AccountSeries,
  DashboardAccount,
  GlobalAuditAction,
  DecisionDetail,
  Stats,
  TimelineRow,
} from "../src/lib/types";

const decisionId = "11111111-1111-4111-8111-111111111111";
const hours = Array.from({ length: 12 }, (_, i) =>
  new Date(Date.now() - (12 - i) * 3_600_000).toISOString(),
);
const hits = [
  {
    name: "new_asn",
    category: "network",
    points: 30,
    detail: "AS14061 DIGITALOCEAN-ASN first seen for key key_prod_1",
  },
  {
    name: "new_domain",
    category: "content",
    points: 25,
    detail: "invoice-portal.net has not appeared in allowed account history",
  },
  {
    name: "young_domain",
    category: "content",
    points: 20,
    detail: "invoice-portal.net was registered 4 days ago",
  },
];
const event: TimelineRow = {
  event_id: "evt_investigation_001",
  type: "email.send",
  occurred_at: hours[10],
  api_key_id: "key_prod_1",
  source: "api",
  ip: "203.0.113.9",
  asn: 14061,
  asn_org: "DIGITALOCEAN-ASN",
  user_agent: "resend-node:4.0.0",
  sender_domain: "acme.com",
  recipient_count: 5,
  link_domains: ["invoice-portal.net"],
  reply_to_domains: [],
  body_email_domains: [],
  change_kind: null,
  change_target_id: null,
  read_resource: null,
  read_status: null,
  decision_id: decisionId,
  action: "hold",
  enforced: true,
  score: 75,
  hits,
  reason: null,
  hold_status: "pending",
  review_status: "open",
  label: null,
};
let detail: DecisionDetail;
let suspended = true;
let newerReview = false; // a review the page hasn't seen yet
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
let requests: { path: string; body?: Record<string, string> }[] = [];
let empty = false;
let unavailable = false;
let singleBucket = false;
let telemetryHistory = false;
let manyAccounts = false;
let legacyDashboard = false;
let auditRecords: GlobalAuditAction[] = [];
function reset() {
  detail = {
    decision: {
      decision_id: decisionId,
      event_id: event.event_id,
      account_id: "acc_acme",
      api_key_id: "key_prod_1",
      occurred_at: event.occurred_at,
      decided_at: event.occurred_at,
      action: "hold",
      enforced: true,
      score: 75,
      hits,
      reason: null,
      config_version: "2026-10-30.1",
      latency_us: 1800,
      hold_status: "pending",
      hold_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      review_status: "open",
      label: null,
    },
    event: { ...event },
    actions: [],
    related: [
      {
        kind: "link_domain",
        value: "invoice-portal.net",
        accounts: 9,
        events: 37,
        stopped: 5,
        confirmed: 2,
        top: [
          {
            account_id: "acc_beta",
            events: 6,
            worst_action: "block",
            confirmed: true,
            decision_id: null,
            last_at: hours[9],
          },
          {
            account_id: "acc_gamma",
            events: 4,
            worst_action: "hold",
            confirmed: false,
            decision_id: null,
            last_at: hours[8],
          },
          // Seven listed of nine: five show first, two expand, two are unlisted.
          ...["delta", "epsilon", "zeta", "eta", "theta"].map((name, i) => ({
            account_id: `acc_${name}`,
            events: 3,
            worst_action: (i < 3 ? "hold" : "flag") as "hold" | "flag",
            confirmed: false,
            decision_id: null,
            last_at: hours[7],
          })),
        ],
      },
    ],
  };
  suspended = true;
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
const series: AccountSeries = {
  account_id: "acc_acme",
  baseline_hourly: 41.5,
  spike_threshold: 124.5,
  points: hours.map((t, i) => ({
    t,
    recipients: i < 9 ? 25 + i * 4 : 140 + i * 6,
    asns: [
      {
        asn: i < 9 ? 16509 : 14061,
        org: i < 9 ? "AMAZON-02" : "DIGITALOCEAN-ASN",
        first_seen: i === 9,
      },
    ],
    content_hits: i > 8 ? ["new_domain", "young_domain"] : [],
    account_changes: i === 8 ? 1 : 0,
    actions: {
      allow: 20 + i,
      flag: i > 8 ? 4 : 0,
      hold: i > 9 ? 2 : 0,
      block: i === 11 ? 1 : 0,
    },
  })),
};
const stats: Stats = {
  totals: { events: 23847, allow: 23780, flag: 46, hold: 16, block: 5 },
  series: hours.map((t, i) => ({
    t,
    flag: (i % 3) + 1,
    hold: i > 7 ? 3 : 0,
    block: i > 9 ? 2 : 0,
  })),
  top_signals: [
    { name: "new_domain", count: 46 },
    { name: "new_asn", count: 38 },
    { name: "young_domain", count: 21 },
    { name: "recipient_spike", count: 12 },
  ],
  review_queue: [
    {
      account_id: "acc_acme",
      open_count: 12,
      max_action: "block",
      last_at: hours[11],
    },
    {
      account_id: "acc_beta",
      open_count: 3,
      max_action: "hold",
      last_at: hours[10],
    },
    {
      account_id: "acc_northstar",
      open_count: 2,
      max_action: "flag",
      last_at: hours[9],
    },
  ],
};

function telemetryStats(url: URL): Stats {
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const interval =
    url.searchParams.get("bucket") === "1d" ? 86_400_000 : 3_600_000;
  const history = [
    { hoursAgo: 1, flag: 65, hold: 2, block: 1 },
    { hoursAgo: 48, flag: 259, hold: 3, block: 2 },
    { hoursAgo: 240, flag: 30, hold: 5, block: 4 },
    { hoursAgo: 960, flag: 10, hold: 7, block: 8 },
  ];
  const buckets = new Map<
    number,
    { t: string; flag: number; hold: number; block: number }
  >();
  for (const point of history) {
    const time = Date.now() - point.hoursAgo * 3_600_000;
    if ((from && time < Date.parse(from)) || (to && time >= Date.parse(to)))
      continue;
    const bucket = Math.floor(time / interval) * interval;
    const previous = buckets.get(bucket);
    buckets.set(bucket, {
      t: new Date(bucket).toISOString(),
      flag: (previous?.flag ?? 0) + point.flag,
      hold: (previous?.hold ?? 0) + point.hold,
      block: (previous?.block ?? 0) + point.block,
    });
  }
  const series = [...buckets.values()].sort((a, b) => a.t.localeCompare(b.t));
  const totals = series.reduce(
    (sum, point) => ({
      events: sum.events + point.flag + point.hold + point.block,
      allow: 0,
      flag: sum.flag + point.flag,
      hold: sum.hold + point.hold,
      block: sum.block + point.block,
    }),
    { events: 0, allow: 0, flag: 0, hold: 0, block: 0 },
  );
  return {
    totals,
    series,
    top_signals: [{ name: "new_asn", count: totals.flag }],
    review_queue: [],
  };
}

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
  if (url.pathname === "/v1/config")
    return reply(200, {
      mode: "shadow",
      config_version: "test",
      thresholds: {
        flag: 30,
        hold: 60,
        block: 80,
        block_min_categories: 2,
        single_category_exempt: ["content"],
      },
    });
  if (url.pathname === "/__reset" && req.method === "POST") {
    reset();
    return reply(200, {});
  }
  if (url.pathname === "/__risky-review" && req.method === "POST") {
    detail.decision.hits = [
      ...detail.decision.hits,
      {
        name: "young_domain",
        category: "content",
        points: 20,
        detail: "docs-share-portal.com registered 6 days ago",
      },
    ];
    return reply(200, {});
  }
  if (url.pathname === "/__newer-review" && req.method === "POST") {
    newerReview = true;
    return reply(200, {});
  }
  if (url.pathname === "/__empty" && req.method === "POST") {
    empty = true;
    return reply(200, {});
  }
  if (url.pathname === "/__unavailable" && req.method === "POST") {
    unavailable = true;
    return reply(200, {});
  }
  if (url.pathname === "/__single-bucket" && req.method === "POST") {
    singleBucket = true;
    return reply(200, {});
  }
  if (url.pathname === "/__telemetry-history" && req.method === "POST") {
    telemetryHistory = true;
    return reply(200, {});
  }
  if (url.pathname === "/__many-accounts" && req.method === "POST") {
    manyAccounts = true;
    return reply(200, {});
  }
  if (url.pathname === "/__legacy-dashboard" && req.method === "POST") {
    legacyDashboard = true;
    return reply(200, {});
  }
  if (url.pathname === "/__recover" && req.method === "POST") {
    unavailable = false;
    legacyDashboard = false;
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
      action:
        body.action ??
        (url.pathname.endsWith("/suspend")
          ? "suspend_key"
          : url.pathname.endsWith("/correct")
            ? "correct_to_takeover"
            : "unblock_key"),
      actor: body.actor ?? "owner",
      reason: body.reason ?? "Owner response",
      created_at: new Date().toISOString(),
    });
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
    if (url.pathname.endsWith("/actions")) {
      if (
        risky() &&
        body.action === "mark_legitimate" &&
        body.confirm !== "acc_acme"
      )
        return reply(409, {
          error:
            "the evidence shows young_domain: type the account ID to confirm this is legitimate",
        });
      detail.decision.review_status = "resolved";
      if (body.action === "confirm_takeover") {
        suspended = true;
        detail.decision.label = "takeover";
        detail.decision.hold_status = "dropped";
      }
      if (body.action === "mark_legitimate") {
        detail.decision.label = "legitimate";
        detail.decision.hold_status = "released";
      }
      if (body.action === "release_hold")
        detail.decision.hold_status = "released";
      detail.actions!.push({
        id: 1,
        action: body.action,
        actor: body.actor,
        reason: body.reason,
        created_at: new Date().toISOString(),
      });
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
        if (url.searchParams.get("segment") === "baseline")
          return baseline(item) && (view !== "healthy" || item.baseline_ready);
        return !!(item.open_reviews || item.suspended_keys);
      })
      .filter((item) =>
        ["flag", "hold", "block"].includes(
          url.searchParams.get("severity") ?? "",
        )
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
  if (url.pathname === "/v1/accounts") {
    const openReviews: Record<string, number> = {
      acc_acme: 12,
      acc_beta: 9,
      acc_northstar: 0,
    };
    const accounts = ["acc_acme", "acc_beta", "acc_northstar"].filter((id) =>
      id.includes(url.searchParams.get("q") ?? ""),
    );
    return reply(
      200,
      empty
        ? null
        : accounts.map((account_id, i) => ({
            account_id,
            first_seen_at: "2026-09-01T10:00:00Z",
            events_seen: 6200 - i * 1000,
            decisions: 8000 - i * 1000,
            open_reviews: openReviews[account_id],
            last_at: hours[11],
            last_action: i === 0 ? "block" : "flag",
          })),
    );
  }
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
          decision_id: decisionId,
          updated_at: hours[11],
        },
      ],
    });
  }
  if (url.pathname.endsWith("/series")) return reply(200, series);
  if (url.pathname.endsWith("/timeline"))
    return reply(200, [
      {
        ...event,
        event_id: "evt_unscored_001",
        occurred_at: hours[8],
        action: null,
        score: null,
        hits: null,
        enforced: null,
        decision_id: null,
        hold_status: null,
        review_status: null,
      },
      {
        ...event,
        event_id: "evt_normal_001",
        occurred_at: hours[9],
        api_key_id: "key_safe_1",
        ip: "198.51.100.20",
        asn: 16509,
        asn_org: "AMAZON-02",
        action: "allow",
        score: 0,
        hits: [],
        decision_id: null,
        hold_status: null,
        review_status: "none",
      },
      event,
    ]);
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
      },
    });
  return reply(404, { error: "not found" });
}).listen(3102, "127.0.0.1", () =>
  console.log("Local fixture API listening on 3102"),
);
