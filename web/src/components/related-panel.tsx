import {
  INDICATOR_LABELS,
  relatedSummary,
  relatedVerdict,
} from "@/lib/decisions";
import type { RelatedIndicator } from "@/lib/types";
import { RelatedAccounts } from "./related-accounts";
import { CardHeader } from "./ui";

// RelatedPanel shows other accounts that used this event's link domains, Reply-To
// domains or IP. A match with a confirmed takeover turns a judgment call into a fact.
export function RelatedPanel({ related }: { related: RelatedIndicator[] }) {
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
