import type { DashboardQuery } from "@/lib/dashboard";
import type { DashboardAccount } from "@/lib/types";

export type ViewKey = "accounts" | "baseline" | "holds" | "keys" | "healthy";

type ViewCopy = {
  title: string;
  description?: string;
  /** Plural noun for counts; the singular drops the final "s". */
  unit: string;
  /** Each drilldown answers its own question, so the first, second and last columns follow the view. */
  columns: [string, string, string];
  empty: string;
  rowKey: (item: DashboardAccount) => string | null;
};

const ACCOUNT_COLUMNS: ViewCopy["columns"] = [
  "Account",
  "Decision",
  "Current state",
];
const byAccount = (item: DashboardAccount) => item.account_id;

export const VIEW_COPY: Record<ViewKey, ViewCopy> = {
  accounts: {
    title: "Accounts to review",
    unit: "accounts",
    columns: ACCOUNT_COLUMNS,
    empty: "Your review queue is clear.",
    rowKey: byAccount,
  },
  baseline: {
    title: "Legitimate accounts",
    description: "Includes healthy accounts and accounts still learning.",
    unit: "accounts",
    columns: ACCOUNT_COLUMNS,
    empty: "No legitimate baselines yet",
    rowKey: byAccount,
  },
  holds: {
    title: "Events on hold",
    unit: "events",
    columns: ["Held event", "Decision", "Hold"],
    empty: "No events on hold",
    rowKey: (item) => item.decision_id,
  },
  keys: {
    title: "Suspended API keys",
    unit: "keys",
    columns: ["API key", "Triggered by", "Suspension"],
    empty: "No suspended API keys",
    rowKey: (item) => item.api_key_id,
  },
  healthy: {
    title: "Healthy accounts",
    unit: "accounts",
    columns: ACCOUNT_COLUMNS,
    empty: "No healthy accounts yet",
    rowKey: byAccount,
  },
};

// The accounts view lists a different segment on each tab.
export function viewKey(query: DashboardQuery): ViewKey {
  return query.view === "accounts" && query.tab === "baseline"
    ? "baseline"
    : query.view;
}

export const TAB_TITLES: Record<DashboardQuery["tab"], string> = {
  attention: "Review queue",
  baseline: "Legitimate baselines",
  telemetry: "Telemetry",
};
