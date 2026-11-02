"use client";

import { useState } from "react";
import { dateTime, humanize } from "@/lib/format";
import type { KeyStatus } from "@/lib/types";
import { SuspendKeyForm, UnblockForm } from "./forms";

// KeyLine is one line per key on the account: red with an audited restore while
// suspended, muted with an audited suspension while active. Marking an event
// legitimate never restores a key, so this is where the review's last step lives;
// and suspending here is the way back from a wrong legitimate call.
export function KeyLine({
  keyStatus: key,
  hint,
  initiallyOpen = false,
}: {
  keyStatus: KeyStatus;
  hint?: string;
  /** Opened by a "Restore access" link from a review. */
  initiallyOpen?: boolean;
}) {
  // The form is only mounted once opened, so it never duplicates the review
  // form's fields on the same page. It keeps the action it was opened for, so its
  // confirmation stays after the key's status flips.
  const suspended = key.status === "suspended";
  const [mode, setMode] = useState<"restore" | "suspend" | null>(
    initiallyOpen && suspended ? "restore" : null,
  );
  // After a confirmed takeover, restoring is recovery, not a routine step.
  const locked = suspended && key.takeover;
  const restoreLabel = locked ? "Restore after recovery" : "Restore access";
  const summary =
    mode === "restore"
      ? suspended
        ? restoreLabel
        : "Restored"
      : mode === "suspend"
        ? suspended
          ? "Suspended"
          : "Suspend key"
        : suspended
          ? restoreLabel
          : "Suspend key";
  return (
    <div className="key-line">
      <span className={suspended ? "suspended-state" : "muted"}>
        <span className="mono">{key.api_key_id}</span> {key.status}
        {locked && " · confirmed takeover"}
        {suspended && !locked && key.warnings?.length
          ? ` · stopped for ${key.warnings.map((w) => humanize(w.signal)).join(", ")}`
          : ""}
      </span>
      {key.updated_at && (
        <span className="muted">
          {humanize(key.reason)} · {dateTime(key.updated_at)}
        </span>
      )}
      {hint && suspended && <strong className="key-hint">{hint}</strong>}
      <details
        open={mode !== null}
        onToggle={(event) =>
          setMode(
            event.currentTarget.open
              ? (mode ?? (suspended ? "restore" : "suspend"))
              : null,
          )
        }
      >
        <summary>{summary}</summary>
        {mode === "restore" && (
          <UnblockForm
            keyId={key.api_key_id}
            accountId={key.account_id}
            takeover={Boolean(key.takeover)}
            warnings={key.warnings}
          />
        )}
        {mode === "suspend" && <SuspendKeyForm keyId={key.api_key_id} />}
      </details>
    </div>
  );
}
