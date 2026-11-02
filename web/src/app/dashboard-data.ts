"use server";
import { requireSession } from "@/lib/auth";
import { analystApi } from "@/lib/api";
import {
  dashboardQuery,
  dashboardScope,
  dashboardSnapshotError,
} from "@/lib/dashboard";
import { periodQuery } from "@/lib/format";
import type {
  AuditPage,
  DashboardData,
  DashboardSnapshot,
  Stats,
} from "@/lib/types";

export async function loadDashboard(
  raw: Record<string, unknown>,
): Promise<DashboardData> {
  await requireSession();
  const query = dashboardQuery(raw);
  const params = new URLSearchParams({
    segment: query.tab === "baseline" ? "baseline" : "attention",
    view: query.view,
    q: query.q,
    severity: query.severity,
    sort: query.sort,
    page: query.page,
  });
  const period = periodQuery(query.period).query;
  const [snapshot, stats, audit] = await Promise.all([
    analystApi<DashboardSnapshot>(`/v1/dashboard?${params}`),
    query.tab === "telemetry"
      ? analystApi<Stats>(`/v1/stats?${period}`)
      : undefined,
    query.tab === "telemetry"
      ? analystApi<AuditPage>(
          `/v1/analyst-actions?${period}${query.before_id ? `&before_id=${query.before_id}` : ""}`,
        )
      : undefined,
  ]);
  const snapshotError = snapshot.data
    ? dashboardSnapshotError(query, snapshot.data)
    : undefined;
  return {
    scope: dashboardScope(query),
    telemetry_period: query.period,
    audit_before_id: query.before_id,
    snapshot: snapshotError ? undefined : snapshot.data,
    database_ok: !!snapshot.data,
    stats: stats?.data,
    audit: audit?.data,
    error: snapshotError ?? snapshot.error,
    telemetry_error: stats?.error ?? audit?.error,
  };
}
