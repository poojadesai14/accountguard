import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { DashboardQuery } from "@/lib/dashboard";
import {
  dateTime,
  humanize,
  number,
  PERIOD_LABELS,
  periodQuery,
  PERIODS,
} from "@/lib/format";
import type { AuditPage, Stats } from "@/lib/types";
import { DecisionChart } from "../decision-chart";
import { CardHeader, EmptyState } from "../ui";

// TelemetryView is the aggregate picture for one time range: decision totals,
// elevated activity over time, the top risk drivers and the analyst audit stream.
export function TelemetryView({
  query,
  stats,
  audit,
  error,
  busy,
  navigate,
}: {
  query: DashboardQuery;
  stats?: Stats;
  audit?: AuditPage;
  error?: string;
  busy: boolean;
  navigate: (patch: Partial<DashboardQuery>) => void;
}) {
  const range = new URLSearchParams(periodQuery(query.period).query);
  return (
    <>
      <div className="telemetry-toolbar">
        <h2>Aggregated telemetry</h2>
        <div className="period-filter" aria-label="Telemetry time range">
          {PERIODS.map((value) => (
            <button
              type="button"
              key={value}
              className={query.period === value ? "selected" : ""}
              disabled={busy}
              onClick={() => navigate({ period: value, before_id: "" })}
            >
              {PERIOD_LABELS[value]}
            </button>
          ))}
        </div>
      </div>
      {error && (
        <p className="api-error" role="alert">
          {error} Telemetry may be stale.
        </p>
      )}
      {stats && <DecisionTotals totals={stats.totals} />}
      <div className="overview-middle">
        <section className="card activity-card">
          <CardHeader
            title="Elevated activity"
            description="Each outcome on its own row, sharing one timeline."
          />
          {stats ? (
            <DecisionChart
              points={stats.series ?? []}
              bucket={range.get("bucket") === "1d" ? "1d" : "1h"}
              from={range.get("from") ?? undefined}
              to={range.get("to") ?? undefined}
            />
          ) : (
            <EmptyState title="Telemetry for this range is unavailable" />
          )}
        </section>
        <section className="card signals-card">
          <CardHeader
            title="Risk drivers"
            description="Signal hits across the selected period."
          />
          {stats?.top_signals?.length ? (
            <RiskDrivers signals={stats.top_signals} />
          ) : (
            <EmptyState
              compact
              title={
                stats
                  ? "No signal hits in this period"
                  : "Risk drivers for this range are unavailable"
              }
            />
          )}
        </section>
      </div>
      <AuditStream
        audit={audit}
        beforeId={query.before_id}
        navigate={navigate}
      />
    </>
  );
}

function DecisionTotals({ totals }: { totals: Stats["totals"] }) {
  const items = [
    ["Events scored", totals.events, ""],
    ["Allowed", totals.allow, "allow"],
    ["Flagged", totals.flag, "flag"],
    ["Held", totals.hold, "hold"],
    ["Blocked", totals.block, "block"],
  ] as const;
  return (
    <dl className="telemetry-totals" aria-label="Decision totals">
      {items.map(([label, value, action]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className={action ? `score-${action}` : undefined}>
            {number(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function RiskDrivers({
  signals,
}: {
  signals: NonNullable<Stats["top_signals"]>;
}) {
  const top = Math.max(1, signals[0].count);
  return (
    <div className="signal-list">
      {signals.map((signal, index) => (
        <div className="signal-row" key={signal.name}>
          <div>
            <span className="signal-rank">
              {String(index + 1).padStart(2, "0")}
            </span>
            <span>{humanize(signal.name)}</span>
            <strong>{number(signal.count)}</strong>
          </div>
          <div className="signal-track">
            <span style={{ width: `${(signal.count / top) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function AuditStream({
  audit,
  beforeId,
  navigate,
}: {
  audit?: AuditPage;
  beforeId: string;
  navigate: (patch: Partial<DashboardQuery>) => void;
}) {
  return (
    <section className="card">
      <CardHeader
        title="Analyst audit stream"
        description="Recorded analyst and owner actions, newest ID first."
      />
      {audit?.items.length ? (
        <div className="table-scroll">
          <table aria-label="Analyst audit stream">
            <thead>
              <tr>
                <th>Action</th>
                <th>Account & key</th>
                <th>Actor</th>
                <th>Reason</th>
                <th>Recorded (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {audit.items.map((action) => (
                <tr key={action.id}>
                  <td>
                    {humanize(action.action)}
                    <small>#{action.id}</small>
                  </td>
                  <td>
                    {action.account_id ? (
                      <Link
                        className="text-link"
                        href={`/accounts/${encodeURIComponent(action.account_id)}`}
                      >
                        {action.account_id}
                      </Link>
                    ) : (
                      "—"
                    )}
                    <small className="mono">{action.api_key_id ?? "—"}</small>
                  </td>
                  <td>{action.actor}</td>
                  <td className="audit-reason">{action.reason}</td>
                  <td className="timeline-time">
                    {dateTime(action.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          compact
          title={
            audit
              ? "No analyst actions in this period"
              : "Audit history for this range is unavailable"
          }
        />
      )}
      <div className="dashboard-pagination">
        <span>Audit records are never synthesized from decision counts.</span>
        {beforeId && (
          <button
            type="button"
            className="button button-secondary"
            onClick={() => navigate({ before_id: "" })}
          >
            Latest actions
          </button>
        )}
        {audit?.next_before_id && (
          <button
            type="button"
            className="button button-secondary"
            onClick={() =>
              navigate({ before_id: String(audit.next_before_id) })
            }
          >
            Older actions
            <ChevronRight size={15} />
          </button>
        )}
      </div>
    </section>
  );
}
