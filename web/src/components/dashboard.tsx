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
import {
  dashboardURL,
  dashboardScope,
  type DashboardQuery,
} from "@/lib/dashboard";
import { scoreClassName } from "@/lib/decisions";
import { dateTime, humanize, number, periodQuery, PERIODS } from "@/lib/format";
import type { DashboardAccount, DashboardData } from "@/lib/types";
import { Badge, CardHeader, EmptyState } from "./ui";
import { DecisionChart } from "./charts";
import { DashboardDrawer } from "./dashboard-drawer";

const TABS = [
  { id: "attention", label: "Review queue" },
  { id: "baseline", label: "Legitimate baselines" },
  { id: "telemetry", label: "Telemetry" },
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
                  (next.telemetry_error &&
                  next.telemetry_period === previous.telemetry_period
                    ? previous.stats
                    : undefined),
                audit:
                  next.audit ??
                  (next.telemetry_error &&
                  next.telemetry_period === previous.telemetry_period &&
                  next.audit_before_id === previous.audit_before_id
                    ? previous.audit
                    : undefined),
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
  const tableSnapshot =
    data.scope === dashboardScope(query) ? snapshot : undefined;
  const stats = data.telemetry_period === query.period ? data.stats : undefined;
  const audit =
    data.telemetry_period === query.period &&
    data.audit_before_id === query.before_id
      ? data.audit
      : undefined;
  const hasTableFilters = Boolean(query.q || query.severity !== "all");
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
  const unit =
    query.view === "holds"
      ? "events"
      : query.view === "keys"
        ? "keys"
        : "accounts";
  const countUnit = tableSnapshot?.total === 1 ? unit.slice(0, -1) : unit;
  const firstShown = tableSnapshot?.items.length
    ? (tableSnapshot.page - 1) * tableSnapshot.limit + 1
    : 0;
  const lastShown = tableSnapshot?.items.length
    ? firstShown + tableSnapshot.items.length - 1
    : 0;
  const keyedRows = query.view === "holds" || query.view === "keys";
  const viewTitle =
    query.view === "holds"
      ? "Events on hold"
      : query.view === "keys"
        ? "Suspended API keys"
        : query.view === "healthy"
          ? "Healthy accounts"
          : query.tab === "baseline"
            ? "Legitimate accounts"
            : "Accounts to review";
  const metricCards = [
    {
      tab: "attention",
      view: "accounts",
      label: "Accounts to review",
      value: metrics?.attention_accounts,
      description: "Accounts with open reviews or suspended keys",
      tone: "flag",
      icon: <ShieldAlert size={18} />,
    },
    {
      tab: "attention",
      view: "holds",
      label: "Events on hold",
      value: metrics?.pending_quarantines,
      description: "Individual events waiting for release or review",
      tone: "hold",
      icon: <Clock3 size={18} />,
    },
    {
      tab: "attention",
      view: "keys",
      label: "Suspended API keys",
      value: metrics?.suspended_keys,
      description: "Keys with access currently suspended",
      tone: "block",
      icon: <LockKeyhole size={18} />,
    },
    {
      tab: "baseline",
      view: "healthy",
      label: "Healthy accounts",
      value: metrics?.healthy_baselines,
      description: "Legitimate, learned accounts with no open issues",
      tone: "allow",
      icon: <ShieldCheck size={18} />,
    },
  ] as const;
  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1 tabIndex={-1}>Account reviews</h1>
          <p className="page-description">
            Investigate unusual activity and act on the evidence.
          </p>
        </div>
        <div className="dashboard-header-tools">
          <div className="dashboard-status">
            <span
              className={`connection-badge ${data.error ? "connection-stale" : ""}`}
            >
              <span className="online-dot" />
              {data.error ? "API unavailable" : "API connected"}
            </span>
            {snapshot && (
              <span
                className="connection-badge"
                title={
                  snapshot.engine_mode === "shadow"
                    ? "Shadow mode: events are scored, but holds and blocks are not enforced automatically."
                    : "Enforcement mode: risk decisions automatically control whether events are allowed, held, or blocked."
                }
              >
                {snapshot.engine_mode === "shadow"
                  ? "Monitoring only"
                  : "Enforcement active"}
              </span>
            )}
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
          <div
            className="dashboard-freshness"
            title="Updates automatically every 30 seconds while visible"
          >
            <span
              title={snapshot ? dateTime(snapshot.generated_at) : undefined}
            >
              {snapshot
                ? `Updated ${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(snapshot.generated_at))} UTC`
                : "Waiting for an update"}
            </span>
            {(dirty || pending) && <span>Updates paused while reviewing</span>}
          </div>
        </div>
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
      <div
        className="stat-grid dashboard-metrics"
        role="group"
        aria-label="Dashboard views"
      >
        {metricCards.map((card) => (
          <button
            type="button"
            className={`stat-card stat-${card.tone}`}
            key={card.label}
            title={`View all: ${card.description}`}
            aria-label={`View ${card.label.toLowerCase()}`}
            aria-controls="dashboard-results"
            aria-describedby={`metric-count-${card.view}`}
            aria-pressed={
              query.tab === card.tab &&
              query.view === card.view &&
              !hasTableFilters
            }
            disabled={busy || card.value === undefined}
            onClick={() =>
              navigate({
                tab: card.tab,
                view: card.view,
                q: "",
                severity: "all",
                page: "1",
                before_id: "",
                inspect: "",
                decision: "",
                review: "",
              })
            }
          >
            <span className="stat-label">
              {card.label}
              <span>{card.icon}</span>
            </span>
            <strong className="stat-number" id={`metric-count-${card.view}`}>
              {card.value === undefined ? "—" : number(card.value)}
            </strong>
          </button>
        ))}
      </div>
      <p className="dashboard-counts-note">
        Global totals · account, event and key counts overlap.
      </p>
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
                  view: "accounts",
                  severity: tab.id === "attention" ? query.severity : "all",
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
            {query.tab === "attention" && (
              <div
                className="severity-pills"
                role="group"
                aria-label="Filter by decision"
              >
                {(
                  [
                    { value: "all", label: "All" },
                    { value: "block", label: "Block" },
                    { value: "hold", label: "Hold" },
                    { value: "flag", label: "Flag" },
                  ] as const
                ).map((item) => (
                  <button
                    type="button"
                    key={item.value}
                    aria-pressed={query.severity === item.value}
                    disabled={busy}
                    onClick={() =>
                      navigate({ severity: item.value, page: "1" })
                    }
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
            <form
              className="dashboard-search"
              onSubmit={(event) => {
                event.preventDefault();
                navigate({ q: search.trim(), page: "1" });
              }}
            >
              <div className="dashboard-search-field">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  aria-label="Search dashboard"
                  placeholder="Account, API key, IP, ASN, or signal…"
                  value={search}
                  maxLength={200}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
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
          <section
            id="dashboard-results"
            className="card dashboard-table-card"
            aria-busy={busy}
          >
            <CardHeader
              title={viewTitle}
              description={
                hasTableFilters
                  ? "Filtered results; cards show global totals."
                  : query.tab === "baseline" && query.view === "accounts"
                    ? "Includes healthy accounts and accounts still learning."
                    : undefined
              }
            >
              <div className="dashboard-table-controls">
                <span
                  className="count-pill"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {tableSnapshot
                    ? `${number(tableSnapshot.total)} ${countUnit}`
                    : "Unavailable"}
                </span>
                {query.view !== "accounts" && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => navigate({ view: "accounts", page: "1" })}
                  >
                    Clear view
                  </button>
                )}
                <label className="dashboard-sort">
                  <span>Sort by</span>
                  <select
                    value={query.sort}
                    disabled={busy}
                    onChange={(event) =>
                      navigate({
                        sort: event.target.value as DashboardQuery["sort"],
                        page: "1",
                      })
                    }
                  >
                    <option value="priority">Most severe first</option>
                    <option value="recent">Newest first</option>
                  </select>
                </label>
              </div>
            </CardHeader>
            {tableSnapshot?.items.length ? (
              <div className="table-scroll">
                <table aria-label="Dashboard accounts">
                  <colgroup>
                    <col style={{ width: "23%" }} />
                    <col style={{ width: "17%" }} />
                    <col style={{ width: "30%" }} />
                    <col style={{ width: "19%" }} />
                    <col style={{ width: "11%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Decision</th>
                      <th>Signal evidence</th>
                      <th>Current state</th>
                      <th>
                        <span className="sr-only">Review</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tableSnapshot.items.map((item) => {
                      const evidence = item.hits.find(
                        (hit) => hit.name === item.primary_driver,
                      )?.detail;
                      return (
                        <tr
                          key={
                            query.view === "holds"
                              ? item.decision_id
                              : query.view === "keys"
                                ? item.api_key_id
                                : item.account_id
                          }
                        >
                          <td className="dashboard-account">
                            <button
                              type="button"
                              className="account-inspect"
                              aria-label={`Inspect ${item.account_id}`}
                              onClick={() => inspect(item)}
                            >
                              {item.account_id}
                            </button>
                            <small
                              className="mono"
                              title={item.api_key_id ?? undefined}
                            >
                              {item.api_key_id ?? "No related API key"}
                            </small>
                            <small className="dashboard-event-time">
                              {dateTime(item.occurred_at)}
                            </small>
                          </td>
                          <td className="dashboard-decision">
                            <div
                              className="dashboard-outcome"
                              title={
                                item.enforced === false
                                  ? "Computed decision; not enforced"
                                  : "Recorded decision"
                              }
                            >
                              <Badge action={item.action} />
                              <span
                                className={`score-number ${scoreClassName(item.action)}`}
                                title="Original recorded risk score, out of 100"
                              >
                                {item.score ?? "—"}
                              </span>
                            </div>
                            {item.label && (
                              <small>Reviewed: {humanize(item.label)}</small>
                            )}
                          </td>
                          <td className="dashboard-driver">
                            <span>{humanize(item.primary_driver)}</span>
                            {evidence && (
                              <small title={evidence}>{evidence}</small>
                            )}
                          </td>
                          <td className="dashboard-current-state">
                            <div className="dashboard-state">
                              {query.view === "holds" && (
                                <span className="held-state">Pending hold</span>
                              )}
                              {keyedRows ? (
                                item.key_status === "suspended" ? (
                                  <span className="suspended-state">
                                    <LockKeyhole size={13} aria-hidden="true" />
                                    Key suspended
                                  </span>
                                ) : (
                                  item.key_status && (
                                    <span>Key {item.key_status}</span>
                                  )
                                )
                              ) : (
                                item.suspended_keys > 0 && (
                                  <span className="suspended-state">
                                    <LockKeyhole size={13} aria-hidden="true" />
                                    {item.suspended_keys} suspended key
                                    {item.suspended_keys === 1 ? "" : "s"}
                                  </span>
                                )
                              )}
                              {item.open_reviews > 0 && (
                                <span>
                                  {item.open_reviews}{" "}
                                  {keyedRows ? "account review" : "open review"}
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
                          <td className="dashboard-row-action">
                            <div className="row-actions">
                              <button
                                type="button"
                                className="button button-secondary"
                                onClick={() => inspect(item)}
                              >
                                {query.tab === "baseline" || !item.decision_id
                                  ? "View"
                                  : "Review"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                title={
                  data.error
                    ? "Dashboard data is unavailable"
                    : query.q || query.severity !== "all"
                      ? `No ${unit} match these filters`
                      : query.view === "holds"
                        ? "No events on hold"
                        : query.view === "keys"
                          ? "No suspended API keys"
                          : query.view === "healthy"
                            ? "No healthy accounts yet"
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
                {tableSnapshot
                  ? `Showing ${number(firstShown)}–${number(lastShown)} of ${number(tableSnapshot.total)} ${countUnit} · Page ${tableSnapshot.page}`
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
                  !tableSnapshot ||
                  tableSnapshot.page * tableSnapshot.limit >=
                    tableSnapshot.total
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
          {stats && (
            <dl className="telemetry-totals" aria-label="Decision totals">
              {(
                [
                  ["Events scored", stats.totals.events, ""],
                  ["Allowed", stats.totals.allow, "allow"],
                  ["Flagged", stats.totals.flag, "flag"],
                  ["Held", stats.totals.hold, "hold"],
                  ["Blocked", stats.totals.block, "block"],
                ] as const
              ).map(([label, value, action]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd className={action ? `score-${action}` : undefined}>
                    {number(value)}
                  </dd>
                </div>
              ))}
            </dl>
          )}
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
                <div className="signal-list">
                  {stats.top_signals.map((signal, index) => (
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
                            width: `${(signal.count / Math.max(1, stats.top_signals![0].count)) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
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
