import Link from "next/link";
import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import { analystApi } from "@/lib/api";
import { dateTime, humanize, number } from "@/lib/format";
import type { DecisionDetail, ProfileResponse } from "@/lib/types";
import { UUID } from "@/lib/review";
import {
  ACTION_LABELS,
  explainDecision,
  heldEventLabel,
  scoreClassName,
} from "@/lib/decisions";
import {
  ApiError,
  Badge,
  CardHeader,
  DetailList,
  PageHeader,
} from "@/components/ui";
import { IncidentPanel } from "@/components/incident-panel";
import { HitList } from "@/components/hit-list";
import { RelatedPanel } from "@/components/related-panel";
import { ScoreScale } from "@/components/score-scale";

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
  const { decision: d, event, actions, thresholds, related } = result.data!;
  // What else is open on the account: the incident this decision belongs to.
  const profile = await analystApi<ProfileResponse>(
    `/v1/accounts/${encodeURIComponent(d.account_id)}/profile`,
  );
  const explanation = explainDecision(d, thresholds);
  const accountHref = `/accounts/${encodeURIComponent(d.account_id)}`;
  // One status line instead of a separate status card; each fact once.
  const status = [
    dateTime(d.occurred_at),
    d.review_status === "open" ? "Open review" : humanize(d.review_status),
    d.enforced ? "Enforced" : "Shadow, not enforced",
    d.hold_status === "pending"
      ? `Hold pending, expires ${dateTime(d.hold_expires_at)}`
      : d.hold_status && `Hold ${d.hold_status}`,
    d.label && `Labeled ${humanize(d.label)}`,
  ].filter(Boolean) as string[];
  const domains = (
    [
      ["Link domains", event.link_domains],
      ["Reply-To domains", event.reply_to_domains],
      ["Body email domains", event.body_email_domains],
    ] as [string, string[]][]
  ).filter(([, list]) => list.length);
  return (
    <>
      <header className="page-header decision-header">
        <div>
          <div className="decision-title">
            <h1>
              <Link href={accountHref} className="title-link">
                {d.account_id}
              </Link>
            </h1>
            <Badge action={d.action} />
            <strong className={`decision-score ${scoreClassName(d.action)}`}>
              {d.score}
              <small>/100</small>
            </strong>
          </div>
          <p className="decision-meta">
            {status.map((part) => (
              <span key={part}>{part}</span>
            ))}
            {d.hold_status && (
              <Link className="text-link" href={`/hold/${id}`}>
                Owner view
              </Link>
            )}
          </p>
        </div>
      </header>
      {!d.enforced && d.action !== "allow" && (
        <p className="mode-banner">
          Shadow mode: computed {ACTION_LABELS[d.action]}. The API returned
          ALLOW, so no mail was held and no key was suspended.
        </p>
      )}
      <div className="decision-grid">
        <section className="card decision-why">
          <CardHeader title="Why" />
          {thresholds && (
            <ScoreScale
              score={d.score}
              action={d.action}
              thresholds={thresholds}
            />
          )}
          {explanation && <p className="decision-explanation">{explanation}</p>}
          {d.hits.length ? (
            <HitList hits={d.hits} />
          ) : (
            <p className="aside-note">
              No scoring signals fired for this event.
            </p>
          )}
          <details className="method-note">
            <summary>How scoring works</summary>
            <p>
              Signal points add up, capped at 100. The action comes from where
              the score lands and how many signal categories agree: one category
              alone can at most flag (content alone can hold), and a block needs
              two.
            </p>
          </details>
        </section>
        <aside className="card decision-decide">
          <CardHeader title="Decide" />
          <IncidentPanel decision={d} open={profile.data?.open} />
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
            <p className="muted decision-no-history">No reviews yet.</p>
          )}
        </aside>
        {related && (
          <div className="decision-related">
            <RelatedPanel related={related} />
          </div>
        )}
        <details className="card decision-metadata">
          <summary>
            Event metadata
            <span className="muted">
              {[
                event.source,
                event.ip,
                event.asn && `AS${event.asn}`,
                event.type === "email.send" &&
                  `${number(event.recipient_count)} recipients`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </summary>
          <div className="metadata-columns">
            <DetailList
              items={[
                [
                  "Event ID",
                  <span className="mono" key="event">
                    {d.event_id}
                  </span>,
                ],
                ["Event type", humanize(event.type)],
                ...(event.type === "account.change"
                  ? ([
                      ["Change", heldEventLabel(event.type, event.change_kind)],
                      ["Change target", event.change_target_id ?? "—"],
                    ] as [string, string][])
                  : event.type === "api.read"
                    ? ([
                        ["Read resource", event.read_resource ?? "—"],
                        ["Read status", String(event.read_status ?? "—")],
                      ] as [string, string][])
                    : []),
                ["Source", event.source],
                [
                  "API key",
                  <span className="mono" key="api-key">
                    {event.api_key_id ?? "—"}
                  </span>,
                ],
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
                ["Sender domain", event.sender_domain ?? "—"],
                ["Config version", d.config_version],
                ["Scoring latency", `${number(d.latency_us / 1000)} ms`],
              ]}
            />
          </div>
          {domains.length > 0 && (
            <div className="domain-details">
              {domains.map(([title, list]) => (
                <div key={title}>
                  <span>{title}</span>
                  <p>{list.join(", ")}</p>
                </div>
              ))}
            </div>
          )}
        </details>
      </div>
    </>
  );
}
