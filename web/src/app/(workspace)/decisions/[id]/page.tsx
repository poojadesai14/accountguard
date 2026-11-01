import Link from "next/link";
import { notFound } from "next/navigation";
import { Check, Fingerprint } from "lucide-react";
import { analystApi } from "@/lib/api";
import { dateTime, humanize, number, shortId } from "@/lib/format";
import type { DecisionDetail, RelatedIndicator, Thresholds } from "@/lib/types";
import { UUID } from "@/lib/review";
import {
  ACTION_LABELS,
  INDICATOR_LABELS,
  explainDecision,
  heldEventLabel,
  relatedSummary,
  relatedVerdict,
  scoreClassName,
} from "@/lib/decisions";
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
  const { decision: d, event, actions, thresholds, related } = result.data!;
  const explanation = explainDecision(d, thresholds);
  return (
    <>
      <PageHeader
        back={{
          href: `/accounts/${encodeURIComponent(d.account_id)}`,
          label: d.account_id,
        }}
        eyebrow="DECISION REVIEW"
        title={`${ACTION_LABELS[d.action]} · ${d.account_id}`}
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
              description="Signal points are added and capped at 100. The action comes from where the score lands and how many signal categories agree."
            />
            {thresholds && (
              <ScoreScale
                score={d.score}
                action={d.action}
                thresholds={thresholds}
              />
            )}
            {explanation && (
              <p className="decision-explanation">{explanation}</p>
            )}
            <div className="score-overview">
              <div className={`score-orbit orbit-${d.action}`}>
                <strong className={scoreClassName(d.action)}>{d.score}</strong>
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
          </section>
          {related && <RelatedPanel related={related} />}
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
                  ...(event.type === "account.change"
                    ? ([
                        [
                          "Change",
                          heldEventLabel(event.type, event.change_kind),
                        ],
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
      <CardHeader
        title="Same infrastructure on other accounts"
        description="Link domains, non-freemail Reply-To domains and the source IP, within 7 days either side. Cloud ASNs are left out: thousands of legitimate senders share them."
      />
      <p className={`related-verdict related-${verdict.tone}`}>
        {verdict.text}
      </p>
      {related.map((r) => (
        <div className="related-indicator" key={`${r.kind} ${r.value}`}>
          <div className="related-heading">
            <span>{INDICATOR_LABELS[r.kind]}</span>
            <strong className="mono">{r.value}</strong>
            <small>{relatedSummary(r)}</small>
          </div>
          <ul className="related-accounts">
            {r.top.map((a) => (
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
                {a.confirmed && (
                  <Badge action="block">Confirmed takeover</Badge>
                )}
                <small>
                  {a.events} event{a.events === 1 ? "" : "s"} · last{" "}
                  {dateTime(a.last_at)}
                </small>
              </li>
            ))}
            {r.accounts > r.top.length && (
              <li className="muted">
                +{r.accounts - r.top.length} more account
                {r.accounts - r.top.length === 1 ? "" : "s"}
              </li>
            )}
          </ul>
        </div>
      ))}
    </section>
  );
}
