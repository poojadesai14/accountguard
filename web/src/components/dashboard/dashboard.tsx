"use client";

import { RefreshCw, ShieldAlert } from "lucide-react";
import { dashboardScope, type DashboardQuery } from "@/lib/dashboard";
import { clockTime } from "@/lib/format";
import type { DashboardData } from "@/lib/types";
import { MetricCards } from "./metric-cards";
import { QueueView } from "./queue-view";
import { TelemetryView } from "./telemetry-view";
import { useDashboardRefresh } from "./use-dashboard-refresh";
import { TAB_TITLES } from "./view-copy";

export function Dashboard({
  query,
  initial,
}: {
  query: DashboardQuery;
  initial: DashboardData;
}) {
  const { data, refreshing, busy, refresh, navigate, openPage } =
    useDashboardRefresh(query, initial);
  const snapshot = data.snapshot;
  // The cards always show the latest totals; the table and telemetry only show
  // data loaded for exactly the current filters.
  const tableSnapshot =
    data.scope === dashboardScope(query) ? snapshot : undefined;
  const samePeriod = data.telemetry_period === query.period;
  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1 tabIndex={-1}>{TAB_TITLES[query.tab]}</h1>
        {/* Refreshes on its own every 30 s while visible; this shows when, and
            refreshes now. The API is only mentioned when it fails (alert below). */}
        <button
          type="button"
          className="refresh-text"
          disabled={busy}
          onClick={() => void refresh()}
          title="Updates automatically every 30 seconds while visible"
        >
          {snapshot
            ? `Updated ${clockTime(snapshot.generated_at)} UTC`
            : "Waiting for an update"}
          <RefreshCw
            size={13}
            className={refreshing ? "spin" : ""}
            aria-hidden="true"
          />
          <span className="sr-only">Refresh</span>
        </button>
      </header>
      {data.error && (
        <div className="api-error" role="alert">
          <ShieldAlert size={20} />
          <div>
            <h3>Dashboard update failed</h3>
            <p>{data.error}</p>
            {snapshot && (
              <p className="muted">
                {tableSnapshot
                  ? "Showing the last successful snapshot. Results may not match the current filters."
                  : "Summary cards show the last successful update. Results for this view are unavailable."}
              </p>
            )}
          </div>
        </div>
      )}
      {query.tab === "telemetry" ? (
        <TelemetryView
          query={query}
          stats={samePeriod ? data.stats : undefined}
          audit={
            samePeriod && data.audit_before_id === query.before_id
              ? data.audit
              : undefined
          }
          error={data.telemetry_error}
          busy={busy}
          navigate={navigate}
        />
      ) : (
        <>
          <MetricCards
            query={query}
            metrics={snapshot?.metrics}
            filtered={Boolean(query.q || query.severity !== "all")}
            busy={busy}
            navigate={navigate}
          />
          <QueueView
            query={query}
            snapshot={tableSnapshot}
            error={data.error}
            busy={busy}
            navigate={navigate}
            openPage={openPage}
          />
        </>
      )}
    </div>
  );
}
