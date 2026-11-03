"use client";

import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { ArrowRight, Check } from "lucide-react";
import { humanize } from "@/lib/format";
import type { FormState, NextStep } from "@/lib/review";

export function Feedback({ state }: { state: FormState }) {
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

// Required marks a field as needed to submit; screen readers get the input's own
// required state instead of the asterisk.
export function Required() {
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

// ReviewIdentity is the name and reason every audited action records. The reason
// is controlled so a failed submit keeps it: React resets uncontrolled fields
// after every form action, including one that returns an error.
export function ReviewIdentity({ state }: { state: FormState }) {
  const id = useId();
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [handled, setHandled] = useState(state);
  if (handled !== state) {
    setHandled(state);
    if (state.success) setReason("");
  }
  useEffect(() => {
    try {
      // Read after mount: the server has no localStorage, and the first client
      // render must match its HTML.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
    </>
  );
}

// RiskWarnings lists the risky signals behind a typed confirmation.
export function RiskWarnings({
  warnings,
}: {
  warnings: { signal: string; detail: string }[];
}) {
  return (
    <ul>
      {warnings.map((w) => (
        <li key={w.signal}>
          {humanize(w.signal)}: {w.detail}
        </li>
      ))}
    </ul>
  );
}
