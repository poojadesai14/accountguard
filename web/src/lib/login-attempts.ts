export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_SECONDS = 15 * 60;
const MAX_TRACKED_CLIENTS = 10_000;

type Entry = { failures: number; windowStart: number };

// LoginAttempts counts failed sign-ins per client within a fixed window. State
// lives in memory, so each server instance keeps its own count.
export class LoginAttempts {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly maxFailures = MAX_FAILED_ATTEMPTS,
    private readonly windowMs = LOCKOUT_SECONDS * 1000,
  ) {}

  // isLocked reports whether the client has used up its failed attempts for
  // the current window.
  isLocked(client: string, now = Date.now()) {
    const entry = this.current(client, now);
    return entry !== undefined && entry.failures >= this.maxFailures;
  }

  recordFailure(client: string, now = Date.now()) {
    const entry = this.current(client, now) ?? {
      failures: 0,
      windowStart: now,
    };
    entry.failures += 1;
    this.entries.delete(client);
    this.entries.set(client, entry);
    this.evict(now);
  }

  recordSuccess(client: string) {
    this.entries.delete(client);
  }

  private current(client: string, now: number) {
    const entry = this.entries.get(client);
    if (entry && now - entry.windowStart >= this.windowMs) {
      this.entries.delete(client);
      return undefined;
    }
    return entry;
  }

  // Map iteration follows insertion order and recordFailure reinserts, so the
  // first keys are the least recently failed clients.
  private evict(now: number) {
    for (const [client, entry] of this.entries) {
      if (
        this.entries.size <= MAX_TRACKED_CLIENTS &&
        now - entry.windowStart < this.windowMs
      )
        break;
      this.entries.delete(client);
    }
  }
}

export const loginAttempts = new LoginAttempts();

// clientKey identifies the caller by the first address in X-Forwarded-For,
// which Vercel sets from the connecting IP.
export function clientKey(forwardedFor: string | null, realIp: string | null) {
  const first = forwardedFor?.split(",")[0]?.trim();
  return first || realIp?.trim() || "unknown";
}
