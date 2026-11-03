import { humanize } from "@/lib/format";
import type { Hit } from "@/lib/types";

// HitList is a decision's signal evidence: what fired, why, and its points.
export function HitList({ hits, label }: { hits: Hit[]; label?: string }) {
  return (
    <ul className="hit-list" aria-label={label}>
      {hits.map((hit) => (
        <li className="hit-row" key={hit.name}>
          <span className={`category-marker category-${hit.category}`} />
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
        </li>
      ))}
    </ul>
  );
}
