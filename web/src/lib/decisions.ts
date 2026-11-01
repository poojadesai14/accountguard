import type { Action, Hit, SeriesPoint, StatsPoint, Thresholds } from "./types";

export const ACTION_LABELS: Record<Action, string> = {
  allow: "ALLOW",
  flag: "FLAG",
  hold: "HOLD",
  block: "BLOCK",
};

// Scores are colored by the action the engine took, so the colors always match
// the configured thresholds instead of a second, display-only scale.
export function scoreClassName(action: Action | null | undefined) {
  return action ? `score-${action}` : "";
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

const RANK: Record<Action, number> = { allow: 0, flag: 1, hold: 2, block: 3 };

// explainDecision says, in the engine's own terms, why a decision got its action.
// It mirrors engine.Decide: the score sets a range, one non-exempt category is
// capped at flag, block needs agreeing categories, and no key means no block.
export function explainDecision(
  decision: {
    action: Action;
    score: number;
    hits: Hit[] | null;
    reason: string | null;
    api_key_id: string | null;
  },
  t: Thresholds | undefined,
): string {
  if (decision.reason === "key_suspended")
    return "Blocked because this API key was already suspended. The signals below were still scored for the record.";
  if (!t) return "";
  const { action, score } = decision;
  const categories = [...new Set((decision.hits ?? []).map((h) => h.category))];
  const range: Action =
    score >= t.block
      ? "block"
      : score >= t.hold
        ? "hold"
        : score >= t.flag
          ? "flag"
          : "allow";
  const exempt = t.single_category_exempt ?? [];
  if (
    categories.length === 1 &&
    !exempt.includes(categories[0]) &&
    RANK[action] < RANK[range]
  )
    return `Score ${score} is above the ${range} line, but only one signal category (${categories[0]}) fired. One category alone can at most flag; it takes independent signals agreeing to hold or block.`;
  if (range === "block" && action === "hold") {
    if (categories.length < t.block_min_categories)
      return `Score ${score} reaches the block line (${t.block}), but only ${categories.length} signal category agreed; blocking needs ${t.block_min_categories}. Held instead, so the owner can confirm.`;
    if (!decision.api_key_id)
      return `Score ${score} reaches the block line (${t.block}), but there is no API key to suspend. Held instead.`;
  }
  const ranges: Record<Action, string> = {
    allow: `below ${t.flag}`,
    flag: `${t.flag}–${t.hold - 1}`,
    hold: `${t.hold}–${t.block - 1}`,
    block: `${t.block}+ with at least ${t.block_min_categories} signal categories agreeing`,
  };
  return `Score ${score} is in the ${action} range (${ranges[action]}).`;
}

const HOUR = 3_600_000;
// Beyond ~4 months of hours, plot only the hours that had events.
const MAX_FILLED_HOURS = 24 * 120;

export type AccountHour = {
  time: number;
  recipients: number;
  content: number;
  changes: number;
  allow: number;
  flag: number;
  hold: number;
  block: number;
};

// accountHours turns the API's sparse hourly points into a continuous hourly
// series (quiet hours are zero, not interpolated) and finds the incident: the
// first hour with a hold or block, which the account charts mark on every lane.
export function accountHours(points: SeriesPoint[]): {
  hours: AccountHour[];
  incident?: number;
} {
  const byHour = new Map<number, SeriesPoint>();
  for (const point of points) {
    const time = Math.floor(Date.parse(point.t) / HOUR) * HOUR;
    if (Number.isFinite(time)) byHour.set(time, point);
  }
  const times = [...byHour.keys()].sort((a, b) => a - b);
  if (!times.length) return { hours: [] };
  const span = (times[times.length - 1] - times[0]) / HOUR + 1;
  const range =
    span <= MAX_FILLED_HOURS
      ? Array.from({ length: span }, (_, i) => times[0] + i * HOUR)
      : times;
  const hours = range.map((time) => {
    const point = byHour.get(time);
    return {
      time,
      recipients: point?.recipients ?? 0,
      content: point?.content_hits.length ?? 0,
      changes: point?.account_changes ?? 0,
      allow: point?.actions.allow ?? 0,
      flag: point?.actions.flag ?? 0,
      hold: point?.actions.hold ?? 0,
      block: point?.actions.block ?? 0,
    };
  });
  return { hours, incident: hours.find((h) => h.hold || h.block)?.time };
}
