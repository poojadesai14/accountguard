"use client";

import { useActionState, useState } from "react";
import { correctToTakeover } from "@/app/actions";
import { dateTime, humanize, plural } from "@/lib/format";
import type { ReviewedDecision } from "@/lib/types";
import { Feedback, ReviewIdentity } from "./review-fields";

// CorrectionCard undoes a wrong "legitimate": the chosen decisions become
// takeover, the baseline forgets them and their keys are suspended. Mounted on
// open, like ResolveCard, so its fields never duplicate another form's.
export function CorrectionCard({
  accountId,
  decisions,
}: {
  accountId: string;
  decisions: ReviewedDecision[];
}) {
  const [expanded, setExpanded] = useState(false);
  if (!expanded && decisions.length === 0) return null;
  return (
    <details
      className="card resolve-card"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <strong>Correct to takeover</strong>
        <span className="muted">
          {plural(decisions.length, "decision")} marked legitimate
        </span>
      </summary>
      {expanded && (
        <CorrectionForm accountId={accountId} decisions={decisions} />
      )}
    </details>
  );
}

function CorrectionForm({
  accountId,
  decisions,
}: {
  accountId: string;
  decisions: ReviewedDecision[];
}) {
  const [state, action, pending] = useActionState(correctToTakeover, {});
  return (
    <form action={action} className="review-form resolve-form">
      <input type="hidden" name="account_id" value={accountId} />
      <fieldset className="correction-list">
        <legend>Decisions to relabel takeover</legend>
        {decisions.map((d) => (
          <label key={d.decision_id}>
            <input
              type="checkbox"
              name="decision_id"
              value={d.decision_id}
              defaultChecked
            />
            <span>
              {humanize(d.action)} {d.score} · {humanize(d.primary_driver)}
            </span>
            <small className="muted">
              {d.api_key_id ?? "no key"} · {dateTime(d.occurred_at)}
            </small>
          </label>
        ))}
      </fieldset>
      <p className="form-help">
        Relabels them takeover, removes them from the baseline, suspends the
        keys they were sent with and drops those keys&apos; held emails. Emails
        already released stay sent.
      </p>
      <ReviewIdentity state={state} />
      <Feedback state={state} />
      <button className="button button-danger" disabled={pending}>
        {pending ? "Correcting…" : "Correct to takeover"}
      </button>
    </form>
  );
}
