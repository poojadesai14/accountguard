import { notFound } from "next/navigation";
import { analystApi } from "@/lib/api";
import {
  dateTime,
  number,
  periodQuery,
  plural,
  TIMELINE_LIMIT,
} from "@/lib/format";
import type {
  AccountSeries,
  KeyStatus,
  ProfileResponse,
  TimelineRow,
} from "@/lib/types";
import { ApiError, CardHeader, DetailList, PageHeader } from "@/components/ui";
import { AccountCharts } from "@/components/account-charts";
import { PeriodFilter } from "@/components/period-filter";
import { KeyLine } from "@/components/key-line";
import { CorrectionCard } from "@/components/forms/correction";
import { ResolveCard } from "@/components/forms/resolve";
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
      `${accountPath}/timeline?${query}&limit=${TIMELINE_LIMIT}`,
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
  const created = new Map(
    (profile.data!.created_keys ?? []).map((k) => [k.api_key_id, k.created_at]),
  );
  // Every key the account has: its status row if it has one, otherwise active
  // (never suspended), including keys created but not yet trusted, which an
  // attacker may have made to keep access. Suspending is available on each.
  const keys: KeyStatus[] = [
    ...statuses,
    ...[...new Set([...Object.keys(p.key_asns ?? {}), ...created.keys()])]
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
          // A Restore link to this page remounts its key line, opened.
          key={`${key.api_key_id}${search.restore === key.api_key_id ? ":restore" : ""}`}
          keyStatus={key}
          createdAt={created.get(key.api_key_id)}
          // No allowed send yet: nothing has vouched for this key.
          untrusted={!p.key_asns?.[key.api_key_id]}
          initiallyOpen={search.restore === key.api_key_id}
        />
      ))}
      {open && (
        <ResolveCard
          accountId={id}
          open={open}
          // The incident is the unit of work: open while anything is.
          initiallyOpen={search.resolve === "1" || open.reviews > 0}
          summary={[
            open.reviews && plural(open.reviews, "open review"),
            open.pending_holds && plural(open.pending_holds, "held email"),
            open.suspended_keys && plural(open.suspended_keys, "suspended key"),
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
