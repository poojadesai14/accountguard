"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Check, LockKeyhole } from "lucide-react";
import {
  correctToTakeover,
  login,
  ownerResponse,
  resolveAccount,
  suspendKey,
  unblockKey,
} from "@/app/actions";
import { holdCountdown } from "@/lib/decisions";
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
function NextSteps({ next }: { next?: NextStep[] }) {
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

// Required marks a field as needed to submit; screen readers get the input's own
// required state instead of the asterisk.
function Required() {
  return (
    <span className="required" aria-hidden="true">
      {" "}
      *
    </span>
  );
}

// The analyst's name is remembered in this browser, so it isn't retyped on every
// action; the reason is always written fresh, since it is the audit trail.
const ANALYST_NAME = "ato.analyst-name";

function ReviewIdentity() {
  const id = useId();
  const [name, setName] = useState("");
  useEffect(() => {
    try {
      setName(window.localStorage.getItem(ANALYST_NAME) ?? "");
    } catch {
      // Storage unavailable: the field simply starts empty.
    }
  }, []);
  return (
    <>
      <span className="field-label">
        <label htmlFor={`${id}-actor`}>Your name</label>
        <Required />
      </span>
      <input
        id={`${id}-actor`}
        name="actor"
        autoComplete="name"
        placeholder="Who is reviewing this?"
        required
        maxLength={100}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          try {
            window.localStorage.setItem(ANALYST_NAME, event.target.value);
          } catch {
            // Not remembered; still submitted.
          }
        }}
      />
      <span className="field-label">
        <label htmlFor={`${id}-reason`}>Reason</label>
        <Required />
      </span>
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

export function UnblockForm({
  keyId,
  accountId,
  takeover = false,
  warnings = [],
}: {
  keyId: string;
  accountId?: string;
  /** The account has a confirmed takeover: restoring is recovery, typed. */
  takeover?: boolean;
  /** Risky signals on the emails this key was stopped for: shown, and typed. */
  warnings?: { signal: string; detail: string }[];
}) {
  const [state, action, pending] = useActionState(unblockKey, {});
  const [confirm, setConfirm] = useState("");
  const risky = takeover || warnings.length > 0;
  const confirmed = !risky || confirm.trim() === accountId;
  return (
    <form action={action} className="review-form">
      <input type="hidden" name="key_id" value={keyId} />
      {risky && (
        <div className="resolve-warning" role="note">
          {takeover ? (
            <>
              <strong>This key was locked for a confirmed takeover.</strong>
              <p>
                Restore it only after the owner has secured the account and
                rotated this key; otherwise the attacker can send again.
              </p>
            </>
          ) : (
            <>
              <strong>
                Restoring lets this key send again. It was stopped for:
              </strong>
              <ul>
                {warnings.map((w) => (
                  <li key={w.signal}>
                    {humanize(w.signal)}: {w.detail}
                  </li>
                ))}
              </ul>
              <p>
                If that wasn't the owner, the same sender can use it again.
                Restore only if you are sure.
              </p>
            </>
          )}
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

// IncidentPanel is the decision page's link to the decision: an analyst decides
// the account's incident on the account page, not one email at a time.
export function IncidentPanel({
  decision,
  open,
}: {
  decision: Decision;
  open?: OpenCounts;
}) {
  const href = `/accounts/${encodeURIComponent(decision.account_id)}`;
  if (!open?.reviews)
    return (
      <div className="resolved-notice">
        <Check size={18} />
        <div>
          {decision.label ? `Reviewed: ${decision.label}` : "Nothing to decide"}
          <p>
            Nothing is open on this account.{" "}
            <Link className="text-link" href={href}>
              Open account
            </Link>
          </p>
        </div>
      </div>
    );
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  return (
    <div className="incident-decide">
      <h4>Part of an open incident</h4>
      <Deadline open={open} />
      <p className="form-help">
        {[
          plural(open.reviews, "open review"),
          open.pending_holds && plural(open.pending_holds, "held email"),
          open.suspended_keys && plural(open.suspended_keys, "suspended key"),
        ]
          .filter(Boolean)
          .join(" · ")}{" "}
        on this account, decided together.
      </p>
      <Link className="button button-primary" href={`${href}?resolve=1`}>
        Decide on the account page
        <ArrowRight size={15} />
      </Link>
    </div>
  );
}

// Deadline is the one time-bound fact: held emails are dropped automatically
// when their hold expires. The countdown is computed after mount, so the server
// and browser render the same text first.
function Deadline({ open }: { open: OpenCounts }) {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    setNow(new Date().toISOString());
    const timer = setInterval(() => setNow(new Date().toISOString()), 60_000);
    return () => clearInterval(timer);
  }, []);
  if (!open.holds_expire_at || !open.pending_holds) return null;
  const countdown = now ? holdCountdown(open.holds_expire_at, now) : null;
  return (
    <p
      className={`incident-deadline${countdown?.urgent ? " urgent" : ""}`}
      role="note"
    >
      <strong>Decide by {dateTime(open.holds_expire_at)}</strong>
      {countdown ? ` (${countdown.text.toLowerCase()})` : ""}:{" "}
      {open.pending_holds === 1
        ? "the held email is dropped"
        : `the first of ${open.pending_holds} held emails is dropped`}{" "}
      automatically then.
    </p>
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
function ResolveAccountForm({
  accountId,
  open,
  initialOutcome = "",
  onSuccess,
  onDirtyChange,
  onPendingChange,
}: {
  accountId: string;
  open: OpenCounts;
  /** Preselected from the queue's review shortcut; still needs confirming. */
  initialOutcome?: "" | "legitimate" | "takeover";
  onSuccess?: (message: string, next?: NextStep[]) => void;
  /** Like ReviewForm: a draft in progress pauses the dashboard's polling. */
  onDirtyChange?: (dirty: boolean) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [state, action, pending] = useActionState(resolveAccount, {});
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
  const [outcome, setOutcome] = useState<"" | "legitimate" | "takeover">(
    initialOutcome,
  );
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
    <form
      action={action}
      className="review-form resolve-form"
      onChange={() => onDirtyChange?.(true)}
    >
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
      )}
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
