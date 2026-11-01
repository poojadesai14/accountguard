import { notFound } from "next/navigation";
import { analystApi } from "@/lib/api";
import { dateTime, humanize, number, periodQuery } from "@/lib/format";
import type { AccountSeries, ProfileResponse, TimelineRow } from "@/lib/types";
import { ApiError, CardHeader, DetailList, PageHeader } from "@/components/ui";
import { AccountCharts } from "@/components/charts";
import { PeriodFilter } from "@/components/period-filter";
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
    <PageHeader compact back={{ href: "/", label: "Queue" }} title={id}>
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
      {/* Key state is one line per key that has ever been suspended: red with an
          audited restore while suspended, muted once restored. Keys that never
          had a problem need no line. */}
      {keys.map((key) => (
        <div className="key-line" key={key.api_key_id}>
          <span
            className={key.status === "suspended" ? "suspended-state" : "muted"}
          >
            <span className="mono">{key.api_key_id}</span> {key.status}
          </span>
          <span className="muted">
            {humanize(key.reason)} · {dateTime(key.updated_at)}
          </span>
          {key.status === "suspended" && (
            <details>
              <summary>Restore access</summary>
              <UnblockForm keyId={key.api_key_id} />
            </details>
          )}
        </div>
      ))}
      <div className="investigation-grid">
        <section className="card">
          <CardHeader
            title="Activity"
            description="One time axis. The dashed line marks the first hold or block."
          />
          {series.error ? (
            <ApiError message={series.error} />
          ) : (
            <AccountCharts series={series.data!} />
          )}
        </section>
        <aside className="account-aside">
          <section className="card">
            <CardHeader title="Baseline" />
            <div className="baseline-number">
              {number(p.hourly_ewma)}
              <span>recipients / active hour</span>
            </div>
            <DetailList
              items={[
                ["Baseline events", number(p.events_seen)],
                ["Active hours", number(p.active_hours)],
                ["First seen", dateTime(p.first_seen_at)],
                ["Known domains", number(Object.keys(p.known_domains).length)],
                ["Sender domains", p.sender_domains.join(", ") || "—"],
                ...(p.used_freemail_reply_to
                  ? ([["Free-mail Reply-To", "Yes"]] as [string, string][])
                  : []),
                ["Last account change", dateTime(p.last_change_at)],
              ]}
            />
            <details className="method-note">
              <summary>How the baseline learns</summary>
              <p>
                Only allowed events, and activity an analyst or the owner
                confirmed as legitimate, teach the baseline. Held and blocked
                events never do.
              </p>
            </details>
          </section>
        </aside>
      </div>
      {timeline.error ? (
        <ApiError message={timeline.error} />
      ) : (
        <InvestigationWorkspace rows={rows} />
      )}
    </>
  );
}
