import { notFound } from "next/navigation";
import { Pause } from "lucide-react";
import { analystApi } from "@/lib/api";
import { dateTime, number } from "@/lib/format";
import type { DecisionDetail } from "@/lib/types";
import { UUID } from "@/lib/review";
import { ApiError, DetailList, PageHeader } from "@/components/ui";
import { OwnerForm } from "@/components/forms";

export const metadata = { title: "Held activity" };
export default async function HoldPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const result = await analystApi<DecisionDetail>(`/v1/decisions/${id}`);
  if (result.status === 404) notFound();
  if (result.error) return <ApiError message={result.error} />;
  const { decision, event } = result.data!;
  if (!decision.hold_status) notFound();
  return (
    <>
      <PageHeader
        back={{ href: `/decisions/${id}`, label: "Decision detail" }}
        eyebrow="OWNER HOLD VIEW"
        title="Does this activity look familiar?"
        description="A quick confirmation helps protect the account."
      />
      <section className="card owner-card">
        <span className="hold-symbol">
          <Pause size={25} />
        </span>
        <h2>We paused a message for review.</h2>
        <p>
          Check the event details and let us know whether you recognize this
          activity.
        </p>
        <DetailList
          items={[
            ["Account", decision.account_id],
            ["Sender domain", event.sender_domain],
            // The domains are what an owner can actually recognize or reject.
            ["Links to", event.link_domains.join(", ") || "No links"],
            [
              "Replies go to",
              event.reply_to_domains.join(", ") || "Your sender domain",
            ],
            ["Recipients", number(event.recipient_count)],
            ["Time", dateTime(event.occurred_at)],
            [
              "Network",
              event.asn ? (
                `AS${event.asn} ${event.asn_org ?? ""}`
              ) : (
                <span className="mono" key="ip">
                  {event.ip ?? "—"}
                </span>
              ),
            ],
            ["Hold status", decision.hold_status ?? "No hold"],
          ]}
        />
        <OwnerForm decision={decision} />
        <p className="demo-notice">
          Demo owner view · Analyst sign-in is required. Public owner links are
          not enabled.
        </p>
      </section>
    </>
  );
}
