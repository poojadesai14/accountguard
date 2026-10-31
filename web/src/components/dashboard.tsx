"use client";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clock3,
  Flag,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { loadDashboard } from "@/app/dashboard-data";
import { dashboardURL, type DashboardQuery } from "@/lib/dashboard";
import { dateTime, humanize, number, periodQuery, PERIODS } from "@/lib/format";
import type { DashboardAccount, DashboardData } from "@/lib/types";
import { Badge, CardHeader, EmptyState } from "./ui";
import { DecisionChart } from "./charts";
import { DashboardDrawer } from "./dashboard-drawer";

const TABS = [
  { id: "attention", label: "Quarantined & Misusing" },
  { id: "baseline", label: "Legitimate Baselines" },
  { id: "telemetry", label: "Aggregated Telemetry" },
] as const;
export function Dashboard({
  query,
  initial,
}: {
  query: DashboardQuery;
  initial: DashboardData;
}) {
  const router = useRouter();
  const [data, setData] = useState(initial);
  const [search, setSearch] = useState(query.q);
  const [refreshing, setRefreshing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [toast, setToast] = useState("");
  const [navigationPending, startNavigation] = useTransition();
  const currentQuery = useRef(query);
  currentQuery.current = query;
  const draft = useRef(false);
  const submitting = useRef(false);
  const navigating = useRef(false);
  navigating.current = navigationPending;
  const inFlight = useRef(false);
  const version = useRef(0);
  useEffect(() => {
    version.current++;
    setSearch(query.q);
    setData((previous) =>
      initial.snapshot
        ? initial
        : { ...previous, error: initial.error, database_ok: false },
    );
  }, [initial, query]);
  const onDirty = useCallback((value: boolean) => {
    draft.current = value;
    setDirty(value);
  }, []);
  const onPending = useCallback((value: boolean) => {
    submitting.current = value;
    setPending(value);
  }, []);
  const refresh = useCallback(async (force = false) => {
    if (
      inFlight.current ||
      navigating.current ||
      (!force &&
        (draft.current ||
          submitting.current ||
          document.visibilityState !== "visible"))
    )
      return;
    inFlight.current = true;
    setRefreshing(true);
    const generation = version.current;
    try {
      const next = await loadDashboard(currentQuery.current);
      if (generation === version.current)
        setData((previous) =>
          next.snapshot
            ? {
                ...next,
                stats:
                  next.stats ??
                  (next.telemetry_error ? previous.stats : undefined),
                audit:
                  next.audit ??
                  (next.telemetry_error ? previous.audit : undefined),
              }
            : {
                ...previous,
                error: next.error ?? "Refresh failed.",
                database_ok: false,
              },
        );
    } catch {
      if (generation === version.current)
        setData((previous) => ({
          ...previous,
          error: "Refresh failed. Please try again.",
          database_ok: false,
        }));
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 30_000);
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 7000);
    return () => clearTimeout(timer);
  }, [toast]);
  function navigate(patch: Partial<DashboardQuery>) {
    if (submitting.current) return;
    if (draft.current && !window.confirm("Discard the unsaved review?")) return;
    version.current++;
    onDirty(false);
    startNavigation(() =>
      router.push(dashboardURL(currentQuery.current, patch), { scroll: false }),
    );
  }
  const onSuccess = useCallback(
    (message: string) => {
      onDirty(false);
      setToast(message);
      void refresh(true);
    },
    [onDirty, refresh],
  );
  const snapshot = data.snapshot;
  const busy = refreshing || navigationPending || pending;
  function inspect(
    item: DashboardAccount,
    review: DashboardQuery["review"] = "",
  ) {
    navigate({
      inspect: item.account_id,
      decision: item.decision_id ?? "",
      review,
    });
  }
  const period = periodQuery(query.period);
  const range = new URLSearchParams(period.query);
  const metrics = snapshot?.metrics;
  const metricCards = [
    {
      label: "Accounts needing attention",
      value: metrics?.attention_accounts,
      description: "Open reviews or suspended keys",
      icon: <ShieldAlert size={18} />,
    },
    {
      label: "Pending quarantines",
      value: metrics?.pending_quarantines,
      description: "Held decisions awaiting resolution",
      icon: <Clock3 size={18} />,
    },
    {
      label: "Suspended keys",
      value: metrics?.suspended_keys,
      description: "Current key access overrides",
      icon: <LockKeyhole size={18} />,
    },
    {
      label: "Healthy baselines",
      value: metrics?.healthy_baselines,
      description: "Legitimate, learned, and clear",
      icon: <ShieldCheck size={18} />,
    },
  ];
  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">TRUST & SAFETY</p>
          <h1 tabIndex={-1}>ATO Analyst Workspace</h1>
          <p className="page-description">
            Account risk, investigation, and audited decisions.
          </p>
        </div>
        <div className="dashboard-status">
          <span
            className={`connection-badge ${data.error ? "connection-stale" : ""}`}
          >
            <span className="online-dot" />
            {data.error ? "API unavailable" : "API connected"}
          </span>
          <span className="connection-badge">
            {data.database_ok ? "Database reachable" : "Database unverified"}
          </span>
          {snapshot && (
            <span className="connection-badge">
              Engine: {snapshot.engine_mode}
            </span>
          )}
        </div>
      </header>
      <div className="dashboard-freshness">
        <span>
          {snapshot
            ? `Last successful update: ${dateTime(snapshot.generated_at)}`
            : "Waiting for a dashboard snapshot"}
        </span>
        <span>
          {dirty || pending
            ? "Auto-refresh paused while reviewing"
            : "Auto-refresh every 30 seconds"}
        </span>
        <button
          type="button"
          className="button button-secondary"
          disabled={busy || dirty}
          onClick={() => void refresh()}
        >
          <RefreshCw size={15} className={refreshing ? "spin" : ""} />
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {data.error && (
        <div className="api-error" role="alert">
          <ShieldAlert size={20} />
          <div>
            <h3>Dashboard update failed</h3>
            <p>{data.error}</p>
            {snapshot && (
              <p className="muted">
                Showing the last successful snapshot. Results may not match the
                current filters.
              </p>
            )}
          </div>
        </div>
      )}
      <div className="stat-grid dashboard-metrics">
        {metricCards.map((card) => (
          <section className="stat-card" key={card.label}>
            <div className="stat-label">
              {card.label}
              <span>{card.icon}</span>
            </div>
            <strong className="stat-number">
              {card.value === undefined ? "—" : number(card.value)}
            </strong>
            <p className="metric-description">{card.description}</p>
          </section>
        ))}
      </div>
      <div className="dashboard-toolbar">
        <nav className="dashboard-tabs" aria-label="Dashboard sections">
          {TABS.map((tab) => (
            <button
              type="button"
              key={tab.id}
              aria-current={query.tab === tab.id ? "page" : undefined}
              className={query.tab === tab.id ? "selected" : ""}
              disabled={busy}
              onClick={() =>
                navigate({
                  tab: tab.id,
                  page: "1",
                  before_id: "",
                  inspect: "",
                  decision: "",
                  review: "",
                })
              }
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>
      {query.tab !== "telemetry" ? (
        <>
          <div className="dashboard-filters">
            <div
              className="severity-pills"
              role="group"
              aria-label="Risk score filter"
            >
              {(
                [
                  { value: "all", label: "All" },
                  { value: "high", label: "High ≥80" },
                  { value: "medium", label: "Medium 40–79" },
                ] as const
              ).map((item) => (
                <button
                  type="button"
                  key={item.value}
                  aria-pressed={query.severity === item.value}
                  disabled={busy}
                  onClick={() => navigate({ severity: item.value, page: "1" })}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <form
              className="dashboard-search"
              onSubmit={(event) => {
                event.preventDefault();
                navigate({ q: search.trim(), page: "1" });
              }}
            >
              <Search size={16} />
              <input
                type="search"
                aria-label="Search dashboard"
                placeholder="Account, API key, IP, ASN, or signal…"
                value={search}
                maxLength={200}
                onChange={(event) => setSearch(event.target.value)}
              />
              <button
                type="submit"
                className="button button-secondary"
                disabled={busy}
              >
                Search
              </button>
              {(query.q || query.severity !== "all") && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    navigate({ q: "", severity: "all", page: "1" })
                  }
                >
                  Clear
                </button>
              )}
            </form>
          </div>
          <section className="card dashboard-table-card" aria-busy={busy}>
            <CardHeader
              title={
                query.tab === "baseline"
                  ? "Legitimate accounts"
                  : "Accounts requiring attention"
              }
              description={
                query.tab === "baseline"
                  ? "No outstanding reviews or suspended keys; latest outcome is allowed or confirmed legitimate."
                  : "Highest-severity open decision per account, otherwise its latest recorded decision."
              }
            >
              <span className="count-pill">
                {number(snapshot?.total ?? 0)} accounts
              </span>
            </CardHeader>
            {snapshot?.items.length ? (
              <div className="table-scroll">
                <table aria-label="Dashboard accounts">
                  <thead>
                    <tr>
                      <th>Account & API key</th>
                      <th>Recorded decision</th>
                      <th>Risk</th>
                      <th>Primary signal</th>
                      <th>Network</th>
                      <th>State</th>
                      <th>Detected (UTC)</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.items.map((item) => (
                      <tr key={item.account_id}>
                        <td>
                          <button
                            type="button"
                            className="account-inspect"
                            aria-label={`Inspect ${item.account_id}`}
                            onClick={() => inspect(item)}
                          >
                            {item.account_id}
                          </button>
                          <small className="mono">
                            {item.api_key_id ?? "No related API key"}
                          </small>
                        </td>
                        <td>
                          <Badge action={item.action} />
                          {item.enforced === false && (
                            <small>Shadow decision</small>
                          )}
                          {item.label && (
                            <small>Reviewed: {humanize(item.label)}</small>
                          )}
                        </td>
                        <td>
                          <span
                            className={`score-number ${Number(item.score) >= 60 ? "elevated" : ""}`}
                          >
                            {item.score ?? "—"}
                          </span>
                          <small>Historical score</small>
                        </td>
                        <td className="dashboard-driver">
                          {humanize(item.primary_driver)}
                        </td>
                        <td>
                          <span className="mono">{item.ip ?? "—"}</span>
                          <small className="mono">
                            {item.asn ? `AS${item.asn}` : ""}
                            {item.asn_org ? ` · ${item.asn_org}` : ""}
                          </small>
                        </td>
                        <td>
                          <div className="dashboard-state">
                            {item.suspended_keys > 0 && (
                              <span className="badge badge-block">
                                {item.suspended_keys} suspended key
                                {item.suspended_keys === 1 ? "" : "s"}
                              </span>
                            )}
                            {item.key_status === "suspended" && (
                              <small>Related key suspended</small>
                            )}
                            {item.open_reviews > 0 && (
                              <span>
                                {item.open_reviews} open review
                                {item.open_reviews === 1 ? "" : "s"}
                              </span>
                            )}
                            {query.tab === "baseline" && (
                              <span
                                className={
                                  item.baseline_ready
                                    ? "baseline-ready"
                                    : "muted"
                                }
                              >
                                {item.baseline_ready
                                  ? "Baseline ready"
                                  : "Learning baseline"}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="timeline-time">
                          {dateTime(item.occurred_at)}
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="button button-secondary"
                              onClick={() => inspect(item)}
                            >
                              Inspect
                            </button>
                            {item.decision_id && !item.label && (
                              <>
                                <button
                                  type="button"
                                  className="text-button"
                                  onClick={() =>
                                    inspect(item, "mark_legitimate")
                                  }
                                >
                                  Mark legitimate
                                </button>
                                {item.api_key_id && (
                                  <button
                                    type="button"
                                    className="text-button danger-text"
                                    onClick={() =>
                                      inspect(item, "confirm_takeover")
                                    }
                                  >
                                    Suspend key
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                title={
                  data.error
                    ? "Dashboard data is unavailable"
                    : query.q || query.severity !== "all"
                      ? "No accounts match these filters"
                      : query.tab === "baseline"
                        ? "No legitimate baselines yet"
                        : "Your review queue is clear."
                }
              >
                {data.error
                  ? "Refresh to try again."
                  : "Try another filter or open Accounts to inspect all stored history."}
              </EmptyState>
            )}
            <div className="dashboard-pagination">
              <span>
                {snapshot
                  ? `Page ${snapshot.page} · ${number(snapshot.total)} matching accounts`
                  : "No snapshot available"}
              </span>
              <button
                type="button"
                className="button button-secondary"
                disabled={busy || Number(query.page) <= 1}
                onClick={() =>
                  navigate({ page: String(Number(query.page) - 1) })
                }
              >
                <ChevronLeft size={15} />
                Previous
              </button>
              <button
                type="button"
                className="button button-secondary"
                disabled={
                  busy ||
                  !snapshot ||
                  snapshot.page * snapshot.limit >= snapshot.total
                }
                onClick={() =>
                  navigate({ page: String(Number(query.page) + 1) })
                }
              >
                Next
                <ChevronRight size={15} />
              </button>
            </div>
          </section>
        </>
      ) : (
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
                  {value === "all"
                    ? "All time"
                    : value === "24h"
                      ? "24 hours"
                      : value === "7d"
                        ? "7 days"
                        : "30 days"}
                </button>
              ))}
            </div>
          </div>
          {data.telemetry_error && (
            <p className="api-error" role="alert">
              {data.telemetry_error} Telemetry may be stale.
            </p>
          )}
          <div className="overview-middle">
            <section className="card activity-card">
              <CardHeader
                title="Elevated activity"
                description="Each outcome on its own row, sharing one timeline."
              />
              {data.stats ? (
                <DecisionChart
                  points={data.stats.series ?? []}
                  bucket={range.get("bucket") === "1d" ? "1d" : "1h"}
                  from={range.get("from") ?? undefined}
                  to={range.get("to") ?? undefined}
                />
              ) : (
                <EmptyState title="No telemetry snapshot" />
              )}
            </section>
            <section className="card signals-card">
              <CardHeader
                title="Risk drivers"
                description="Signal hits across the selected period."
              />
              {data.stats?.top_signals?.length ? (
                <div className="signal-list">
                  {data.stats.top_signals.map((signal, index) => (
                    <div className="signal-row" key={signal.name}>
                      <div>
                        <span className="signal-rank">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span>{humanize(signal.name)}</span>
                        <strong>{number(signal.count)}</strong>
                      </div>
                      <div className="signal-track">
                        <span
                          style={{
                            width: `${(signal.count / Math.max(1, data.stats!.top_signals![0].count)) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState compact title="No signal hits in this period" />
              )}
            </section>
          </div>
          <section className="card">
            <CardHeader
              title="Analyst audit stream"
              description="Recorded analyst and owner actions, newest ID first."
            />
            {data.audit?.items.length ? (
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
                    {data.audit.items.map((action) => (
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
                          <small className="mono">
                            {action.api_key_id ?? "—"}
                          </small>
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
              <EmptyState compact title="No analyst actions in this period" />
            )}
            <div className="dashboard-pagination">
              <span>
                Audit records are never synthesized from decision counts.
              </span>
              {query.before_id && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => navigate({ before_id: "" })}
                >
                  Latest actions
                </button>
              )}
              {data.audit?.next_before_id && (
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() =>
                    navigate({ before_id: String(data.audit!.next_before_id) })
                  }
                >
                  Older actions
                  <ChevronRight size={15} />
                </button>
              )}
            </div>
          </section>
        </>
      )}
      <p className="privacy-line">
        <CircleCheck size={14} />
        Stored metadata only. Email bodies, subjects, and recipient addresses
        are never displayed.
      </p>
      {query.inspect && (
        <DashboardDrawer
          key={query.inspect + query.decision + query.review}
          account={query.inspect}
          inspection={data.inspection}
          initialAction={query.review || undefined}
          onClose={() => navigate({ inspect: "", decision: "", review: "" })}
          onDirty={onDirty}
          onPending={onPending}
          onSuccess={onSuccess}
          toast={toast}
          dismissToast={() => setToast("")}
        />
      )}
      {toast && !query.inspect && (
        <div className="dashboard-toast" role="status">
          <Check size={18} />
          <span>{toast}</span>
          <button
            type="button"
            className="text-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
