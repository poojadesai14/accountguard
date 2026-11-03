"use client";

import { useActionState, useState } from "react";
import { suspendKey, unblockKey } from "@/app/actions";
import { Feedback, ReviewIdentity, RiskWarnings } from "./review-fields";

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
              <RiskWarnings warnings={warnings} />
              <p>
                If that wasn&apos;t the owner, the same sender can use it again.
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
      <ReviewIdentity state={state} />
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
      <ReviewIdentity state={state} />
      <p className="form-help">
        Suspending stops this key from sending and drops its held emails. The
        account&apos;s other keys keep working.
      </p>
      <Feedback state={state} />
      <button className="button button-danger" disabled={pending}>
        {pending ? "Suspending…" : "Suspend key"}
      </button>
    </form>
  );
}
