import Form from "next/form";
import Link from "next/link";
import { ArrowRight, Search } from "lucide-react";
import { analystApi } from "@/lib/api";
import { dateTime, number } from "@/lib/format";
import type { AccountSummary } from "@/lib/types";
import {
  ApiError,
  Badge,
  CardHeader,
  EmptyState,
  PageHeader,
} from "@/components/ui";
import { RefreshButton } from "@/components/navigation";

export const metadata = { title: "Accounts" };
export default async function Accounts({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const params = await searchParams;
  const q = (params.q ?? "").slice(0, 200);
  // A lookup page: triage, and the one definition of "needs review", live on
  // the dashboard queue.
  const query = new URLSearchParams({ q });
  const result = await analystApi<AccountSummary[] | null>(
    `/v1/accounts?${query}`,
  );
  return (
    <>
      <PageHeader
        eyebrow="INVESTIGATIONS"
        title="Accounts"
        description="Find an account and trace its activity from baseline to decision."
      >
        <RefreshButton />
      </PageHeader>
      <section className="card">
        <CardHeader
          title="Accounts"
          description="Up to 200 accounts, with open reviews shown first."
        />
        {/* next/form: client-side navigation on submit, a plain GET form without JS. */}
        <Form className="account-search" action="/accounts">
          <div className="search-field">
            <Search size={17} />
            <input
              type="search"
              name="q"
              aria-label="Search accounts"
              placeholder="Search by account ID…"
              defaultValue={q}
            />
          </div>
          <button className="button button-primary">Search</button>
          {q && (
            <Link className="text-link" href="/accounts">
              Clear
            </Link>
          )}
        </Form>
        {result.error ? (
          <ApiError message={result.error} />
        ) : result.data?.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Decisions</th>
                  <th>Open reviews</th>
                  <th>Latest action</th>
                  <th>Last active</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {result.data.map((account) => (
                  <tr key={account.account_id}>
                    <td>
                      <Link
                        className="account-cell"
                        href={`/accounts/${encodeURIComponent(account.account_id)}`}
                      >
                        <span className="account-monogram">
                          {account.account_id
                            .replace(/^acc_/, "")
                            .slice(0, 2)
                            .toUpperCase()}
                        </span>
                        <div>
                          <strong>{account.account_id}</strong>
                          <small>
                            First seen {dateTime(account.first_seen_at)}
                          </small>
                        </div>
                      </Link>
                    </td>
                    <td>{number(account.decisions)}</td>
                    <td>
                      {account.open_reviews ? (
                        <span className="review-count">
                          {number(account.open_reviews)}
                        </span>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                    <td>
                      <Badge action={account.last_action} />
                    </td>
                    <td className="muted">{dateTime(account.last_at)}</td>
                    <td>
                      <Link
                        className="table-arrow"
                        href={`/accounts/${encodeURIComponent(account.account_id)}`}
                        aria-label={`Open ${account.account_id}`}
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
            title={q ? "No accounts match this search." : "No accounts yet."}
          >
            {q
              ? "Try another account ID."
              : "Accounts appear automatically after their first event is processed."}
          </EmptyState>
        )}
      </section>
    </>
  );
}
