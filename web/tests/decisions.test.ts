import assert from "node:assert/strict";
import test from "node:test";
import {
  accountHours,
  decisionSeries,
  explainDecision,
} from "../src/lib/decisions";
import type { Hit, SeriesPoint, Thresholds } from "../src/lib/types";

test("separate incidents keep their counts and have zero activity between them", () => {
  const series = decisionSeries(
    [
      { t: "2026-10-30T03:00:00Z", flag: 0, hold: 2, block: 1 },
      { t: "2026-10-30T01:00:00Z", flag: 4, hold: 0, block: 0 },
    ],
    "1h",
    "2026-10-30T00:30:00Z",
    "2026-10-30T04:00:00Z",
  );
  assert.deepEqual(
    series.map(({ time, ...counts }) => ({
      time: new Date(time).toISOString(),
      ...counts,
    })),
    [
      { time: "2026-10-30T00:00:00.000Z", flag: 0, hold: 0, block: 0 },
      { time: "2026-10-30T01:00:00.000Z", flag: 4, hold: 0, block: 0 },
      { time: "2026-10-30T02:00:00.000Z", flag: 0, hold: 0, block: 0 },
      { time: "2026-10-30T03:00:00.000Z", flag: 0, hold: 2, block: 1 },
    ],
  );
});

test("daily buckets use UTC boundaries and preserve totals when combining points", () => {
  const series = decisionSeries(
    [
      { t: "2026-10-30T00:00:00Z", flag: 2, hold: 1, block: 0 },
      { t: "2026-10-30T23:00:00Z", flag: 3, hold: 0, block: 1 },
      { t: "2026-11-01T00:00:00Z", flag: 0, hold: 2, block: 4 },
    ],
    "1d",
  );
  assert.deepEqual(series, [
    { time: Date.parse("2026-10-30T00:00:00Z"), flag: 5, hold: 1, block: 1 },
    { time: Date.parse("2026-10-31T00:00:00Z"), flag: 0, hold: 0, block: 0 },
    { time: Date.parse("2026-11-01T00:00:00Z"), flag: 0, hold: 2, block: 4 },
  ]);
});

test("an empty period stays empty and one incident remains one data point", () => {
  assert.deepEqual(decisionSeries([], "1h"), []);
  assert.deepEqual(
    decisionSeries(
      [{ t: "2026-10-30T02:00:00Z", flag: 0, hold: 1, block: 0 }],
      "1h",
    ),
    [{ time: Date.parse("2026-10-30T02:00:00Z"), flag: 0, hold: 1, block: 0 }],
  );
});

const thresholds: Thresholds = {
  flag: 30,
  hold: 60,
  block: 80,
  block_min_categories: 2,
  single_category_exempt: ["content"],
};
const hit = (category: string, points: number): Hit => ({
  name: category,
  category,
  points,
  detail: "",
});

test("explainDecision mirrors the engine's rules", () => {
  const cases: {
    name: string;
    action: "allow" | "flag" | "hold" | "block";
    score: number;
    hits: Hit[];
    reason?: string;
    key?: string | null;
    want: RegExp;
  }[] = [
    {
      name: "score inside its range",
      action: "hold",
      score: 75,
      hits: [hit("network", 30), hit("content", 45)],
      want: /in the hold range \(60–79\)/,
    },
    {
      name: "one non-content category is capped at flag",
      action: "flag",
      score: 90,
      hits: [hit("velocity", 90)],
      want: /only one signal category \(velocity\).*at most flag/,
    },
    {
      name: "content alone above the block line is held",
      action: "hold",
      score: 85,
      hits: [hit("content", 85)],
      want: /only 1 signal category agreed; blocking needs 2/,
    },
    {
      name: "no key to suspend",
      action: "hold",
      score: 90,
      hits: [hit("network", 50), hit("content", 40)],
      key: null,
      want: /no API key to suspend/,
    },
    {
      name: "already suspended key",
      action: "block",
      score: 0,
      hits: [],
      reason: "key_suspended",
      want: /already suspended/,
    },
    {
      name: "block range names the agreement rule",
      action: "block",
      score: 90,
      hits: [hit("network", 30), hit("content", 60)],
      want: /block range \(80\+ with at least 2 signal categories/,
    },
  ];
  for (const c of cases) {
    const text = explainDecision(
      {
        action: c.action,
        score: c.score,
        hits: c.hits,
        reason: c.reason ?? null,
        api_key_id: c.key === undefined ? "key_1" : c.key,
      },
      thresholds,
    );
    assert.match(text, c.want, c.name);
  }
});

const point = (t: string, patch: Partial<SeriesPoint> = {}): SeriesPoint => ({
  t,
  recipients: 0,
  asns: [],
  content_hits: [],
  account_changes: 0,
  actions: {},
  ...patch,
});

test("account hours fill quiet hours with zero and mark the first hold or block", () => {
  const { hours, incident } = accountHours([
    point("2026-10-30T05:00:00Z", {
      recipients: 20,
      actions: { flag: 1 },
    }),
    point("2026-10-30T01:00:00Z", { recipients: 40, actions: { allow: 2 } }),
    point("2026-10-30T07:00:00Z", {
      recipients: 5,
      content_hits: ["new_domain", "young_domain"],
      actions: { hold: 1 },
    }),
  ]);
  assert.equal(hours.length, 7);
  assert.deepEqual(
    hours.map((h) => h.recipients),
    [40, 0, 0, 0, 20, 0, 5],
  );
  assert.equal(hours[6].content, 2);
  assert.equal(incident, Date.parse("2026-10-30T07:00:00Z"));
  assert.equal(accountHours([]).hours.length, 0);
  assert.equal(
    accountHours([point("2026-10-30T01:00:00Z", { actions: { flag: 3 } })])
      .incident,
    undefined,
  );
});

test("very long account ranges plot only hours with events", () => {
  const { hours } = accountHours([
    point("2026-01-01T00:00:00Z"),
    point("2026-10-01T00:00:00Z"),
  ]);
  assert.equal(hours.length, 2);
});
