import Link from "next/link";
import {
  ArrowDownRight,
  ArrowRight,
  CircleCheck,
  Flag,
  Pause,
  ShieldBan,
} from "lucide-react";
import { analystApi } from "@/lib/api";
import { dateTime, humanize, number, periodQuery } from "@/lib/format";
import type { Action, Stats } from "@/lib/types";
import {
  ApiError,
  Badge,
  CardHeader,
  EmptyState,
  PageHeader,
  TextLink,
} from "@/components/ui";
import { RefreshButton } from "@/components/navigation";
import { PeriodFilter } from "@/components/period-filter";
import { DecisionChart } from "@/components/charts";

export default async function Overview({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period, query } = periodQuery((await searchParams).period);
  const result = await analystApi<Stats>(`/v1/stats?${query}`);
  const header = (
    <PageHeader
      eyebrow="ACCOUNT PROTECTION"
      title="A view of what matters."
      description="Unusual activity, useful context, and the decisions that need you."
    >
      <RefreshButton />
      <PeriodFilter period={period} />
    </PageHeader>
  );
  if (result.error)
    return (
      <>
        {header}
        <ApiError message={result.error} />
      </>
    );
  const stats = result.data!;
  const queue = stats.review_queue ?? [];
  const signals = stats.top_signals ?? [];
  const total = stats.totals.events;
  const cards: {
    action: Action;
    label: string;
    description: string;
    icon: React.ReactNode;
  }[] = [
    {
      action: "allow",
      label: "Allowed",
      description: "Within expected behavior",
      icon: <CircleCheck size={17} />,
    },
    {
      action: "flag",
      label: "Flagged",
      description: "Worth a closer look",
      icon: <Flag size={17} />,
    },
    {
      action: "hold",
      label: "Held",
      description: "Computed hold decisions",
      icon: <Pause size={17} />,
    },
    {
      action: "block",
      label: "Blocked",
      description: "Computed block decisions",
      icon: <ShieldBan size={17} />,
    },
  ];
  return (
    <>
      {header}
      <div className="overview-context">
        <span className="context-dot" />
        Decision overview
        <span className="context-divider" />
        <strong>{number(total)}</strong> events in this period
        <span className="context-right">
          Computed actions · Enforcement varies by decision
        </span>
      </div>
      <div className="stat-grid">
        {cards.map((card) => (
          <section
            key={card.action}
            className={`stat-card stat-${card.action}`}
          >
            <div className="stat-label">
              {card.label}
              <span>{card.icon}</span>
            </div>
            <strong className="stat-number">
              {number(stats.totals[card.action])}
            </strong>
            <div className="stat-bottom">
              <p>{card.description}</p>
              <span>
                {total
                  ? `${((stats.totals[card.action] / total) * 100).toFixed(1)}%`
                  : "—"}
              </span>
            </div>
          </section>
        ))}
      </div>
      <div className="overview-middle">
        <section className="card activity-card">
          <CardHeader
            title="Elevated activity"
            description="Flag, hold, and block decisions over time"
          >
            <div className="chart-legend">
              <span>
                <i className="flag-color" />
                Flag
              </span>
              <span>
                <i className="hold-color" />
                Hold
              </span>
              <span>
                <i className="block-color" />
                Block
              </span>
            </div>
          </CardHeader>
          <DecisionChart points={stats.series ?? []} />
        </section>
        <section className="card signals-card">
          <CardHeader
            title="Top signals"
            description="What’s driving the score"
          >
            <span className="subtle-icon">
              <ArrowDownRight size={18} />
            </span>
          </CardHeader>
          {signals.length ? (
            <div className="signal-list">
              {signals.map((signal, index) => (
                <div className="signal-row" key={signal.name}>
                  <div>
                    <span className="signal-rank">0{index + 1}</span>
                    <span>{humanize(signal.name)}</span>
                    <strong>{number(signal.count)}</strong>
                  </div>
                  <div className="signal-track">
                    <span
                      style={{
                        width: `${(signal.count / signals[0].count) * 100}%`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState compact title="Signals will appear here">
              No signal hits in this time range.
            </EmptyState>
          )}
        </section>
      </div>
      <section className="card queue-card">
        <CardHeader
          title="Needs a closer look"
          description="Accounts with decisions awaiting an analyst review."
        >
          <span className="count-pill">{queue.length} accounts</span>
          <TextLink href="/accounts?needs_review=true">View accounts</TextLink>
        </CardHeader>
        {queue.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Highest action</th>
                  <th>Open reviews</th>
                  <th>Last activity</th>
                  <th>
                    <span className="sr-only">Investigate</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {queue.map((item) => (
                  <tr key={item.account_id}>
                    <td>
                      <Link
                        className="account-cell"
                        href={`/accounts/${encodeURIComponent(item.account_id)}?period=${period}`}
                      >
                        <span className="account-monogram">
                          {item.account_id
                            .replace(/^acc_/, "")
                            .slice(0, 2)
                            .toUpperCase()}
                        </span>
                        <strong>{item.account_id}</strong>
                      </Link>
                    </td>
                    <td>
                      <Badge action={item.max_action} />
                    </td>
                    <td>
                      <span className="review-count">
                        {number(item.open_count)}
                      </span>
                    </td>
                    <td className="muted">{dateTime(item.last_at)}</td>
                    <td>
                      <Link
                        className="table-arrow"
                        aria-label={`Investigate ${item.account_id}`}
                        href={`/accounts/${encodeURIComponent(item.account_id)}?period=${period}`}
                      >
                        <ArrowRight size={17} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={
              total
                ? "Your review queue is clear."
                : "Ready for the first event."
            }
          >
            {total
              ? "There are no open reviews in this time range."
              : "As events arrive, decisions and accounts needing attention will appear here."}
          </EmptyState>
        )}
      </section>
      <div className="privacy-line">
        <CircleCheck size={14} />
        Built from event metadata. Email bodies, subjects, and recipient
        addresses are never shown.
      </div>
    </>
  );
}
