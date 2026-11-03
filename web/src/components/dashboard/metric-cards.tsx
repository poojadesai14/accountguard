import type { DashboardQuery } from "@/lib/dashboard";
import { number } from "@/lib/format";
import type { DashboardSnapshot } from "@/lib/types";

const CARDS = [
  {
    tab: "attention",
    view: "accounts",
    label: "To review",
    name: "accounts to review",
    metric: "attention_accounts",
    description: "Accounts with open reviews or suspended keys",
    tone: "review",
  },
  {
    tab: "attention",
    view: "holds",
    label: "On hold",
    name: "events on hold",
    metric: "pending_quarantines",
    description: "Individual events waiting for release or review",
    tone: "hold",
  },
  {
    tab: "attention",
    view: "keys",
    label: "Keys suspended",
    name: "suspended API keys",
    metric: "suspended_keys",
    description: "Keys with access currently suspended",
    tone: "block",
  },
  {
    tab: "attention",
    view: "flagged",
    label: "Flagged",
    name: "flagged accounts",
    metric: "flagged_accounts",
    description:
      "Accounts whose latest decision was a flag, with nothing to review",
    tone: "flag",
  },
  {
    tab: "baseline",
    view: "healthy",
    label: "Healthy",
    name: "healthy accounts",
    metric: "healthy_baselines",
    description: "Legitimate, learned accounts with no open issues",
    tone: "allow",
  },
] as const;

// MetricCards are the global totals; each opens its own unfiltered drilldown.
export function MetricCards({
  query,
  metrics,
  filtered,
  busy,
  navigate,
}: {
  query: DashboardQuery;
  metrics?: DashboardSnapshot["metrics"];
  filtered: boolean;
  busy: boolean;
  navigate: (patch: Partial<DashboardQuery>) => void;
}) {
  return (
    <div className="view-counts" role="group" aria-label="Dashboard views">
      {CARDS.map((card) => {
        const value = metrics?.[card.metric];
        return (
          <button
            type="button"
            className="view-count-button"
            key={card.label}
            title={`View all: ${card.description}`}
            aria-label={`View ${card.name}`}
            aria-controls="dashboard-results"
            aria-describedby={`metric-count-${card.view}`}
            aria-pressed={
              query.tab === card.tab && query.view === card.view && !filtered
            }
            disabled={busy || value === undefined}
            onClick={() =>
              navigate({
                tab: card.tab,
                view: card.view,
                q: "",
                severity: "all",
                page: "1",
                before_id: "",
              })
            }
          >
            <span>{card.label}</span>
            <strong
              className={`view-count count-${card.tone}`}
              id={`metric-count-${card.view}`}
            >
              {value === undefined ? "—" : number(value)}
            </strong>
          </button>
        );
      })}
    </div>
  );
}
