import { notFound } from "next/navigation";
import { Pause } from "lucide-react";
import { analystApi } from "@/lib/api";
import { dateTime, number } from "@/lib/format";
import type { DecisionDetail } from "@/lib/types";
import { UUID } from "@/lib/review";
import { heldEventLabel } from "@/lib/decisions";
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
  const network: [string, React.ReactNode] = [
    "Network",
    event.asn ? (
      `AS${event.asn} ${event.asn_org ?? ""}`
    ) : (
      <span className="mono" key="ip">
        {event.ip ?? "—"}
      </span>
    ),
  ];
  // A hold can pause an account change or a data read, not only an email, so the
  // owner sees the fields of what was actually paused.
  const what = heldEventLabel(event.type, event.change_kind);
  const details: [string, React.ReactNode][] =
    event.type === "account.change"
      ? [
          ["Account", decision.account_id],
          ["Change", what],
          ["Target", event.change_target_id ?? "—"],
          ["Time", dateTime(event.occurred_at)],
          network,
        ]
      : event.type === "api.read"
        ? [
            ["Account", decision.account_id],
            ["Read", event.read_resource ?? "—"],
            ["Time", dateTime(event.occurred_at)],
            network,
          ]
        : [
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
            network,
          ];
  return (
    <>
      <PageHeader
        back={{ href: `/decisions/${id}`, label: "Back to decision" }}
        title="Does this activity look familiar?"
      />
      <section className="card owner-card">
        <span className="hold-symbol">
          <Pause size={25} />
        </span>
        <h2>
          {event.type === "account.change"
            ? `We paused an account change for review: ${what}.`
            : event.type === "api.read"
              ? "We paused a data read for review."
              : "We paused a message for review."}
        </h2>
        <DetailList
          items={[
            ...details,
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
