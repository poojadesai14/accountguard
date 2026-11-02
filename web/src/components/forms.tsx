"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Check, ChevronDown, LockKeyhole } from "lucide-react";
import {
  correctToTakeover,
  login,
  ownerResponse,
  resolveAccount,
  reviewDecision,
  suspendKey,
  unblockKey,
} from "@/app/actions";
import { riskyHits } from "@/lib/decisions";
import { dateTime, humanize } from "@/lib/format";
import type { FormState, NextStep } from "@/lib/review";
import type { Decision, OpenCounts, ReviewedDecision } from "@/lib/types";

function Feedback({ state }: { state: FormState }) {
  return (
    <div aria-live="polite">
      {state.error && (
        <p role="alert" className="form-feedback error">
          {state.error}
        </p>
      )}
      {state.success && (
        <p role="status" className="form-feedback success">
          <Check size={15} />
          {state.success}
        </p>
      )}
      <NextSteps next={state.next} />
    </div>
  );
}

// NextSteps links to whatever an action left to do, opened and ready.
export function NextSteps({ next }: { next?: NextStep[] }) {
  if (!next?.length) return null;
  return (
    <p className="next-steps">
      {next.map((step) => (
        <Link key={step.href} className="text-link" href={step.href}>
          {step.label} <ArrowRight size={14} aria-hidden="true" />
        </Link>
      ))}
    </p>
  );
}

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(login, {});
  return (
    <form action={action} className="login-form">
      <input type="hidden" name="next" value={next} />
      <label htmlFor="password">Workspace password</label>
      <div className="password-input">
        <LockKeyhole size={17} />
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={1024}
          placeholder="Enter your password"
        />
      </div>
      <Feedback state={state} />
      <button className="button button-primary" disabled={pending}>
        {pending ? "Signing in…" : "Open workspace"}
        <ArrowRight size={16} />
      </button>
    </form>
  );
}

function ReviewIdentity() {
  const id = useId();
  return (
    <>
      <label htmlFor={`${id}-actor`}>Your name</label>
      <input
        id={`${id}-actor`}
        name="actor"
        autoComplete="name"
        placeholder="Who is reviewing this?"
        required
        maxLength={100}
      />
      <label htmlFor={`${id}-reason`}>Reason</label>
      <textarea
        id={`${id}-reason`}
        name="reason"
        placeholder="Add the evidence behind your decision…"
        required
        maxLength={2000}
        rows={3}
      />
    </>
  );
}

