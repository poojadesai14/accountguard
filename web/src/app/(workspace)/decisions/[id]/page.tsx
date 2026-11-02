import Link from "next/link";
import { notFound } from "next/navigation";
import { Check } from "lucide-react";
import { analystApi } from "@/lib/api";
import { dateTime, humanize, number } from "@/lib/format";
import type {
  DecisionDetail,
  ProfileResponse,
  RelatedIndicator,
  Thresholds,
} from "@/lib/types";
import { UUID } from "@/lib/review";
import {
  ACTION_LABELS,
  INDICATOR_LABELS,
  explainDecision,
  heldEventLabel,
  restoreIsLastStep,
  relatedSummary,
  relatedVerdict,
  scoreClassName,
} from "@/lib/decisions";
import {
  ApiError,
  Badge,
  CardHeader,
  DetailList,
  PageHeader,
} from "@/components/ui";
import { DecidePanel } from "@/components/forms";
import { RelatedAccounts } from "@/components/related-accounts";
import { KeyLine } from "@/components/key-line";

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
  const {
    decision: d,
    event,
    actions,
    thresholds,
    related,
    key,
  } = result.data!;
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
      {/* Any key that has been suspended keeps its line, so a restore made
          here stays visible with its confirmation. */}
      {key && (
        <KeyLine
          keyStatus={key}
          hint={
            restoreIsLastStep(d, key)
              ? "Marked legitimate; restore access to finish."
              : undefined
          }
        />
      )}
      {!d.enforced && (
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
          <DecidePanel decision={d} open={profile.data?.open} />
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

// ScoreScale draws 0–100 with the engine's action lines, so an analyst can see
// how close a decision was to the next action.
function ScoreScale({
  score,
  action,
  thresholds: t,
}: {
  score: number;
  action: DecisionDetail["decision"]["action"];
  thresholds: Thresholds;
}) {
  const bands = [
    { action: "allow", from: 0, to: t.flag },
    { action: "flag", from: t.flag, to: t.hold },
    { action: "hold", from: t.hold, to: t.block },
    { action: "block", from: t.block, to: 100 },
  ] as const;
  const position = Math.min(100, Math.max(0, score));
  return (
    <figure
      className="score-scale"
      aria-label={`Score ${score} of 100. Flag from ${t.flag}, hold from ${t.hold}, block from ${t.block}.`}
    >
      <div className="score-scale-track">
        {bands.map((band) => (
          <span
            key={band.action}
            className={`score-scale-band band-${band.action}`}
            style={{ width: `${band.to - band.from}%` }}
          />
        ))}
        <span
          className={`score-scale-marker marker-${action}`}
          style={{ left: `${position}%` }}
        >
          <span>{score}</span>
        </span>
      </div>
      <div className="score-scale-labels" aria-hidden="true">
        {bands.map((band) => (
          <span
            key={band.action}
            style={{ left: `${band.from}%` }}
            className={band.from === 0 ? "first" : undefined}
          >
            {band.from > 0 && <b>{band.from}</b>} {ACTION_LABELS[band.action]}
          </span>
        ))}
      </div>
    </figure>
  );
}

// RelatedPanel shows other accounts that used this event's link domains, Reply-To
// domains or IP. A match with a confirmed takeover turns a judgment call into a fact.
function RelatedPanel({ related }: { related: RelatedIndicator[] }) {
  const verdict = relatedVerdict(related);
  return (
    <section
      className="card"
      aria-label="Same infrastructure on other accounts"
    >
      <CardHeader title="Same infrastructure on other accounts" />
      <p className={`related-verdict related-${verdict.tone}`}>
        {verdict.text}
      </p>
      <details className="method-note related-method">
        <summary>What counts as shared</summary>
        <p>
          Link domains, non-freemail Reply-To domains and the source IP, within
          7 days either side. Cloud ASNs are left out: thousands of legitimate
          senders share them.
        </p>
      </details>
      {related.map((r) => (
        <div className="related-indicator" key={`${r.kind} ${r.value}`}>
          <div className="related-heading">
            <span>{INDICATOR_LABELS[r.kind]}</span>
            <strong className="mono">{r.value}</strong>
            <small>{relatedSummary(r)}</small>
          </div>
          <RelatedAccounts indicator={r} />
        </div>
      ))}
    </section>
  );
}
