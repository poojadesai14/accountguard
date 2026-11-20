import assert from "node:assert/strict";
import test from "node:test";
import {
  authConfig,
  createSession,
  passwordsMatch,
  safeReturnPath,
  SESSION_SECONDS,
  verifySession,
} from "../src/lib/session";
import { clientKey, LoginAttempts } from "../src/lib/login-attempts";
import { periodQuery } from "../src/lib/format";
import { reviewFields } from "../src/lib/review";

const password = "test-only-workspace-password";
const secret = "test-only-session-secret-0123456789abcdef";
const config = { password, secret };
const now = new Date("2026-10-30T12:00:00Z").getTime();

test("session is signed, expires after eight hours, and never contains the password", () => {
  const token = createSession(config, now);
  assert.equal(verifySession(token, config, now), true);
  assert.equal(token.includes(password), false);
  assert.equal(token.includes(secret), false);
  assert.notEqual(token, createSession(config, now));
  assert.equal(
    verifySession(token, config, now + SESSION_SECONDS * 1000),
    false,
  );
});

test("forged, malformed, missing, and rotated sessions fail closed", () => {
  const token = createSession(config, now);
  for (const value of [
    undefined,
    "",
    "forged",
    token + "x",
    token.replace(/.$/, "!"),
    "9".repeat(1000),
  ]) {
    assert.equal(verifySession(value, config, now), false);
  }
  assert.equal(
    verifySession(token, { password: password + "changed", secret }, now),
    false,
  );
  assert.equal(
    verifySession(token, { password, secret: secret + "changed" }, now),
    false,
  );
  assert.equal(verifySession(token, null, now), false);
  assert.equal(verifySession(token, config, now - 1000), false);
});

test("auth config stays closed until both values meet the minimum lengths", () => {
  assert.deepEqual(
    authConfig({ UI_PASSWORD: password, SESSION_SECRET: secret }),
    config,
  );
  for (const env of [
    {},
    { UI_PASSWORD: password },
    { SESSION_SECRET: secret },
    { UI_PASSWORD: "short-password", SESSION_SECRET: secret },
    { UI_PASSWORD: password, SESSION_SECRET: "too-short-secret" },
  ]) {
    assert.equal(authConfig(env), null);
  }
});

test("login attempts lock a client after five failures until the window ends", () => {
  const attempts = new LoginAttempts(5, 15 * 60 * 1000);
  for (let i = 0; i < 4; i++) attempts.recordFailure("203.0.113.7", now);
  assert.equal(attempts.isLocked("203.0.113.7", now), false);
  attempts.recordFailure("203.0.113.7", now);
  assert.equal(attempts.isLocked("203.0.113.7", now), true);
  assert.equal(attempts.isLocked("198.51.100.2", now), false);
  assert.equal(
    attempts.isLocked("203.0.113.7", now + 15 * 60 * 1000 - 1),
    true,
  );
  assert.equal(attempts.isLocked("203.0.113.7", now + 15 * 60 * 1000), false);
});

test("a successful sign-in clears the client's failed attempts", () => {
  const attempts = new LoginAttempts(2, 60_000);
  attempts.recordFailure("203.0.113.7", now);
  attempts.recordSuccess("203.0.113.7");
  attempts.recordFailure("203.0.113.7", now);
  assert.equal(attempts.isLocked("203.0.113.7", now), false);
});

test("client key uses the first forwarded address", () => {
  assert.equal(clientKey("203.0.113.7, 10.0.0.1", "10.0.0.2"), "203.0.113.7");
  assert.equal(clientKey(null, " 10.0.0.2 "), "10.0.0.2");
  assert.equal(clientKey(" ", null), "unknown");
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
