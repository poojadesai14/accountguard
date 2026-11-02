import { PERIODS, type Period } from "./format";
import type { DashboardSnapshot } from "./types";
export type DashboardQuery = {
  tab: "attention" | "baseline" | "telemetry";
  view: "accounts" | "holds" | "keys" | "healthy";
  q: string;
  severity: "all" | "flag" | "hold" | "block";
  sort: "priority" | "recent";
  page: string;
  period: Period;
  before_id: string;
};
export function dashboardQuery(raw: Record<string, unknown>): DashboardQuery {
  const tab =
    raw.tab === "baseline" || raw.tab === "telemetry" ? raw.tab : "attention";
  const integer = (value: unknown, max: number) =>
    typeof value === "string" &&
    /^\d+$/.test(value) &&
    Number(value) >= 1 &&
    Number(value) <= max
      ? value
      : "";
  return {
    tab,
    view:
      tab === "baseline" && raw.view === "healthy"
        ? "healthy"
        : tab === "attention" && (raw.view === "holds" || raw.view === "keys")
          ? raw.view
          : "accounts",
    q: typeof raw.q === "string" ? raw.q.trim().slice(0, 200) : "",
    severity:
      tab === "attention" &&
      (raw.severity === "flag" ||
        raw.severity === "hold" ||
        raw.severity === "block")
        ? raw.severity
        : "all",
    sort: raw.sort === "recent" ? "recent" : "priority",
    page: integer(raw.page, 1_000_000) || "1",
    period: PERIODS.includes(raw.period as Period)
      ? (raw.period as Period)
      : "7d",
    before_id: integer(raw.before_id, Number.MAX_SAFE_INTEGER),
  };
}
export function dashboardURL(
  query: DashboardQuery,
  patch: Partial<DashboardQuery> = {},
) {
  const next = dashboardQuery({ ...query, ...patch });
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(next))
    if (
      value &&
      !(key === "page" && value === "1") &&
      !(key === "severity" && (value === "all" || next.tab !== "attention")) &&
      !(key === "sort" && value === "priority") &&
      !(key === "tab" && value === "attention") &&
      !(key === "view" && value === "accounts") &&
      !(key === "period" && value === "7d")
    )
      params.set(key, value);
  return params.size ? `/?${params}` : "/";
}

export function dashboardScope(query: DashboardQuery) {
  return JSON.stringify([
    query.tab === "baseline" ? "baseline" : "attention",
    query.view,
    query.q,
    query.severity,
    query.sort,
    query.page,
  ]);
}

export function dashboardSnapshotError(
  query: DashboardQuery,
  snapshot: DashboardSnapshot,
) {
  if ((snapshot.view ?? "accounts") !== query.view)
    return "These results do not match the selected view. Open Review queue or refresh to try again.";
  const { total, page, limit, items, metrics } = snapshot;
  if (
    !Number.isInteger(total) ||
    total < 0 ||
    !Number.isInteger(page) ||
    page !== Number(query.page) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    !Array.isArray(items) ||
    items.length !== Math.min(limit, Math.max(0, total - (page - 1) * limit)) ||
    !metrics
  )
    return "The API returned incomplete dashboard totals. Refresh to try again.";
  if (!query.q && query.severity === "all") {
    const expected =
      query.view === "holds"
        ? metrics.pending_quarantines
        : query.view === "keys"
          ? metrics.suspended_keys
          : query.view === "healthy"
            ? metrics.healthy_baselines
            : query.tab === "attention"
              ? metrics.attention_accounts
              : undefined;
    if (expected !== undefined && total !== expected)
      return "The list total does not match its summary card. Refresh to try again.";
  }
  return undefined;
}
