import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowUpRight, Network, ShieldCheck } from "lucide-react";
import { analystApi } from "@/lib/api";
import { dateTime, humanize, number, periodQuery } from "@/lib/format";
import { riskClassName } from "@/lib/decisions";
import type { AccountSeries, ProfileResponse, TimelineRow } from "@/lib/types";
import {
  ApiError,
  Badge,
  CardHeader,
  DetailList,
  EmptyState,
  PageHeader,
} from "@/components/ui";
import { AccountCharts } from "@/components/charts";
import { PeriodFilter } from "@/components/period-filter";
import { RefreshButton } from "@/components/navigation";
import { UnblockForm } from "@/components/forms";
import { InvestigationWorkspace } from "@/components/investigation-workspace";

export const metadata = { title: "Account investigation" };
export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ period?: string }>;
}) {
  const { id } = await params;
  const { period, query } = periodQuery((await searchParams).period);
  const accountPath = `/v1/accounts/${encodeURIComponent(id)}`;
  const [profile, series, timeline] = await Promise.all([
    analystApi<ProfileResponse>(`${accountPath}/profile`),
    analystApi<AccountSeries>(`${accountPath}/series?${query}`),
    analystApi<TimelineRow[] | null>(
      `${accountPath}/timeline?${query}&limit=1000`,
    ),
  ]);
  if (profile.status === 404) notFound();
  const header = (
    <PageHeader
      compact
      back={{ href: "/accounts", label: "All accounts" }}
      eyebrow="ACCOUNT INVESTIGATION"
      title={id}
      description="Inspect each event, understand its signals, and review the evidence."
    >
      <RefreshButton />
      <PeriodFilter period={period} />
    </PageHeader>
  );
  if (profile.error)
    return (
      <>
        {header}
        <ApiError message={profile.error} />
      </>
    );
  const p = profile.data!.profile;
  const keys = profile.data!.key_status ?? [];
  const rows = [...(timeline.data ?? [])].reverse();
  return (
    <>
      {header}
      {timeline.error ? (
        <ApiError message={timeline.error} />
      ) : (
        <InvestigationWorkspace rows={rows} />
      )}
      <div className="account-summary">
        <span>
          <ShieldCheck size={15} />
          {number(p.events_seen)} baseline events
        </span>
        <span>
          <Network size={15} />
          {Object.keys(p.key_asns).length} observed keys
        </span>
        <span>First seen {dateTime(p.first_seen_at)}</span>
      </div>
      <div className="investigation-grid">
        <section className="card">
          <CardHeader
            title="Activity, in context"
            description="Volume, networks, content, and account changes."
          />
          {series.error ? (
            <ApiError message={series.error} />
          ) : (
            <AccountCharts series={series.data!} />
          )}
        </section>
        <aside className="account-aside">
          <section className="card">
            <CardHeader title="Learned baseline" />
            <div className="baseline-number">
              {number(p.hourly_ewma)}
              <span>recipients / active hour</span>
            </div>
            <DetailList
              items={[
                ["Active hours", number(p.active_hours)],
                ["Known domains", number(Object.keys(p.known_domains).length)],
                ["Sender domains", p.sender_domains.join(", ") || "—"],
                [
                  "Free-mail Reply-To used",
                  p.used_freemail_reply_to ? "Yes" : "No",
                ],
                ["Last account change", dateTime(p.last_change_at)],
              ]}
            />
            <p className="aside-note">
              The baseline learns from allowed events and activity confirmed as
              legitimate.
            </p>
          </section>
          <section className="card">
            <CardHeader title="API key status" />
            {keys.length ? (
              <div className="key-list">
                {keys.map((key) => (
                  <div className="key-item" key={key.api_key_id}>
                    <strong className="mono">{key.api_key_id}</strong>
                    <Badge
                      action={key.status === "suspended" ? "block" : "allow"}
                    >
                      {key.status}
                    </Badge>
                    <p className="muted">
                      {humanize(key.reason)} · {dateTime(key.updated_at)}
                    </p>
                    {key.status === "suspended" && (
                      <details>
                        <summary>Restore access</summary>
                        <UnblockForm keyId={key.api_key_id} />
                      </details>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="aside-note">
                No explicit key status overrides. Observed keys are active by
                default.
              </p>
            )}
          </section>
        </aside>
      </div>
      <section className="card timeline-card">
        <CardHeader
          title="Event timeline"
          description="Most recent 1,000 events in the selected period. Newest first."
        >
          <span className="count-pill">{number(rows.length)} events</span>
        </CardHeader>
        {timeline.error ? (
          <ApiError message={timeline.error} />
        ) : rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Network</th>
                  <th>Signals</th>
                  <th>Score</th>
                  <th>Decision</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.event_id}>
                    <td className="timeline-time">
                      {dateTime(row.occurred_at)}
                    </td>
                    <td>
                      <strong>{humanize(row.type)}</strong>
                      <small>
                        {row.type === "email.send"
                          ? `${number(row.recipient_count)} recipients · ${row.sender_domain ?? "unknown sender"}`
                          : (row.change_kind ??
                            row.read_resource ??
                            row.source)}
                      </small>
                    </td>
                    <td>
                      <span className="mono">
                        {row.asn ? `AS${row.asn}` : "—"}
                      </span>
                      <small className={row.asn_org ? undefined : "mono"}>
                        {row.asn_org ?? row.ip}
                      </small>
                    </td>
                    <td>
                      <div className="signal-tags">
                        {row.hits?.length ? (
                          row.hits.map((hit) => (
                            <span key={hit.name} title={hit.detail}>
                              {humanize(hit.name)}
                            </span>
                          ))
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span
                        className={`score-number ${riskClassName(row.score)}`}
                      >
                        {row.score ?? "—"}
                      </span>
                    </td>
                    <td>
                      <Badge action={row.action} />
                      {row.enforced === false && <small>Shadow mode</small>}
                      {row.hold_status && (
                        <small>{humanize(row.hold_status)}</small>
                      )}
                    </td>
                    <td>
                      {row.decision_id && (
                        <Link
                          className="table-arrow"
                          aria-label={`Open decision for ${row.event_id}`}
                          href={`/decisions/${row.decision_id}`}
                        >
                          <ArrowUpRight size={17} />
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No events in this time range.">
            Choose a wider period to see earlier activity.
          </EmptyState>
        )}
      </section>
    </>
  );
}