export function ReviewForm({
  decision,
  initialAction,
  onDirtyChange,
  onPendingChange,
  onSuccess,
}: {
  decision: Decision;
  initialAction?: "confirm_takeover" | "mark_legitimate";
  onDirtyChange?: (dirty: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
  onSuccess?: (message: string, next?: NextStep[]) => void;
}) {
  const [state, action, pending] = useActionState(reviewDecision, {});
  const handled = useRef<FormState | undefined>(undefined);
  useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);
  useEffect(() => {
    if (state.success && handled.current !== state) {
      handled.current = state;
      onDirtyChange?.(false);
      onSuccess?.(state.success, state.next);
    }
  }, [state, onSuccess, onDirtyChange]);
  useEffect(
    () => () => {
      onDirtyChange?.(false);
      onPendingChange?.(false);
    },
    [onDirtyChange, onPendingChange],
  );
  const labeled = Boolean(decision.label);
  const canRelease = decision.hold_status === "pending";
  const [chosen, setChosen] = useState(
    labeled ? "release_hold" : (initialAction ?? ""),
  );
  const [confirm, setConfirm] = useState("");
  // Over attacker-looking evidence, "legitimate" needs the account ID typed.
  const warnings =
    chosen === "mark_legitimate" ? riskyHits(decision.hits ?? []) : [];
  const confirmed =
    warnings.length === 0 || confirm.trim() === decision.account_id;
  if (labeled && !canRelease)
    return (
      <div className="resolved-notice">
        <Check size={18} />
        <div>
          Review complete
          <p>
            This event is labeled {decision.label}. The full history is recorded
            below.
          </p>
          {/* The review that just labelled it: what's left, with links. */}
          <Feedback state={state} />
        </div>
      </div>
    );
  return (
    <form
      action={action}
      className="review-form"
      onChange={() => onDirtyChange?.(true)}
    >
      <input type="hidden" name="decision_id" value={decision.decision_id} />
      <label htmlFor="action">Review outcome</label>
      <div className="review-select">
        <select
          name="action"
          id="action"
          required
          value={chosen}
          onChange={(event) => setChosen(event.target.value)}
        >
          {!labeled && (
            // No default: "Mark legitimate" teaches the baseline, so it must
            // never be the outcome of an unread submit.
            <option value="" disabled>
              Choose an outcome…
            </option>
          )}
          {!labeled && <option value="mark_legitimate">Mark legitimate</option>}
          {!labeled && decision.api_key_id && (
            <option value="confirm_takeover">Confirm takeover</option>
          )}
          {canRelease && (
            <option value="release_hold">Release hold without labeling</option>
          )}
        </select>
        <ChevronDown size={16} aria-hidden="true" />
      </div>
      {warnings.length > 0 && (
        <div className="resolve-warning" role="note">
          <strong>This looks like a takeover:</strong>
          <ul>
            {warnings.map((w) => (
              <li key={w.name}>
                {humanize(w.name)}: {w.detail}
              </li>
            ))}
          </ul>
          <label>
            Type <span className="mono">{decision.account_id}</span> to confirm
            it is legitimate
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
      <ReviewIdentity />
      <p className="form-help">
        Affected key:{" "}
        <span className="mono">{decision.api_key_id ?? "No API key"}</span>
      </p>
      <p className="form-help">
        Confirming a takeover suspends the key and drops its pending holds.
        Marking legitimate teaches the baseline
        {canRelease ? " and releases this pending hold" : ""}; it does not
        unblock the key, and the account's other reviews stay open.
      </p>
      <Feedback state={state} />
      <button
        className="button button-primary"
        disabled={pending || !chosen || !confirmed}
      >
        {pending ? "Recording…" : "Record review"}
        <ArrowRight size={15} />
      </button>
    </form>
  );
}

export function UnblockForm({ keyId }: { keyId: string }) {
  const [state, action, pending] = useActionState(unblockKey, {});
  return (
    <form action={action} className="review-form">
      <input type="hidden" name="key_id" value={keyId} />
      <ReviewIdentity />
      <p className="form-help">
        Restoring access allows this key to send again. Confirm the credential
        has been secured before proceeding.
      </p>
      <Feedback state={state} />
      <button className="button button-secondary" disabled={pending}>
        {pending ? "Restoring…" : "Restore key access"}
      </button>
    </form>
  );
}

export function SuspendKeyForm({ keyId }: { keyId: string }) {
  const [state, action, pending] = useActionState(suspendKey, {});
  return (
    <form action={action} className="review-form">
      <input type="hidden" name="key_id" value={keyId} />
      <ReviewIdentity />
      <p className="form-help">
        Suspending stops this key from sending and drops its held emails. The
        account's other keys keep working.
      </p>
      <Feedback state={state} />
      <button className="button button-danger" disabled={pending}>
        {pending ? "Suspending…" : "Suspend key"}
      </button>
    </form>
  );
}

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
          {decisions.length} decision{decisions.length === 1 ? "" : "s"} marked
          legitimate
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
        keys they were sent with and drops those keys' held emails. Emails
        already released stay sent.
      </p>
      <ReviewIdentity />
      <Feedback state={state} />
      <button className="button button-danger" disabled={pending}>
        {pending ? "Correcting…" : "Correct to takeover"}
      </button>
    </form>
  );
}

