import Link from "next/link";
import { notFound } from "next/navigation";
import { Check, Fingerprint } from "lucide-react";
import { analystApi } from "@/lib/api";
import { dateTime, humanize, number, shortId } from "@/lib/format";
import type { DecisionDetail } from "@/lib/types";
import { UUID } from "@/lib/review";
import { ACTION_LABELS, riskClassName } from "@/lib/decisions";
import {
  ApiError,
  Badge,
  CardHeader,
  DetailList,
  EmptyState,
  PageHeader,
} from "@/components/ui";
import { RefreshButton } from "@/components/navigation";
import { ReviewForm } from "@/components/forms";

export const metadata = { title: "Decision review" };
export default async function DecisionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const result = await analystApi<DecisionDetail>(`/v1/decisions/${id}`);
  if (result.status === 404) notFound();
  if (result.error)
    return (
      <>
        <PageHeader eyebrow="DECISION REVIEW" title="Decision detail" />
        <ApiError message={result.error} />
      </>
    );
  const { decision: d, event, actions } = result.data!;
  return (
    <>
      <PageHeader
        back={{
          href: `/accounts/${encodeURIComponent(d.account_id)}`,
          label: d.account_id,
        }}
        eyebrow="DECISION REVIEW"
        title="Every signal. One clear decision."
        description={`${shortId(d.decision_id)} · ${dateTime(d.occurred_at)}`}
      >
        <RefreshButton />
        <Badge action={d.action} />
      </PageHeader>
      {!d.enforced && (
        <div className="mode-banner">
          <Fingerprint size={18} />
          <div>
            <strong>Shadow mode</strong>
            <span>
              This is a computed {ACTION_LABELS[d.action]} decision. The API
              returned ALLOW; this decision did not hold mail or suspend a key.
            </span>
          </div>
        </div>
      )}
      <div className="decision-grid">
        <div className="decision-main">
          <section className="card">
            <CardHeader
              title="Why this decision was made"
              description={
                d.reason === "key_suspended"
                  ? "The API key was already suspended."
                  : "Signal points are added and capped at 100."
              }
            />
            <div className="score-overview">
              <div className={`score-orbit orbit-${d.action}`}>
                <strong className={riskClassName(d.score)}>{d.score}</strong>
                <span>/ 100</span>
              </div>
              <div>
                <Badge action={d.action} />
                <h2>
                  {d.hits.length} signal{d.hits.length !== 1 ? "s" : ""}{" "}
                  contributed
                </h2>
                <p className="muted">
                  {d.reason
                    ? humanize(d.reason)
                    : `${new Set(d.hits.map((hit) => hit.category)).size} signal categories · ${d.enforced ? "Enforced" : "Observed in shadow mode"}`}
                </p>
              </div>
            </div>
            {d.hits.length ? (
              <div className="hit-list">
                {d.hits.map((hit) => (
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
                    <span className="hit-points">
                      +{hit.points}
                      <small>pts</small>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="aside-note">
                No scoring signals fired for this event.
              </p>
            )}
            <div className="score-total">
              <span>Final score</span>
              <strong>
                {d.score}
                <span> / 100</span>
              </strong>
            </div>
          </section>
          <section className="card">
            <CardHeader
              title="Event metadata"
              description="The evidence retained for this event. No email bodies or full recipient addresses."
            />
            <div className="metadata-columns">
              <DetailList
                items={[
                  [
                    "Event ID",
                    <span className="mono" key="event">
                      {d.event_id}
                    </span>,
                  ],
                  [
                    "Account",
                    <Link
                      href={`/accounts/${encodeURIComponent(d.account_id)}`}
                      key="account"
                      className="text-link"
                    >
                      {d.account_id}
                    </Link>,
                  ],
                  ["Event type", humanize(event.type)],
                  ["Source", event.source],
                  [
                    "API key",
                    <span className="mono" key="api-key">
                      {event.api_key_id ?? "—"}
                    </span>,
                  ],
                  ["Occurred at", dateTime(event.occurred_at)],
                ]}
              />
              <DetailList
                items={[
                  [
                    "Source IP",
                    <span className="mono" key="ip">
                      {event.ip ?? "—"}
                    </span>,
                  ],
                  [
                    "ASN",
                    event.asn ? `AS${event.asn} ${event.asn_org ?? ""}` : "—",
                  ],
                  ["Sender domain", event.sender_domain],
                  ["Recipients", number(event.recipient_count)],
                  ["Config version", d.config_version],
                  ["Scoring latency", `${number(d.latency_us / 1000)} ms`],
                ]}
              />
            </div>
            <div className="domain-details">
              {[
                ["Link domains", event.link_domains],
                ["Reply-To domains", event.reply_to_domains],
                ["Body email domains", event.body_email_domains],
              ].map(([title, domains]) => (
                <div key={String(title)}>
                  <span>{String(title)}</span>
                  <p>
                    {(domains as string[]).length
                      ? (domains as string[]).join(", ")
                      : "None"}
                  </p>
                </div>
              ))}
            </div>
          </section>
          <section className="card">
            <CardHeader
              title="Action history"
              description="Who made the call, when, and why."
            />
            {actions?.length ? (
              <ol className="audit-history">
                {actions.map((action) => (
                  <li key={action.id}>
                    <span className="audit-check">
                      <Check size={14} />
                    </span>
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
              <EmptyState compact title="No review actions yet.">
                The first review will start this audit trail.
              </EmptyState>
            )}
          </section>
        </div>
        <aside className="decision-aside">
          <section className="card">
            <CardHeader
              title="Make the next call"
              description="Every action needs a name and a reason."
            />
            <ReviewForm decision={d} />
          </section>
          <section className="card">
            <CardHeader title="Review status" />
            <DetailList
              items={[
                ["Status", humanize(d.review_status)],
                ["Label", d.label ? humanize(d.label) : "Not labeled"],
                ["Enforcement", d.enforced ? "Enforced" : "Shadow"],
                ["Hold", d.hold_status ?? "No hold"],
                ["Hold expires", dateTime(d.hold_expires_at)],
              ]}
            />
            {d.hold_status && (
              <Link
                className="button button-secondary owner-link"
                href={`/hold/${id}`}
              >
                Open owner view
              </Link>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}
