import { useState } from "react";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import type { DashboardQuery } from "@/lib/dashboard";
import { number } from "@/lib/format";
import type { DashboardSnapshot } from "@/lib/types";
import { CardHeader, EmptyState } from "../ui";
import { QueueRow } from "./queue-row";
import { VIEW_COPY, viewKey } from "./view-copy";

const SEVERITIES = [
  { value: "all", label: "All" },
  { value: "block", label: "Block" },
  { value: "hold", label: "Hold" },
] as const;
const SORTS = [
  { value: "priority", label: "Most severe" },
  { value: "recent", label: "Newest" },
] as const;

// QueueView is the review queue and baseline list: filters, the results table
// for the selected view, and pagination.
export function QueueView({
  query,
  snapshot,
  error,
  busy,
  navigate,
  openPage,
}: {
  query: DashboardQuery;
  /** Undefined when no snapshot matches the current filters. */
  snapshot?: DashboardSnapshot;
  error?: string;
  busy: boolean;
  navigate: (patch: Partial<DashboardQuery>) => void;
  openPage: (href: string) => void;
}) {
  const copy = VIEW_COPY[viewKey(query)];
  const filtered = Boolean(query.q || query.severity !== "all");
  const countUnit = snapshot?.total === 1 ? copy.unit.slice(0, -1) : copy.unit;
  const firstShown = snapshot?.items.length
    ? (snapshot.page - 1) * snapshot.limit + 1
    : 0;
  const lastShown = snapshot?.items.length
    ? firstShown + snapshot.items.length - 1
    : 0;
  return (
    <>
      <div className="dashboard-filters">
        {query.tab === "attention" && query.view !== "flagged" && (
          <div
            className="severity-pills"
            role="group"
            aria-label="Filter by decision"
          >
            {SEVERITIES.map((item) => (
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
        )}
        <SearchForm query={query} navigate={navigate} />
      </div>
      <section
        id="dashboard-results"
        className="card dashboard-table-card"
        aria-busy={busy}
      >
        <CardHeader
          title={copy.title}
          description={
            filtered
              ? "Filtered results; cards show global totals."
              : copy.description
          }
        >
          <div className="dashboard-table-controls">
            <span className="count-pill" aria-live="polite" aria-atomic="true">
              {snapshot
                ? `${number(snapshot.total)} ${countUnit}`
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
            {/* Buttons, not a <select>: the open menu of a native select
                is drawn by the OS and can't follow the theme. */}
            <div className="dashboard-sort">
              <span id="dashboard-sort-label">Sort by</span>
              <div
                className="severity-pills"
                role="group"
                aria-labelledby="dashboard-sort-label"
              >
                {SORTS.map((item) => (
                  <button
                    type="button"
                    key={item.value}
                    aria-pressed={query.sort === item.value}
                    disabled={busy}
                    onClick={() => navigate({ sort: item.value, page: "1" })}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </CardHeader>
        {snapshot?.items.length ? (
          <div className="table-scroll">
            <table aria-label="Dashboard accounts">
              <colgroup>
                <col style={{ width: "25%" }} />
                <col style={{ width: "17%" }} />
                <col style={{ width: "34%" }} />
                <col style={{ width: "24%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th>{copy.columns[0]}</th>
                  <th>{copy.columns[1]}</th>
                  <th>Signal evidence</th>
                  <th>{copy.columns[2]}</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.items.map((item) => (
                  <QueueRow
                    key={copy.rowKey(item)}
                    item={item}
                    query={query}
                    generatedAt={snapshot.generated_at}
                    onOpen={openPage}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={
              error
                ? "Dashboard data is unavailable"
                : snapshot && snapshot.total > 0
                  ? `No ${copy.unit} on this page`
                  : filtered
                    ? `No ${copy.unit} match these filters`
                    : copy.empty
            }
          >
            {error
              ? "Refresh to try again."
              : snapshot && snapshot.total > 0
                ? "This page is past the end of the list. Go back to page 1."
                : "Try another filter or period."}
          </EmptyState>
        )}
        <div className="dashboard-pagination">
          <span>
            {snapshot
              ? `Showing ${number(firstShown)}–${number(lastShown)} of ${number(snapshot.total)} ${countUnit} · Page ${snapshot.page}`
              : "No snapshot available"}
          </span>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy || Number(query.page) <= 1}
            onClick={() => navigate({ page: String(Number(query.page) - 1) })}
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
            onClick={() => navigate({ page: String(Number(query.page) + 1) })}
          >
            Next
            <ChevronRight size={15} />
          </button>
        </div>
      </section>
    </>
  );
}

function SearchForm({
  query,
  navigate,
}: {
  query: DashboardQuery;
  navigate: (patch: Partial<DashboardQuery>) => void;
}) {
  const [search, setSearch] = useState(query.q);
  // A navigation (including Back) shows that page's own query in the box.
  const [shownQuery, setShownQuery] = useState(query);
  if (shownQuery !== query) {
    setShownQuery(query);
    setSearch(query.q);
  }
  return (
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
      {(query.q || query.severity !== "all") && (
        <button
          type="button"
          className="text-button"
          onClick={() => navigate({ q: "", severity: "all", page: "1" })}
        >
          Clear
        </button>
      )}
    </form>
  );
}
