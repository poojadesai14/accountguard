"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import { ArrowRight, Check, LockKeyhole } from "lucide-react";
import {
  login,
  ownerResponse,
  reviewDecision,
  unblockKey,
} from "@/app/actions";
import type { FormState } from "@/lib/review";
import type { Decision } from "@/lib/types";

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
    </div>
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
  onSuccess?: (message: string) => void;
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
      onSuccess?.(state.success);
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
      <select
        name="action"
        id="action"
        required
        defaultValue={
          !labeled ? (initialAction ?? "mark_legitimate") : "release_hold"
        }
      >
        {!labeled && <option value="mark_legitimate">Mark legitimate</option>}
        {!labeled && decision.api_key_id && (
          <option value="confirm_takeover">Confirm takeover</option>
        )}
        {canRelease && (
          <option value="release_hold">Release hold without labeling</option>
        )}
      </select>
      <ReviewIdentity />
      <p className="form-help">
        Affected key:{" "}
        <span className="mono">{decision.api_key_id ?? "No API key"}</span>
      </p>
      <p className="form-help">
        Confirming a takeover suspends the key and drops its pending holds.
        Marking legitimate teaches the baseline and releases this pending hold;
        it does not unblock the key.
      </p>
      <Feedback state={state} />
      <button className="button button-primary" disabled={pending}>
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
