// The account page loads at most this many timeline events per period.
export const TIMELINE_LIMIT = 1000;
export const number = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
export function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date);
}
// Clock time for "Updated 14:05 UTC": 24-hour, so it needs no AM/PM.
export const clockTime = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(new Date(value));
// humanize turns API identifiers such as "new_asn" or "email.send" into words.
export const humanize = (value: string) => value.replace(/[_.]/g, " ");
export const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;
export const PERIODS = ["24h", "7d", "30d", "all"] as const;
export type Period = (typeof PERIODS)[number];
export const PERIOD_LABELS: Record<Period, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
  all: "All time",
};
export function periodQuery(value: unknown, now = new Date()) {
  const period: Period = PERIODS.includes(value as Period)
    ? (value as Period)
    : "7d";
  if (period === "all") return { period, query: "bucket=1d" };
  const hours = { "24h": 24, "7d": 168, "30d": 720 }[period];
  return {
    period,
    query: new URLSearchParams({
      from: new Date(now.getTime() - hours * 3_600_000).toISOString(),
      to: now.toISOString(),
      bucket: period === "30d" ? "1d" : "1h",
    }).toString(),
  };
}
