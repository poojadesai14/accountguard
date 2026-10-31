import { PERIODS, type Period } from "./format";
import { UUID } from "./review";
export type DashboardQuery = {
  tab: "attention" | "baseline" | "telemetry";
  q: string;
  severity: "all" | "high" | "medium";
  page: string;
  period: Period;
  before_id: string;
  inspect: string;
  decision: string;
  review: "" | "confirm_takeover" | "mark_legitimate";
};
export function dashboardQuery(raw: Record<string, unknown>): DashboardQuery {
  const integer = (value: unknown, max: number) =>
    typeof value === "string" &&
    /^\d+$/.test(value) &&
    Number(value) >= 1 &&
    Number(value) <= max
      ? value
      : "";
  return {
    tab:
      raw.tab === "baseline" || raw.tab === "telemetry" ? raw.tab : "attention",
    q: typeof raw.q === "string" ? raw.q.trim().slice(0, 200) : "",
    severity:
      raw.severity === "high" || raw.severity === "medium"
        ? raw.severity
        : "all",
    page: integer(raw.page, 1_000_000) || "1",
    period: PERIODS.includes(raw.period as Period)
      ? (raw.period as Period)
      : "7d",
    before_id: integer(raw.before_id, Number.MAX_SAFE_INTEGER),
    inspect: typeof raw.inspect === "string" ? raw.inspect.slice(0, 500) : "",
    decision:
      typeof raw.decision === "string" && UUID.test(raw.decision)
        ? raw.decision
        : "",
    review:
      raw.review === "confirm_takeover" || raw.review === "mark_legitimate"
        ? raw.review
        : "",
  };
}
export function dashboardURL(
  query: DashboardQuery,
  patch: Partial<DashboardQuery> = {},
) {
  const next = { ...query, ...patch };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(next))
    if (
      value &&
      !(key === "page" && value === "1") &&
      !(key === "severity" && value === "all") &&
      !(key === "tab" && value === "attention") &&
      !(key === "period" && value === "7d")
    )
      params.set(key, value);
  return params.size ? `/?${params}` : "/";
}
