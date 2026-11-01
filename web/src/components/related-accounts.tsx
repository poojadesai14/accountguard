"use client";

import Link from "next/link";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { dateTime } from "@/lib/format";
import type { RelatedIndicator } from "@/lib/types";
import { Badge } from "./ui";

const SHOWN = 5;

// RelatedAccounts lists the accounts behind one shared indicator: five at first,
// the rest on demand. The API lists up to its cap; anything beyond is counted only.
export function RelatedAccounts({
  indicator: r,
}: {
  indicator: RelatedIndicator;
}) {
  const [expanded, setExpanded] = useState(false);
  const listed = expanded ? r.top : r.top.slice(0, SHOWN);
  const hidden = r.top.length - listed.length;
  const unlisted = r.accounts - r.top.length;
  const plural = (n: number) => `${n} more account${n === 1 ? "" : "s"}`;
  return (
    <ul className="related-accounts">
      {listed.map((a) => (
        <li key={a.account_id}>
          <Link
            className="text-link mono"
            href={
              a.decision_id
                ? `/decisions/${a.decision_id}`
                : `/accounts/${encodeURIComponent(a.account_id)}`
            }
          >
            {a.account_id}
          </Link>
          <Badge action={a.worst_action} />
          {a.confirmed && <Badge action="block">Confirmed takeover</Badge>}
          <small>
            {a.events} event{a.events === 1 ? "" : "s"} · last{" "}
            {dateTime(a.last_at)}
          </small>
        </li>
      ))}
      {(hidden > 0 || expanded) && r.top.length > SHOWN && (
        <li>
          <button
            type="button"
            className="text-link related-more"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show fewer" : `Show ${plural(hidden)}`}
            {expanded ? (
              <ChevronUp size={14} aria-hidden="true" />
            ) : (
              <ChevronDown size={14} aria-hidden="true" />
            )}
          </button>
        </li>
      )}
      {unlisted > 0 && (expanded || hidden === 0) && (
        <li className="muted">
          +{plural(unlisted)} not listed (most severe shown first)
        </li>
      )}
    </ul>
  );
}
