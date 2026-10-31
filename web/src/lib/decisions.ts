import type { Action, StatsPoint } from "./types";

export const ACTION_LABELS: Record<Action, string> = {
  allow: "ALLOW",
  flag: "FLAG",
  hold: "QUARANTINE",
  block: "BLOCK",
};

// Display colors from the UI specification; these do not set engine thresholds.
export function riskClassName(score: number | null | undefined) {
  if (score == null) return "";
  return score >= 75 ? "risk-high" : score >= 40 ? "risk-medium" : "risk-low";
}

export type DecisionBucket = "1h" | "1d";

// The API omits buckets without elevated decisions. Fill those gaps so separate
// incidents are not drawn as continuous activity, keeping the selected UTC range.
export function decisionSeries(
  points: StatsPoint[],
  bucket: DecisionBucket,
  from?: string,
  to?: string,
) {
  if (!points.length) return [];
  const interval = bucket === "1d" ? 86_400_000 : 3_600_000;
  const counts = new Map<number, Omit<StatsPoint, "t">>();
  for (const point of points) {
    const time = Math.floor(Date.parse(point.t) / interval) * interval;
    if (!Number.isFinite(time)) continue;
    const previous = counts.get(time);
    counts.set(time, {
      flag: (previous?.flag ?? 0) + point.flag,
      hold: (previous?.hold ?? 0) + point.hold,
      block: (previous?.block ?? 0) + point.block,
    });
  }
  if (!counts.size) return [];
  const times = [...counts.keys()];
  const first = from
    ? Math.floor(Date.parse(from) / interval) * interval
    : Math.min(...times);
  const last = to
    ? (Math.ceil(Date.parse(to) / interval) - 1) * interval
    : Math.max(...times);
  const result = [];
  for (let time = first; time <= last; time += interval) {
    result.push({
      time,
      ...(counts.get(time) ?? { flag: 0, hold: 0, block: 0 }),
    });
  }
  return result;
}
