// Fixture data for the local mock API (mock-api.ts). Browser tests never write
// to the deployed API or Supabase.
import type {
  AccountSeries,
  DecisionDetail,
  Stats,
  TimelineRow,
} from "../src/lib/types";

export const decisionId = "11111111-1111-4111-8111-111111111111";
export const hours = Array.from({ length: 12 }, (_, i) =>
  new Date(Date.now() - (12 - i) * 3_600_000).toISOString(),
);
export const hits = [
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
export const event: TimelineRow = {
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

export const config = {
  mode: "shadow",
  config_version: "test",
  thresholds: {
    flag: 30,
    hold: 60,
    block: 80,
    block_min_categories: 2,
    single_category_exempt: ["content"],
  },
};

// A fresh copy of the held decision on acc_acme; the routes mutate it.
export function initialDetail(): DecisionDetail {
  return {
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
}

export const series: AccountSeries = {
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
export const stats: Stats = {
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

// Telemetry spread over 30 days, so each range selects different totals.
export function telemetryStats(url: URL): Stats {
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

// The account timeline, oldest first: unscored, allowed, then the held event.
// Untyped: an unscored row has null hits, as the real API sends.
export const timeline = [
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
];
