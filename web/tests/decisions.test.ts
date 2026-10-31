import assert from "node:assert/strict";
import test from "node:test";
import { decisionSeries } from "../src/lib/decisions";

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
