import assert from "node:assert/strict";
import test from "node:test";
import {
  createSession,
  passwordsMatch,
  safeReturnPath,
  SESSION_SECONDS,
  verifySession,
} from "../src/lib/session";
import { periodQuery } from "../src/lib/format";
import { reviewFields } from "../src/lib/review";

const password = "test-only-workspace-password";
const now = new Date("2026-10-30T12:00:00Z").getTime();

test("session is signed, expires after eight hours, and never contains the password", () => {
  const token = createSession(password, now);
  assert.equal(verifySession(token, password, now), true);
  assert.equal(token.includes(password), false);
  assert.notEqual(token, createSession(password, now));
  assert.equal(
    verifySession(token, password, now + SESSION_SECONDS * 1000),
    false,
  );
});

test("forged, malformed, missing, and password-rotated sessions fail closed", () => {
  const token = createSession(password, now);
  for (const value of [
    undefined,
    "",
    "forged",
    token + "x",
    token.replace(/.$/, "!"),
    "9".repeat(1000),
  ]) {
    assert.equal(verifySession(value, password, now), false);
  }
  assert.equal(verifySession(token, password + "changed", now), false);
  assert.equal(verifySession(token, undefined, now), false);
  assert.equal(verifySession(token, password, now - 1000), false);
});

test("password gate checks a configured password and caps submitted input", () => {
  assert.equal(passwordsMatch(password, password), true);
  assert.equal(passwordsMatch("wrong", password), false);
  assert.equal(passwordsMatch("", ""), false);
  assert.equal(passwordsMatch("a".repeat(1025), password), false);
});

test("return paths cannot redirect sign-in to another origin", () => {
  for (const value of [
    "https://evil.invalid",
    "//evil.invalid",
    "/\\evil.invalid",
    "/\n/evil.invalid",
    "/login",
    undefined,
  ]) {
    assert.equal(safeReturnPath(value), "/");
  }
  assert.equal(
    safeReturnPath("/accounts/acc_acme?period=30d"),
    "/accounts/acc_acme?period=30d",
  );
});

test("time ranges are bounded, UTC, and use an exclusive end", () => {
  const result = periodQuery("24h", new Date(now));
  const query = new URLSearchParams(result.query);
  assert.equal(query.get("from"), "2026-10-29T12:00:00.000Z");
  assert.equal(query.get("to"), "2026-10-30T12:00:00.000Z");
  assert.equal(periodQuery("unknown").period, "7d");
  assert.equal(periodQuery("all").query, "bucket=1d");
});

test("review actions require a named analyst and a nonblank, bounded reason", () => {
  const form = new FormData();
  assert.ok(reviewFields(form).error);
  form.set("actor", " Pooja ");
  form.set("reason", "  ");
  assert.ok(reviewFields(form).error);
  form.set("reason", " Confirmed with account owner. ");
  assert.deepEqual(reviewFields(form), {
    actor: "Pooja",
    reason: "Confirmed with account owner.",
  });
  form.set("reason", "x".repeat(2001));
  assert.ok(reviewFields(form).error);
});
