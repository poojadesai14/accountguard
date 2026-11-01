"use client";

import { useState } from "react";
import { dateTime, humanize } from "@/lib/format";
import type { KeyStatus } from "@/lib/types";
import { UnblockForm } from "./forms";

// KeyLine is one line per key that has been suspended: red with an audited
// restore while suspended, muted once restored. Marking an event legitimate never
// restores a key, so this is where the review's last step lives.
export function KeyLine({
  keyStatus: key,
  hint,
}: {
  keyStatus: KeyStatus;
  hint?: string;
}) {
  // The restore form is only mounted once opened, so it never duplicates the
  // review form's fields on the same page.
  const [open, setOpen] = useState(false);
  return (
    <div className="key-line">
      <span
        className={key.status === "suspended" ? "suspended-state" : "muted"}
      >
        <span className="mono">{key.api_key_id}</span> {key.status}
      </span>
      <span className="muted">
        {humanize(key.reason)} · {dateTime(key.updated_at)}
      </span>
      {hint && key.status === "suspended" && (
        <strong className="key-hint">{hint}</strong>
      )}
      {(key.status === "suspended" || open) && (
        <details
          open={open}
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary>
            {key.status === "suspended" ? "Restore access" : "Restored"}
          </summary>
          {open && <UnblockForm keyId={key.api_key_id} />}
        </details>
      )}
    </div>
  );
}
