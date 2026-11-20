import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const SESSION_COOKIE = "ato_session";
export const SESSION_SECONDS = 8 * 60 * 60;
export const MIN_PASSWORD_LENGTH = 16;
export const MIN_SECRET_LENGTH = 32;

export type AuthConfig = { password: string; secret: string };

// authConfig returns null unless both values meet the minimum lengths, so a
// missing or weak setting keeps the dashboard locked instead of open.
export function authConfig(
  env: Record<string, string | undefined> = process.env,
): AuthConfig | null {
  const password = env.UI_PASSWORD ?? "";
  const secret = env.SESSION_SECRET ?? "";
  if (
    password.length < MIN_PASSWORD_LENGTH ||
    secret.length < MIN_SECRET_LENGTH
  )
    return null;
  return { password, secret };
}

// The password fingerprint is part of the signed data so that rotating the
// password ends existing sessions even when SESSION_SECRET stays the same.
function signature(payload: string, config: AuthConfig) {
  const fingerprint = createHash("sha256")
    .update(config.password)
    .digest("base64url");
  return createHmac("sha256", config.secret)
    .update(`ato-dashboard-session:${fingerprint}:${payload}`)
    .digest("base64url");
}

export function passwordsMatch(supplied: string, expected: string) {
  if (!expected || supplied.length > 1024) return false;
  const digest = (value: string) =>
    createHmac("sha256", "ato-password-comparison").update(value).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

export function createSession(config: AuthConfig, now = Date.now()) {
  const payload = `${Math.floor(now / 1000) + SESSION_SECONDS}.${randomBytes(24).toString("base64url")}`;
  return `${payload}.${signature(payload, config)}`;
}

export function verifySession(
  token: string | undefined,
  config: AuthConfig | null,
  now = Date.now(),
) {
  if (!config || !token || token.length > 256) return false;
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    !/^\d+$/.test(parts[0]) ||
    !/^[\w-]{32}$/.test(parts[1])
  )
    return false;
  const expiry = Number(parts[0]);
  const current = Math.floor(now / 1000);
  if (
    !Number.isSafeInteger(expiry) ||
    expiry <= current ||
    expiry > current + SESSION_SECONDS
  )
    return false;
  const expected = Buffer.from(signature(`${parts[0]}.${parts[1]}`, config));
  const supplied = Buffer.from(parts[2]);
  return (
    expected.length === supplied.length && timingSafeEqual(expected, supplied)
  );
}

export function safeReturnPath(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\r\n]/.test(value)
  )
    return "/";
  try {
    const url = new URL(value, "https://dashboard.invalid");
    return url.origin === "https://dashboard.invalid" &&
      url.pathname !== "/login"
      ? url.pathname + url.search
      : "/";
  } catch {
    return "/";
  }
}
