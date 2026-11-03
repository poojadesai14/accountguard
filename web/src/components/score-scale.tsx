import { ACTION_LABELS } from "@/lib/decisions";
import type { Action, Thresholds } from "@/lib/types";

// ScoreScale draws 0–100 with the engine's action lines, so an analyst can see
// how close a decision was to the next action.
export function ScoreScale({
  score,
  action,
  thresholds: t,
}: {
  score: number;
  action: Action;
  thresholds: Thresholds;
}) {
  const bands = [
    { action: "allow", from: 0, to: t.flag },
    { action: "flag", from: t.flag, to: t.hold },
    { action: "hold", from: t.hold, to: t.block },
    { action: "block", from: t.block, to: 100 },
  ] as const;
  const position = Math.min(100, Math.max(0, score));
  return (
    <figure
      className="score-scale"
      aria-label={`Score ${score} of 100. Flag from ${t.flag}, hold from ${t.hold}, block from ${t.block}.`}
    >
      <div className="score-scale-track">
        {bands.map((band) => (
          <span
            key={band.action}
            className={`score-scale-band band-${band.action}`}
            style={{ width: `${band.to - band.from}%` }}
          />
        ))}
        <span
          className={`score-scale-marker marker-${action}`}
          style={{ left: `${position}%` }}
        >
          <span>{score}</span>
        </span>
      </div>
      <div className="score-scale-labels" aria-hidden="true">
        {bands.map((band) => (
          <span
            key={band.action}
            style={{ left: `${band.from}%` }}
            className={band.from === 0 ? "first" : undefined}
          >
            {band.from > 0 && <b>{band.from}</b>} {ACTION_LABELS[band.action]}
          </span>
        ))}
      </div>
    </figure>
  );
}
