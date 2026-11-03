import assert from "node:assert/strict";
import test from "node:test";
import { resolveEffects } from "../src/lib/resolve";
import type { OpenCounts } from "../src/lib/types";

const open: OpenCounts = {
  reviews: 2,
  pending_holds: 1,
  suspended_keys: 2,
  restorable_keys: 1,
  decision_ids: [],
  suspended_key_ids: ["key_a", "key_b"],
  restorable_key_ids: ["key_a"],
  review_key_ids: ["key_a", "key_c"],
};

test("no outcome chosen yet says nothing", () => {
  assert.deepEqual(resolveEffects(open, "", false), { will: [], wont: [] });
});

test("takeover drops holds and suspends the keys the reviews were sent with", () => {
  assert.deepEqual(resolveEffects(open, "takeover", false), {
    will: [
      "Label 2 reviews takeover.",
      "Drop 1 held email: never sent.",
      "Suspend key_a, key_c on your authority (already suspended stays suspended).",
    ],
    wont: [
      "Restore any key or release any email.",
      "Teach the baseline anything from these emails.",
    ],
  });
});

test("takeover never restores, even with the restore box ticked", () => {
  assert.deepEqual(
    resolveEffects(open, "takeover", true),
    resolveEffects(open, "takeover", false),
  );
});

test("legitimate releases holds and keeps keys suspended unless asked", () => {
  assert.deepEqual(resolveEffects(open, "legitimate", false), {
    will: [
      "Label 2 reviews legitimate and teach the baseline their networks and domains.",
      "Release 1 held email: they will be sent.",
    ],
    wont: [
      "Restore key_a, key_b: they stay suspended (tick the box to restore).",
    ],
  });
});

test("legitimate with restore brings back only the restorable keys", () => {
  assert.deepEqual(resolveEffects(open, "legitimate", true), {
    will: [
      "Label 2 reviews legitimate and teach the baseline their networks and domains.",
      "Release 1 held email: they will be sent.",
      "Restore key_a: it can send again.",
    ],
    wont: ["Restore key_b: it stays suspended."],
  });
});

test("nothing held or suspended leaves only the label", () => {
  const quiet: OpenCounts = {
    reviews: 1,
    pending_holds: 0,
    suspended_keys: 0,
    restorable_keys: 0,
    decision_ids: [],
  };
  assert.deepEqual(resolveEffects(quiet, "legitimate", false), {
    will: [
      "Label 1 review legitimate and teach the baseline their networks and domains.",
    ],
    wont: [],
  });
  assert.deepEqual(resolveEffects(quiet, "takeover", false).will, [
    "Label 1 review takeover.",
  ]);
});
