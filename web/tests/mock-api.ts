// Local-only API fixture. Browser tests never write to the deployed API or Supabase.
import { createServer } from "node:http";
import type {
  AccountSeries,
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
let requests: { path: string; body?: Record<string, string> }[] = [];
let empty = false;
let unavailable = false;
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
  };
  suspended = true;
  requests = [];
  empty = false;
  unavailable = false;
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

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1:3102");
  const reply = (status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === "/healthz") return reply(200, { ok: true });
  if (url.pathname === "/__reset" && req.method === "POST") {
    reset();
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
  if (url.pathname === "/__requests") return reply(200, requests);
  if (req.headers.authorization !== "Bearer fixture-analyst-token")
    return reply(401, { error: "missing token" });
  if (unavailable) return reply(503, { error: "unavailable" });
  if (req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: url.pathname, body });
    if (url.pathname.endsWith("/unblock")) {
      suspended = false;
      return reply(200, { status: "active" });
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
      detail.decision.review_status = "resolved";
      if (body.action === "confirm_takeover") {
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
        : stats,
    );
  if (url.pathname === "/v1/accounts") {
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
            open_reviews: 12 - i * 3,
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
      key_status: [
        {
          api_key_id: "key_prod_1",
          account_id: "acc_acme",
          status: suspended ? "suspended" : "active",
          reason: "auto",
          decision_id: decisionId,
          updated_at: hours[11],
        },
      ],
    });
  }
  if (url.pathname.endsWith("/series")) return reply(200, series);
  if (url.pathname.endsWith("/timeline")) return reply(200, [event]);
  if (url.pathname === `/v1/decisions/${decisionId}`) return reply(200, detail);
  return reply(404, { error: "not found" });
}).listen(3102, "127.0.0.1", () =>
  console.log("Local fixture API listening on 3102"),
);
