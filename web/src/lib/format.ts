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
export const humanize = (value: string) =>
  value.replaceAll("_", " ").replaceAll(".", " · ");
export const PERIODS = ["24h", "7d", "30d", "all"] as const;
export type Period = (typeof PERIODS)[number];
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
