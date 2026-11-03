import { plural } from "./format";
import type { OpenCounts } from "./types";

export type ResolveOutcome = "" | "legitimate" | "takeover";

// resolveEffects spells out, for the chosen outcome, everything resolving an
// account will and won't change, so nothing about it is a surprise.
export function resolveEffects(
  open: OpenCounts,
  outcome: ResolveOutcome,
  restore: boolean,
): { will: string[]; wont: string[] } {
  const will: string[] = [];
  const wont: string[] = [];
  const suspended = open.suspended_key_ids ?? [];
  const restorable = open.restorable_key_ids ?? [];
  const sentWith = open.review_key_ids ?? [];
  const keys = (ids: string[]) => ids.join(", ");
  if (outcome === "takeover") {
    will.push(`Label ${plural(open.reviews, "review")} takeover.`);
    if (open.pending_holds)
      will.push(
        `Drop ${plural(open.pending_holds, "held email")}: never sent.`,
      );
    if (sentWith.length)
      will.push(
        `Suspend ${keys(sentWith)} on your authority (already suspended stays suspended).`,
      );
    wont.push("Restore any key or release any email.");
    wont.push("Teach the baseline anything from these emails.");
  } else if (outcome === "legitimate") {
    will.push(
      `Label ${plural(open.reviews, "review")} legitimate and teach the baseline their networks and domains.`,
    );
    if (open.pending_holds)
      will.push(
        `Release ${plural(open.pending_holds, "held email")}: they will be sent.`,
      );
    if (restore && restorable.length)
      will.push(`Restore ${keys(restorable)}: it can send again.`);
    const staying = suspended.filter(
      (k) => !(restore && restorable.includes(k)),
    );
    if (staying.length)
      wont.push(
        `Restore ${keys(staying)}: ${staying.length === 1 ? "it stays" : "they stay"} suspended${
          restorable.length && !restore ? " (tick the box to restore)" : ""
        }.`,
      );
  }
  return { will, wont };
}
