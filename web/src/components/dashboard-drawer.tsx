"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef } from "react";
import { ArrowRight, Check, X } from "lucide-react";
import { Badge, EmptyState } from "./ui";
import { ReviewForm } from "./forms";
import { dateTime, humanize } from "@/lib/format";
import { scoreClassName } from "@/lib/decisions";
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
  const selectedKey = inspection?.profile?.key_status?.find(
    (key) => key.api_key_id === decision?.api_key_id,
  );
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
          <h2 id="inspection-title">{account}</h2>
        </div>
        <div className="drawer-header-actions">
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
      {/* A light triage view: the call, its top evidence and the review form.
          Baseline, raw metadata and history live on the account and decision
          pages, so there is one detailed view to keep correct. */}
      <div className="drawer-body">
        {inspection?.error ? (
          <p className="api-error" role="alert">
            {inspection.error}
          </p>
        ) : decision ? (
          <>
            <div className="drawer-summary">
              <Badge action={decision.action} />
              <div className="drawer-score">
                <strong className={scoreClassName(decision.action)}>
                  {decision.score}
                  <small> / 100</small>
                </strong>
              </div>
              <p className="drawer-meta">
                {[
                  decision.enforced ? "Enforced" : "Shadow, not enforced",
                  dateTime(decision.occurred_at),
                  decision.label && `Reviewed: ${humanize(decision.label)}`,
                ]
                  .filter(Boolean)
                  .map((part) => (
                    <span key={String(part)}>{part}</span>
                  ))}
              </p>
            </div>
            {(selectedKey?.status === "suspended" ||
              decision.hold_status === "pending") && (
              <p className="drawer-state">
                {selectedKey?.status === "suspended" && (
                  <span className="suspended-state">
                    <span className="mono">{selectedKey.api_key_id}</span>{" "}
                    suspended
                  </span>
                )}
                {decision.hold_status === "pending" && (
                  <span className="held-state">
                    Hold pending
                    {decision.hold_expires_at
                      ? ` · expires ${dateTime(decision.hold_expires_at)}`
                      : ""}
                  </span>
                )}
              </p>
            )}
            {decision.hits.length ? (
              <div className="hit-list">
                {decision.hits.slice(0, 3).map((hit) => (
                  <div className="hit-row" key={hit.name}>
                    <span
                      className={`category-marker category-${hit.category}`}
                    />
                    <div className="hit-evidence">
                      <div className="hit-heading">
                        <strong>{humanize(hit.name)}</strong>
                        <span className="hit-category">{hit.category}</span>
                      </div>
                      <p>{hit.detail}</p>
                    </div>
                    <span className="hit-points">+{hit.points}</span>
                  </div>
                ))}
                {decision.hits.length > 3 && (
                  <Link
                    className="text-link drawer-more"
                    href={`/decisions/${decision.decision_id}`}
                  >
                    +{decision.hits.length - 3} more signals
                  </Link>
                )}
              </div>
            ) : (
              <p className="muted">No scoring signals fired.</p>
            )}
            <section className="drawer-review" ref={reviewRef}>
              <h3>Decide</h3>
              <ReviewForm
                key={decision.decision_id}
                decision={decision}
                initialAction={initialAction}
                onDirtyChange={onDirty}
                onPendingChange={onPending}
                onSuccess={onSuccess}
              />
            </section>
          </>
        ) : (
          <EmptyState compact title="No recorded decision">
            Open the account to see its baseline and event history.
          </EmptyState>
        )}
        <div className="drawer-links">
          {decision && (
            <Link
              className="text-link"
              href={`/decisions/${decision.decision_id}`}
            >
              Open full decision <ArrowRight size={14} aria-hidden="true" />
            </Link>
          )}
          <Link
            className="text-link"
            href={`/accounts/${encodeURIComponent(account)}`}
          >
            Open account <ArrowRight size={14} aria-hidden="true" />
          </Link>
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
