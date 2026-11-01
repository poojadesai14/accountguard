import { notFound } from "next/navigation";
import { analystApi } from "@/lib/api";
import { dateTime, humanize, number, periodQuery } from "@/lib/format";
import type { AccountSeries, ProfileResponse, TimelineRow } from "@/lib/types";
import { ApiError, CardHeader, DetailList, PageHeader } from "@/components/ui";
import { AccountCharts } from "@/components/charts";
import { PeriodFilter } from "@/components/period-filter";
import { KeyLine } from "@/components/key-line";
import { CorrectionCard, ResolveCard } from "@/components/forms";
import type { KeyStatus } from "@/lib/types";
import { InvestigationWorkspace } from "@/components/investigation-workspace";

export const metadata = { title: "Account investigation" };
export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    period?: string;
    restore?: string;
    resolve?: string;
  }>;
}) {
  const { id } = await params;
  const search = await searchParams;
  const { period, query } = periodQuery(search.period);
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
  const statuses = profile.data!.key_status ?? [];
  // Every key the account has sent with: its status row if it has one, otherwise
  // active (never suspended). Suspending is available on each.
  const keys: KeyStatus[] = [
    ...statuses,
    ...Object.keys(p.key_asns ?? {})
      .filter((k) => !statuses.some((s) => s.api_key_id === k))
      .sort()
      .map((k) => ({
        api_key_id: k,
        account_id: id,
        status: "active" as const,
        reason: "",
        decision_id: null,
        updated_at: "",
      })),
  ];
  const open = profile.data!.open;
  const rows = [...(timeline.data ?? [])].reverse();
  return (
    <>
      {header}
      {/* One line per key: red with an audited restore while suspended, muted
          with an audited suspension while active. */}
      {keys.map((key) => (
        <KeyLine
          key={key.api_key_id}
          keyStatus={key}
          initiallyOpen={search.restore === key.api_key_id}
        />
      ))}
      {open && (
        <ResolveCard
          accountId={id}
          open={open}
          initiallyOpen={search.resolve === "1"}
          summary={[
            open.reviews &&
              `${open.reviews} open review${open.reviews === 1 ? "" : "s"}`,
            open.pending_holds &&
              `${open.pending_holds} held email${open.pending_holds === 1 ? "" : "s"}`,
            open.suspended_keys &&
              `${open.suspended_keys} suspended key${open.suspended_keys === 1 ? "" : "s"}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        />
      )}
      <CorrectionCard
        accountId={id}
        decisions={profile.data!.legitimate_decisions ?? []}
      />
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
