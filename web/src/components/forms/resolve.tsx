"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { resolveAccount } from "@/app/actions";
import { dateTime, humanize, plural } from "@/lib/format";
import { resolveEffects, type ResolveOutcome } from "@/lib/resolve";
import type { OpenCounts, OpenReview } from "@/lib/types";
import {
  Feedback,
  Required,
  ReviewIdentity,
  RiskWarnings,
} from "./review-fields";

// ResolveCard mounts the form only once opened, so its fields never duplicate
// another form's on the account page. The page always renders it; it hides itself
// when no review is open, except while showing the result of a resolution that
// just closed the last one. A suspended key alone is restored from its key line.
export function ResolveCard({
  accountId,
  open,
  summary,
  initiallyOpen = false,
}: {
  accountId: string;
  open: OpenCounts;
  summary: string;
  /** Opened by a "Resolve the rest" link from a review. */
  initiallyOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyOpen && open.reviews > 0);
  if (!expanded && open.reviews === 0) return null;
  return (
    <details
      open={expanded}
      className="card resolve-card"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <strong>Resolve account</strong>
        <span className="muted">{summary}</span>
      </summary>
      {expanded && <ResolveAccountForm accountId={accountId} open={open} />}
    </details>
  );
}

// ResolveAccountForm closes an account's whole incident with one audited outcome.
// Restoring keys is a separate, unticked choice: a wrong call there lets an
// attacker send again.
function ResolveAccountForm({
  accountId,
  open,
}: {
  accountId: string;
  open: OpenCounts;
}) {
  const [state, action, pending] = useActionState(resolveAccount, {});
  const [outcome, setOutcome] = useState<ResolveOutcome>("");
  const [confirm, setConfirm] = useState("");
  const [restore, setRestore] = useState(false);
  // Releases and restores are hard to take back: over attacker-looking evidence,
  // "legitimate" needs the account ID typed (the API enforces the same rule).
  const warnings = outcome === "legitimate" ? (open.warnings ?? []) : [];
  const confirmed = warnings.length === 0 || confirm.trim() === accountId;
  const restorable = open.restorable_key_ids ?? [];
  const { will, wont } = resolveEffects(open, outcome, restore);
  return (
    <form action={action} className="review-form resolve-form">
      <input type="hidden" name="account_id" value={accountId} />
      {open.decision_ids.map((id) => (
        <input key={id} type="hidden" name="decision_id" value={id} />
      ))}
      <ReviewList reviews={open.list ?? []} />
      <fieldset className="resolve-outcome">
        <legend>
          Outcome
          <Required />
        </legend>
        {(
          [
            ["legitimate", "Legitimate"],
            ["takeover", "Takeover"],
          ] as const
        ).map(([value, label]) => (
          <label key={value}>
            <input
              type="radio"
              name="outcome"
              value={value}
              required
              checked={outcome === value}
              onChange={() => setOutcome(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {outcome === "legitimate" && restorable.length > 0 && (
        <label className="restore-keys">
          <input
            type="checkbox"
            name="restore_keys"
            checked={restore}
            onChange={(event) => setRestore(event.target.checked)}
          />
          Also restore{" "}
          {plural(restorable.length, "automatically suspended key")}
        </label>
      )}
      {outcome ? (
        <div className="resolve-effects" aria-live="polite">
          <strong>This will</strong>
          <ul>
            {will.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {wont.length > 0 && (
            <>
              <strong>This won&apos;t</strong>
              <ul>
                {wont.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <p className="form-help">
          Choose an outcome to see exactly what it will and won&apos;t change.
        </p>
      )}
      {warnings.length > 0 && (
        <div className="resolve-warning" role="note">
          <strong>These reviews look like a takeover:</strong>
          <RiskWarnings warnings={warnings} />
          <label>
            Type <span className="mono">{accountId}</span> to confirm they are
            legitimate
            <input
              name="confirm"
              autoComplete="off"
              spellCheck={false}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </label>
        </div>
      )}
      <ReviewIdentity state={state} />
      <Feedback state={state} />
      <button
        className="button button-primary"
        disabled={pending || !outcome || open.reviews === 0 || !confirmed}
      >
        {pending
          ? "Resolving…"
          : outcome
            ? `Resolve ${plural(open.reviews, "review")} as ${outcome}`
            : "Resolve account"}
      </button>
    </form>
  );
}

// ReviewList names every review the resolution closes, so the analyst agrees to
// a specific set.
function ReviewList({ reviews }: { reviews: OpenReview[] }) {
  if (reviews.length === 0) return null;
  return (
    <details className="resolve-list">
      <summary>
        See the {plural(reviews.length, "review")} this resolves
      </summary>
      <ol>
        {reviews.map((r) => (
          <li key={r.decision_id}>
            <Link className="text-link" href={`/decisions/${r.decision_id}`}>
              {dateTime(r.occurred_at)}
            </Link>
            <span>
              {humanize(r.action)} {r.score} · {humanize(r.primary_driver)}
              {r.hold_status === "pending"
                ? ` · email held${r.hold_expires_at ? `, dropped ${dateTime(r.hold_expires_at)}` : ""}`
                : ""}
            </span>
            <small className="muted">
              {r.api_key_id ?? "no key"}
              {r.detail ? ` · ${r.detail}` : ""}
            </small>
          </li>
        ))}
      </ol>
    </details>
  );
}
