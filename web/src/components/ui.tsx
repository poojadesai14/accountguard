import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Inbox, TriangleAlert } from "lucide-react";
import type { Action } from "@/lib/types";
import { humanize } from "@/lib/format";
import { ACTION_LABELS } from "@/lib/decisions";

export function Badge({
  action,
  children,
}: {
  action?: Action | string | null;
  children?: React.ReactNode;
}) {
  return (
    <span className={`badge badge-${action ?? "neutral"}`}>
      <span className="badge-dot" />
      {children ??
        (action && Object.hasOwn(ACTION_LABELS, action)
          ? ACTION_LABELS[action as Action]
          : humanize(action ?? "unscored"))}
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  children,
  back,
  compact = false,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children?: React.ReactNode;
  back?: { href: string; label: string };
  compact?: boolean;
}) {
  return (
    <header className={`page-header${compact ? " page-header-compact" : ""}`}>
      <div>
        {back && (
          <Link href={back.href} className="back-link">
            <ArrowLeft size={14} />
            {back.label}
          </Link>
        )}
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      <div className="header-actions">{children}</div>
    </header>
  );
}

export function EmptyState({
  title,
  children,
  compact = false,
}: {
  title: string;
  children?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? "compact" : ""}`}>
      <span className="empty-icon">
        <Inbox size={23} strokeWidth={1.4} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function ApiError({ message }: { message: string }) {
  return (
    <div className="api-error" role="alert">
      <TriangleAlert size={20} />
      <div>
        <h3>Request failed</h3>
        <p>{message}</p>
        <p className="muted">
          Your data has not been changed. Refresh to try again.
        </p>
      </div>
    </div>
  );
}

export function CardHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="card-header">
      <div>
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function TextLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link className="text-link" href={href}>
      {children}
      <ArrowUpRight size={14} />
    </Link>
  );
}

export function DetailList({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="detail-list">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
