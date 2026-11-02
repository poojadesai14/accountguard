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

export function UnblockForm({
  keyId,
  accountId,
  takeover = false,
}: {
  keyId: string;
  accountId?: string;
  /** The account has a confirmed takeover: restoring is recovery, typed. */
  takeover?: boolean;
}) {
  const [state, action, pending] = useActionState(unblockKey, {});
  const [confirm, setConfirm] = useState("");
  const confirmed = !takeover || confirm.trim() === accountId;
  return (
    <form action={action} className="review-form">
      <input type="hidden" name="key_id" value={keyId} />
      {takeover && (
        <div className="resolve-warning" role="note">
          <strong>This key was locked for a confirmed takeover.</strong>
          <p>
            Restore it only after the owner has secured the account and rotated
            this key; otherwise the attacker can send again.
          </p>
          <label>
            Type <span className="mono">{accountId}</span> to confirm
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
        Restoring access allows this key to send again. Confirm the credential
        has been secured before proceeding.
      </p>
      <Feedback state={state} />
      <button
        className="button button-secondary"
        disabled={pending || !confirmed}
      >
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

// DecidePanel is where a decision is acted on. An analyst judges an incident,
// not an email: while the account has open reviews, the panel leads with
// resolving all of them (one audited action that labels each decision
// underneath), and handling just this email is the exception, folded away for a
// mixed incident where some stopped emails were the owner's.
export function DecidePanel({
  decision,
  open,
  initialAction,
  onDirtyChange,
  onPendingChange,
  onSuccess,
}: {
  decision: Decision;
  open?: OpenCounts;
  initialAction?: "confirm_takeover" | "mark_legitimate";
  onDirtyChange?: (dirty: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
  onSuccess?: (message: string, next?: NextStep[]) => void;
}) {
  const [single, setSingle] = useState(Boolean(initialAction));
  // Once shown, the incident panel stays until the page changes, so resolving
  // the last review keeps its confirmation instead of swapping the panel out.
  const [incident] = useState(Boolean(open && open.reviews > 0));
  const review = (
    <ReviewForm
      key={decision.decision_id}
      decision={decision}
      initialAction={initialAction}
      onDirtyChange={onDirtyChange}
      onPendingChange={onPendingChange}
      onSuccess={onSuccess}
    />
  );
  if (!open || (!incident && open.reviews === 0)) return review;
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  return (
    <div className="incident-decide">
      <h4>Resolve this incident</h4>
      <p className="form-help">
        {[
          plural(open.reviews, "open review"),
          open.pending_holds && plural(open.pending_holds, "held email"),
          open.suspended_keys && plural(open.suspended_keys, "suspended key"),
        ]
          .filter(Boolean)
          .join(" · ")}{" "}
        on this account, judged together. Each decision is labelled and audited
        underneath.
      </p>
      <ResolveAccountForm
        accountId={decision.account_id}
        open={open}
        onSuccess={onSuccess}
      />
      <details
        className="just-this"
        open={single}
        onToggle={(event) => setSingle(event.currentTarget.open)}
      >
        <summary>Handle just this email</summary>
        <p className="form-help">
          Only for a mixed incident, where some stopped emails were the owner's.
        </p>
        {single && review}
      </details>
    </div>
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
  onSuccess,
}: {
  accountId: string;
  open: OpenCounts;
  onSuccess?: (message: string, next?: NextStep[]) => void;
}) {
  const [state, action, pending] = useActionState(resolveAccount, {});
  const handled = useRef<FormState | undefined>(undefined);
  useEffect(() => {
    if (state.success && handled.current !== state) {
      handled.current = state;
      onSuccess?.(state.success, state.next);
    }
  }, [state, onSuccess]);
  const [outcome, setOutcome] = useState<"" | "legitimate" | "takeover">("");
  const [confirm, setConfirm] = useState("");
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  // Releases and restores are hard to take back: over attacker-looking evidence,
  // "legitimate" needs the account ID typed (the API enforces the same rule).
  const warnings = outcome === "legitimate" ? (open.warnings ?? []) : [];
  const confirmed = warnings.length === 0 || confirm.trim() === accountId;
  const [restore, setRestore] = useState(false);
  const list = open.list ?? [];
  const suspended = open.suspended_key_ids ?? [];
  const restorable = open.restorable_key_ids ?? [];
  const sentWith = open.review_key_ids ?? [];
  const keys = (ids: string[]) => ids.join(", ");
  // Spelled out for the chosen outcome: everything this will and won't change.
  const will: string[] = [];
  const wont: string[] = [];
  if (outcome === "takeover") {
    will.push(`Label ${plural(open.reviews, "review")} takeover.`);
    if (open.pending_holds)
      will.push(
        `Drop ${plural(open.pending_holds, "held email")}: never sent.`,
      );
    if (sentWith.length)
      will.push(
        `Suspend ${keys(sentWith)} on your authority (already suspended stays suspended).`,
      );
    wont.push("Restore any key or release any email.");
    wont.push("Teach the baseline anything from these emails.");
  } else if (outcome === "legitimate") {
    will.push(
      `Label ${plural(open.reviews, "review")} legitimate and teach the baseline their networks and domains.`,
    );
    if (open.pending_holds)
      will.push(
        `Release ${plural(open.pending_holds, "held email")}: they will be sent.`,
      );
    if (restore && restorable.length)
      will.push(`Restore ${keys(restorable)}: it can send again.`);
    const staying = suspended.filter(
      (k) => !(restore && restorable.includes(k)),
    );
    if (staying.length)
      wont.push(
        `Restore ${keys(staying)}: ${staying.length === 1 ? "it stays" : "they stay"} suspended${
          restorable.length && !restore ? " (tick the box to restore)" : ""
        }.`,
      );
  }
  return (
    <form action={action} className="review-form resolve-form">
      <input type="hidden" name="account_id" value={accountId} />
      {open.decision_ids.map((id) => (
        <input key={id} type="hidden" name="decision_id" value={id} />
      ))}
      {list.length > 0 && (
        <details className="resolve-list">
          <summary>
            See the {plural(list.length, "review")} this resolves
          </summary>
          <ol>
            {list.map((r) => (
              <li key={r.decision_id}>
                <Link
                  className="text-link"
                  href={`/decisions/${r.decision_id}`}
                >
                  {dateTime(r.occurred_at)}
                </Link>
                <span>
                  {humanize(r.action)} {r.score} · {humanize(r.primary_driver)}
                  {r.hold_status === "pending" ? " · email held" : ""}
                </span>
                <small className="muted">
                  {r.api_key_id ?? "no key"}
                  {r.detail ? ` · ${r.detail}` : ""}
                </small>
              </li>
            ))}
          </ol>
        </details>
      )}
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
              <strong>This won't</strong>
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
          Choose an outcome to see exactly what it will and won't change.
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
        {pending
          ? "Resolving…"
          : outcome
            ? `Resolve ${plural(open.reviews, "review")} as ${outcome}`
            : "Resolve account"}
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
