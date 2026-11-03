"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { holdCountdown } from "@/lib/decisions";
import { dateTime, plural } from "@/lib/format";
import type { Decision, OpenCounts } from "@/lib/types";

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
// when their hold expires.
function Deadline({ open }: { open: OpenCounts }) {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    // Computed after mount, so the server and browser render the same text first.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
