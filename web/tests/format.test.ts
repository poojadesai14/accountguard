import assert from "node:assert/strict";
import test from "node:test";
import {
  clockTime,
  humanize,
  PERIOD_LABELS,
  PERIODS,
  plural,
} from "../src/lib/format";

test("humanize turns signal names and event types into words", () => {
  assert.equal(humanize("new_asn"), "new asn");
  assert.equal(humanize("email.send"), "email send");
  assert.equal(humanize("api_key.created"), "api key created");
});

test("plural counts with the right noun form", () => {
  assert.equal(plural(0, "review"), "0 reviews");
  assert.equal(plural(1, "held email"), "1 held email");
  assert.equal(plural(3, "suspended key"), "3 suspended keys");
});

test("every period has a label", () => {
  assert.deepEqual(
    PERIODS.map((period) => PERIOD_LABELS[period]),
    ["24 hours", "7 days", "30 days", "All time"],
  );
});

test("the refresh clock is 24-hour UTC", () => {
  assert.equal(clockTime("2026-11-03T15:04:59Z"), "15:04");
  assert.equal(clockTime("2026-11-03T00:30:00Z"), "00:30");
});
