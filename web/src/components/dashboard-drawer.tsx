"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef } from "react";
import { Check, X } from "lucide-react";
import { Badge, CardHeader, DetailList, EmptyState } from "./ui";
import { MetadataBlock } from "./investigation-workspace";
import { ReviewForm } from "./forms";
import { dateTime, humanize, number } from "@/lib/format";
import type { DashboardInspection } from "@/lib/types";

export function DashboardDrawer({
  account,
  inspection,
  initialAction,
  onClose,
  onDirty,
  onPending,
  onSuccess,
  toast,
  dismissToast,
}: {
  account: string;
  inspection?: DashboardInspection;
  initialAction?: "confirm_takeover" | "mark_legitimate";
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
  onPending: (pending: boolean) => void;
  onSuccess: (message: string) => void;
  toast?: string;
  dismissToast: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const reviewRef = useRef<HTMLElement>(null);
  const focusReview = useCallback(() => {
    reviewRef.current?.scrollIntoView({ block: "start" });
    reviewRef.current
      ?.querySelector<HTMLInputElement>('input[name="actor"]')
      ?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const element = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
      else document.querySelector<HTMLElement>(".dashboard-header h1")?.focus();
    };
  }, []);
  const detail = inspection?.detail;
  const decision = detail?.decision;
  const profile = inspection?.profile?.profile;
  useEffect(() => {
    if (initialAction && decision) focusReview();
  }, [initialAction, decision?.decision_id, focusReview]);
  return (
    <dialog
      ref={ref}
      className="inspection-drawer"
      aria-labelledby="inspection-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="drawer-header">
        <div>
          <p className="eyebrow">ACCOUNT INSPECTION</p>
          <h2 id="inspection-title">{account}</h2>
        </div>
        <div className="drawer-header-actions">
          {decision && !inspection?.error && (
            <button
              type="button"
              className="button button-secondary"
              onClick={focusReview}
            >
              Review event
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="Close inspection"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
      </div>
      <div className="drawer-body">
        {inspection?.error ? (
          <p className="api-error" role="alert">
            {inspection.error}
          </p>
        ) : (
          <>
            {decision ? (
              <>
                <section className="card">
                  <CardHeader title="Recorded decision">
                    <Badge action={decision.action} />
                  </CardHeader>
                  <div className="drawer-score">
                    <strong>
                      {decision.score}
                      <small> / 100</small>
                    </strong>
                    <span className="muted">Historical risk score</span>
                  </div>
                  <DetailList
                    items={[
                      ["Recorded at", dateTime(decision.occurred_at)],
                      [
                        "Enforcement",
                        decision.enforced ? "Enforced" : "Shadow mode",
                      ],
                      ["Review", humanize(decision.review_status)],
                      [
                        "Analyst label",
                        decision.label
                          ? humanize(decision.label)
                          : "Not labeled",
                      ],
                      ["Quarantine", decision.hold_status ?? "None"],
                    ]}
                  />
                  {!decision.enforced && (
                    <p className="aside-note">
                      This is a computed decision. The send API returned ALLOW.
                    </p>
                  )}
                </section>
                <section className="card">
                  <CardHeader
                    title="Signal evidence"
                    description="Points and evidence retained for this event."
                  />
                  {decision.hits.length ? (
                    <div className="hit-list">
                      {decision.hits.map((hit) => (
                        <div className="hit-row" key={hit.name}>
                          <span
                            className={`category-marker category-${hit.category}`}
                          />
                          <div className="hit-evidence">
                            <div className="hit-heading">
                              <strong>{humanize(hit.name)}</strong>
                              <span className="hit-category">
                                {hit.category}
                              </span>
                            </div>
                            <p>{hit.detail}</p>
                          </div>
                          <span className="hit-points">
                            +{hit.points}
                            <small>pts</small>
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState compact title="No scoring signals fired" />
                  )}
                </section>
              </>
            ) : (
              <EmptyState compact title="No recorded decision">
                The baseline is available below. Open the account to inspect its
                event history.
              </EmptyState>
            )}
            {profile && (
              <section className="card">
                <CardHeader title="Baseline & key state" />
                <DetailList
                  items={[
                    ["Learned events", number(profile.events_seen)],
                    ["Active hours", number(profile.active_hours)],
                    ["Hourly baseline", number(profile.hourly_ewma)],
                    [
                      "Sender domains",
                      profile.sender_domains.join(", ") || "—",
                    ],
                  ]}
                />
                <div className="drawer-keys">
                  {inspection?.profile?.key_status?.length ? (
                    inspection.profile.key_status.map((key) => (
                      <div key={key.api_key_id}>
                        <span className="mono">{key.api_key_id}</span>
                        <Badge
                          action={
                            key.status === "suspended" ? "block" : "allow"
                          }
                        >
                          {key.status}
                        </Badge>
                      </div>
                    ))
                  ) : (
                    <p className="muted">
                      Observed keys have no explicit suspension.
                    </p>
                  )}
                </div>
              </section>
            )}
            {detail && (
              <section className="card">
                <CardHeader title="Stored metadata" />
                <div className="drawer-metadata">
                  <MetadataBlock
                    title="Event"
                    value={{
                      event_id: detail.event.event_id,
                      type: detail.event.type,
                      occurred_at: detail.event.occurred_at,
                      api_key_id: detail.event.api_key_id,
                      source: detail.event.source,
                    }}
                  />
                  <MetadataBlock
                    title="Network"
                    value={{
                      ip: detail.event.ip,
                      asn: detail.event.asn,
                      asn_org: detail.event.asn_org,
                      user_agent: detail.event.user_agent,
                    }}
                  />
                  <MetadataBlock
                    title="Content"
                    value={{
                      sender_domain: detail.event.sender_domain,
                      recipient_count: detail.event.recipient_count,
                      link_domains: detail.event.link_domains,
                      reply_to_domains: detail.event.reply_to_domains,
                      body_email_domains: detail.event.body_email_domains,
                    }}
                  />
                </div>
              </section>
            )}
            {decision && (
              <section className="card" ref={reviewRef}>
                <CardHeader
                  title="Review this event"
                  description="Actions affect the identified key; the recorded score stays unchanged."
                />
                <ReviewForm
                  key={decision.decision_id}
                  decision={decision}
                  initialAction={initialAction}
                  onDirtyChange={onDirty}
                  onPendingChange={onPending}
                  onSuccess={onSuccess}
                />
              </section>
            )}
            {detail && (
              <section className="card">
                <CardHeader title="Audit history" />
                {detail.actions?.length ? (
                  <ol className="audit-history">
                    {detail.actions.map((action) => (
                      <li key={action.id}>
                        <div>
                          <strong>{humanize(action.action)}</strong>
                          <p>{action.reason}</p>
                          <small>
                            {action.actor} · {dateTime(action.created_at)}
                          </small>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <EmptyState compact title="No review actions yet." />
                )}
              </section>
            )}
          </>
        )}
        <div className="drawer-links">
          <Link
            className="button button-secondary"
            href={`/accounts/${encodeURIComponent(account)}`}
          >
            Open account investigation
          </Link>
          {decision && (
            <Link
              className="button button-secondary"
              href={`/decisions/${decision.decision_id}`}
            >
              Open full decision
            </Link>
          )}
        </div>
      </div>
      {toast && (
        <div className="dashboard-toast" role="status">
          <Check size={18} />
          <span>{toast}</span>
          <button
            type="button"
            className="text-button"
            aria-label="Dismiss notification"
            onClick={dismissToast}
          >
            Dismiss
          </button>
        </div>
      )}
    </dialog>
  );
}
