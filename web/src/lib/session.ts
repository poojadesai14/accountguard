import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "ato_session";
export const SESSION_SECONDS = 8 * 60 * 60;

function signature(payload: string, password: string) {
  return createHmac("sha256", password)
    .update(`ato-dashboard-session:${payload}`)
    .digest("base64url");
}

export function passwordsMatch(supplied: string, expected: string) {
  if (!expected || supplied.length > 1024) return false;
  const digest = (value: string) =>
    createHmac("sha256", "ato-password-comparison").update(value).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

export function createSession(password: string, now = Date.now()) {
  if (!password) throw new Error("UI_PASSWORD is required");
  const payload = `${Math.floor(now / 1000) + SESSION_SECONDS}.${randomBytes(24).toString("base64url")}`;
  return `${payload}.${signature(payload, password)}`;
}

export function verifySession(
  token: string | undefined,
  password: string | undefined,
  now = Date.now(),
) {
  if (!password || !token || token.length > 256) return false;
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
  const expected = Buffer.from(signature(`${parts[0]}.${parts[1]}`, password));
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
