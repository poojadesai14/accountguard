import Link from "next/link";
import { LockKeyhole } from "lucide-react";
import type { DashboardQuery } from "@/lib/dashboard";
import {
  heldEventLabel,
  holdCountdown,
  scoreClassName,
  SUSPENDED_BY,
} from "@/lib/decisions";
import { dateTime, humanize, plural } from "@/lib/format";
import type { DashboardAccount } from "@/lib/types";
import { Badge } from "../ui";

// Deciding happens on the account's own page: the incident, its evidence and its
// keys, with the browser's Back returning to the filtered queue.
export const accountHref = (item: DashboardAccount) =>
  `/accounts/${encodeURIComponent(item.account_id)}`;

type Row = {
  item: DashboardAccount;
  query: DashboardQuery;
  /** The snapshot's time, so countdowns render the same on server and browser. */
  generatedAt: string;
};

// QueueRow opens the account from anywhere in the row for the mouse; the
// first-cell link is the keyboard and screen-reader target.
export function QueueRow({
  item,
  query,
  generatedAt,
  onOpen,
}: Row & { onOpen: (href: string) => void }) {
  const evidence = item.hits.find(
    (hit) => hit.name === item.primary_driver,
  )?.detail;
  return (
    <tr
      className="clickable-row"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button, a")) return;
        onOpen(accountHref(item));
      }}
    >
      <td className="dashboard-account">
        <SubjectCell item={item} query={query} />
      </td>
      <td className="dashboard-decision">
        <DecisionCell item={item} />
      </td>
      <td className="dashboard-driver">
        <span>{humanize(item.primary_driver)}</span>
        {evidence && <small title={evidence}>{evidence}</small>}
      </td>
      <td className="dashboard-current-state">
        <CurrentState item={item} query={query} generatedAt={generatedAt} />
      </td>
    </tr>
  );
}

function SubjectCell({ item, query }: Omit<Row, "generatedAt">) {
  if (query.view === "keys")
    return (
      <>
        <Link
          className="account-inspect mono"
          // Starts with the visible key so screen readers and voice control match it.
          aria-label={`${item.api_key_id} on ${item.account_id}: open account`}
          href={accountHref(item)}
        >
          {item.api_key_id}
        </Link>
        <small>Account {item.account_id}</small>
      </>
    );
  return (
    <>
      <Link
        className="account-inspect"
        aria-label={`Open ${item.account_id}`}
        href={accountHref(item)}
      >
        {item.account_id}
      </Link>
      <small className="mono" title={item.api_key_id ?? undefined}>
        {item.api_key_id ?? "No related API key"}
      </small>
      <small className="dashboard-event-time">
        {query.view === "holds"
          ? `${heldEventLabel(item.event_type, item.change_kind)} · `
          : ""}
        {dateTime(item.occurred_at)}
      </small>
    </>
  );
}

function DecisionCell({ item }: { item: DashboardAccount }) {
  if (item.label === "legitimate" || item.label === "takeover")
    // Reviewed: the verdict leads; the engine's call is history underneath,
    // with its original score.
    return (
      <>
        <div className="dashboard-outcome">
          {item.label === "legitimate" ? (
            <Badge action="allow">Marked legitimate</Badge>
          ) : (
            <Badge action="block">Confirmed takeover</Badge>
          )}
        </div>
        <small title="The engine's original call and risk score">
          Was {item.action} ·{" "}
          <span className="score-number">{item.score ?? "—"}</span>
        </small>
      </>
    );
  return (
    <>
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
      {item.label && <small>Reviewed: {humanize(item.label)}</small>}
    </>
  );
}

// CurrentState is what is still in force for the row: the hold's deadline, the
// key's suspension, other open reviews and, for baselines, whether it is learned.
function CurrentState({ item, query, generatedAt }: Row) {
  // Hold and key rows are about one event or key; account rows sum the account.
  const keyedRows = query.view === "holds" || query.view === "keys";
  return (
    <div className="dashboard-state">
      {query.view === "holds" && (
        <HoldState item={item} generatedAt={generatedAt} />
      )}
      <KeyState item={item} view={query.view} keyedRows={keyedRows} />
      {item.open_reviews > 1 && (
        <span>
          {plural(
            item.open_reviews,
            keyedRows ? "account review" : "open review",
          )}
        </span>
      )}
      {query.view === "flagged" && (
        <span className="muted">Email sent · no review</span>
      )}
      {query.tab === "baseline" && (
        <span className={item.baseline_ready ? "baseline-ready" : "muted"}>
          {item.baseline_ready ? "Baseline ready" : "Learning baseline"}
        </span>
      )}
    </div>
  );
}

function HoldState({
  item,
  generatedAt,
}: {
  item: DashboardAccount;
  generatedAt: string;
}) {
  const countdown = holdCountdown(item.hold_expires_at, generatedAt);
  return (
    <>
      <span
        className={countdown?.urgent ? "suspended-state" : "held-state"}
        title={
          item.hold_expires_at
            ? `Dropped if unanswered at ${dateTime(item.hold_expires_at)}`
            : undefined
        }
      >
        {countdown?.text ?? "Pending hold"}
      </span>
      {item.hold_expires_at && (
        <small className="muted">
          Dropped at {dateTime(item.hold_expires_at)}
        </small>
      )}
    </>
  );
}

function KeyState({
  item,
  view,
  keyedRows,
}: {
  item: DashboardAccount;
  view: DashboardQuery["view"];
  keyedRows: boolean;
}) {
  if (item.restore_pending)
    return (
      <>
        <Suspended>
          {!keyedRows && item.suspended_keys > 1
            ? `${item.suspended_keys} keys still suspended`
            : "Key still suspended"}
        </Suspended>
        <small className="muted">
          Restore access to finish
          {view === "keys" && item.key_suspended_at
            ? ` · suspended ${dateTime(item.key_suspended_at)}`
            : ""}
        </small>
      </>
    );
  if (view === "keys" && item.key_status === "suspended")
    return (
      <>
        <Suspended>
          {item.key_suspended_by
            ? SUSPENDED_BY[item.key_suspended_by]
            : "Key suspended"}
        </Suspended>
        {item.key_suspended_at && (
          <small className="muted">{dateTime(item.key_suspended_at)}</small>
        )}
      </>
    );
  if (keyedRows) {
    if (item.key_status === "suspended")
      return <Suspended>Key suspended</Suspended>;
    return item.key_status && <span>Key {item.key_status}</span>;
  }
  if (item.suspended_keys > 0)
    return (
      <Suspended>{plural(item.suspended_keys, "suspended key")}</Suspended>
    );
  return null;
}

function Suspended({ children }: { children: React.ReactNode }) {
  return (
    <span className="suspended-state">
      <LockKeyhole size={13} aria-hidden="true" />
      {children}
    </span>
  );
}