export function OwnerForm({ decision }: { decision: Decision }) {
  const [state, action, pending] = useActionState(ownerResponse, {});
  if (decision.hold_status !== "pending")
    return (
      <div className="resolved-notice">
        <Check size={18} />
        <div>
          <strong>This hold is {decision.hold_status ?? "unavailable"}.</strong>
          <p>No response is needed.</p>
        </div>
      </div>
    );
  return (
    <form action={action} className="owner-form">
      <input type="hidden" name="decision_id" value={decision.decision_id} />
      <Feedback state={state} />
      <button
        name="response"
        value="this_was_me"
        className="button button-primary"
        disabled={pending}
      >
        This was me
      </button>
      <button
        name="response"
        value="not_me"
        className="button button-danger"
        disabled={pending}
      >
        Not me
      </button>
      <p className="form-help">
        “This was me” releases this hold and records the activity as legitimate.
        “Not me” suspends the key and drops its pending holds.
      </p>
    </form>
  );
}

// ResolveAccountForm closes an account's whole incident with one audited outcome.
// Restoring keys is a separate, unticked choice: a wrong call there lets an
// attacker send again.
export function ResolveAccountForm({
  accountId,
  open,
}: {
  accountId: string;
  open: OpenCounts;
}) {
  const [state, action, pending] = useActionState(resolveAccount, {});
  const [outcome, setOutcome] = useState<"" | "legitimate" | "takeover">("");
  const [confirm, setConfirm] = useState("");
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  // Releases and restores are hard to take back: over attacker-looking evidence,
  // "legitimate" needs the account ID typed (the API enforces the same rule).
  const warnings = outcome === "legitimate" ? (open.warnings ?? []) : [];
  const confirmed = warnings.length === 0 || confirm.trim() === accountId;
  return (
    <form action={action} className="review-form resolve-form">
      <input type="hidden" name="account_id" value={accountId} />
      {open.decision_ids.map((id) => (
        <input key={id} type="hidden" name="decision_id" value={id} />
      ))}
      <fieldset className="resolve-outcome">
        <legend>Outcome</legend>
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
      {outcome === "legitimate" && (
        <p className="form-help">
          Labels the open reviews legitimate and teaches the baseline from them
          {open.pending_holds
            ? `, and releases ${plural(open.pending_holds, "held email")}`
            : ""}
          .
        </p>
      )}
      {outcome === "takeover" && (
        <p className="form-help">
          Labels the open reviews takeover
          {open.pending_holds
            ? `, drops ${plural(open.pending_holds, "held email")}`
            : ""}{" "}
          and suspends the keys they were sent with.
        </p>
      )}
      {outcome === "legitimate" && open.restorable_keys > 0 && (
        <label className="restore-keys">
          <input type="checkbox" name="restore_keys" />
          Also restore{" "}
          {plural(open.restorable_keys, "automatically suspended key")}
        </label>
      )}
      {outcome === "legitimate" &&
        open.suspended_keys > open.restorable_keys && (
          <p className="form-help">
            {plural(open.suspended_keys - open.restorable_keys, "other key")}{" "}
            {open.suspended_keys - open.restorable_keys === 1
              ? "stays"
              : "stay"}{" "}
            suspended: restore those one at a time above.
          </p>
        )}
      {warnings.length > 0 && (
        <div className="resolve-warning" role="note">
          <strong>These reviews look like a takeover:</strong>
          <ul>
            {warnings.map((w) => (
              <li key={w.signal}>
                {humanize(w.signal)}: {w.detail}
              </li>
            ))}
          </ul>
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
      <ReviewIdentity />
      <Feedback state={state} />
      <button
        className="button button-primary"
        disabled={pending || !outcome || open.reviews === 0 || !confirmed}
      >
        {pending ? "Resolving…" : "Resolve account"}
      </button>
    </form>
  );
}

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
