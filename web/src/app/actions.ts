"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { analystApi } from "@/lib/api";
import { requireSession } from "@/lib/auth";
import {
  createSession,
  passwordsMatch,
  safeReturnPath,
  SESSION_COOKIE,
  SESSION_SECONDS,
} from "@/lib/session";
import {
  reviewFields,
  UUID,
  type FormState,
  type NextStep,
} from "@/lib/review";
import type {
  AccountResolution,
  Correction,
  DecisionDetail,
  ProfileResponse,
} from "@/lib/types";
import { restoreIsLastStep } from "@/lib/decisions";

export async function login(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  const password = process.env.UI_PASSWORD;
  if (!password)
    return { error: "Dashboard access has not been configured yet." };
  if (!passwordsMatch(String(form.get("password") ?? ""), password)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return { error: "That password doesn't match. Please try again." };
  }
  (await cookies()).set(SESSION_COOKIE, createSession(password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
  redirect(safeReturnPath(form.get("next")));
}

export async function logout() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

function refreshDecision(id: string) {
  revalidatePath("/", "layout");
  revalidatePath(`/decisions/${id}`);
  revalidatePath(`/hold/${id}`);
}

export async function reviewDecision(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  await requireSession();
  const id = String(form.get("decision_id") ?? "");
  const action = String(form.get("action") ?? "");
  if (
    !UUID.test(id) ||
    !["confirm_takeover", "mark_legitimate", "release_hold"].includes(action)
  )
    return { error: "Choose a valid review action." };
  const fields = reviewFields(form);
  if (fields.error) return { error: fields.error };
  const result = await analystApi(`/v1/decisions/${id}/actions`, {
    action,
    ...confirmField(form),
    actor: fields.actor,
    reason: fields.reason,
  });
  if (result.error) return { error: result.error };
  refreshDecision(id);
  // One decision's verdict never closes the account's other reviews, and marking
  // legitimate never restores a key: say what's left and link straight to it.
  if (action === "mark_legitimate" || action === "confirm_takeover")
    return afterReview(id, action);
  return {
    success: "Action recorded. The decision and audit history are up to date.",
  };
}

async function afterReview(
  id: string,
  action: "mark_legitimate" | "confirm_takeover",
): Promise<FormState> {
  const detail = await analystApi<DecisionDetail>(`/v1/decisions/${id}`);
  const account = detail.data?.decision.account_id;
  if (!detail.data || !account) return { success: "Action recorded." };
  const page = `/accounts/${encodeURIComponent(account)}`;
  const profile = await analystApi<ProfileResponse>(
    `/v1/accounts/${encodeURIComponent(account)}/profile`,
  );
  const reviews = profile.data?.open?.reviews ?? 0;
  const suspended = (profile.data?.key_status ?? [])
    .filter((k) => k.status === "suspended")
    .map((k) => k.api_key_id);
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  const next: NextStep[] = [];
  const parts: string[] = [];
  let lead: string;
  if (action === "confirm_takeover") {
    const key = detail.data.decision.api_key_id;
    lead = `Takeover confirmed${key ? `: key ${key} suspended and its held emails dropped` : ""}.`;
  } else {
    const key = detail.data.key;
    const restore = restoreIsLastStep(detail.data.decision, key)
      ? key!.api_key_id
      : null;
    lead = restore
      ? `Marked legitimate. Key ${restore} is still suspended: restore access to finish.`
      : "Marked legitimate.";
    if (restore)
      next.push({
        label: `Restore ${restore}`,
        href: `${page}?restore=${encodeURIComponent(restore)}`,
      });
    const others = suspended.filter((k) => k !== restore);
    if (others.length) {
      parts.push(
        `${others.join(", ")} ${others.length === 1 ? "stays" : "stay"} suspended until restored on purpose.`,
      );
      next.push({ label: "Open account", href: page });
    }
    if (!restore && !others.length && reviews === 0)
      return {
        success: `${lead} Nothing else is open on this account, so it moves to Healthy.`,
      };
  }
  if (reviews > 0) {
    parts.unshift(
      `${plural(reviews, "other review")} ${reviews === 1 ? "is" : "are"} still open on this account.`,
    );
    next.unshift({ label: "Resolve the rest", href: `${page}?resolve=1` });
  }
  return { success: [lead, ...parts].join(" "), next };
}

// confirmField sends the typed account ID only when the form asked for one.
function confirmField(form: FormData) {
  const confirm = String(form.get("confirm") ?? "").trim();
  return confirm ? { confirm } : {};
}

export async function unblockKey(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  await requireSession();
  const id = String(form.get("key_id") ?? "");
  if (!id || id.length > 500) return { error: "Choose a valid API key." };
  const fields = reviewFields(form);
  if (fields.error) return { error: fields.error };
  const result = await analystApi(
    `/v1/keys/${encodeURIComponent(id)}/unblock`,
    { ...confirmField(form), actor: fields.actor, reason: fields.reason },
  );
  if (result.error) return { error: result.error };
  revalidatePath("/", "layout");
  return { success: "Key access restored. This action has been recorded." };
}

export async function suspendKey(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  await requireSession();
  const id = String(form.get("key_id") ?? "");
  if (!id || id.length > 500) return { error: "Choose a valid API key." };
  const fields = reviewFields(form);
  if (fields.error) return { error: fields.error };
  const result = await analystApi<{ holds_dropped: number }>(
    `/v1/keys/${encodeURIComponent(id)}/suspend`,
    { actor: fields.actor, reason: fields.reason },
  );
  if (result.error) return { error: result.error };
  revalidatePath("/", "layout");
  const dropped = result.data?.holds_dropped ?? 0;
  return {
    success: `Key suspended${dropped ? ` and ${dropped} held email${dropped === 1 ? "" : "s"} dropped` : ""}. This action has been recorded.`,
  };
}

export async function correctToTakeover(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  await requireSession();
  const account = String(form.get("account_id") ?? "");
  if (!account || account.length > 200)
    return { error: "Choose a valid account." };
  const decisionIds = form.getAll("decision_id").map(String);
  if (decisionIds.length === 0)
    return { error: "Choose at least one decision to correct." };
  if (decisionIds.some((id) => !UUID.test(id)))
    return { error: "Reload the account: a decision is invalid." };
  const fields = reviewFields(form);
  if (fields.error) return { error: fields.error };
  const result = await analystApi<Correction>(
    `/v1/accounts/${encodeURIComponent(account)}/correct`,
    { decision_ids: decisionIds, actor: fields.actor, reason: fields.reason },
  );
  if (result.error) return { error: result.error };
  revalidatePath("/", "layout");
  const r = result.data!;
  const parts = [
    `${r.corrected} decision${r.corrected === 1 ? "" : "s"} relabelled takeover`,
    r.keys_suspended.length && `suspended ${r.keys_suspended.join(", ")}`,
    r.holds_dropped &&
      `${r.holds_dropped} held email${r.holds_dropped === 1 ? "" : "s"} dropped`,
  ].filter(Boolean);
  return {
    success: `Corrected: ${parts.join(", ")}. The baseline no longer counts those events.`,
  };
}

export async function ownerResponse(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  await requireSession();
  const id = String(form.get("decision_id") ?? "");
  const response = String(form.get("response") ?? "");
  if (!UUID.test(id) || !["this_was_me", "not_me"].includes(response))
    return { error: "Choose a valid response." };
  const result = await analystApi(`/v1/holds/${id}/owner-response`, {
    response,
  });
  if (result.error) return { error: result.error };
  refreshDecision(id);
  return {
    success:
      response === "this_was_me"
        ? "Recorded as legitimate. The pending hold has been released."
        : "Reported as unauthorized. The key is suspended and its pending holds have been dropped.",
  };
}

export async function resolveAccount(
  _previous: FormState,
  form: FormData,
): Promise<FormState> {
  await requireSession();
  const account = String(form.get("account_id") ?? "");
  const outcome = String(form.get("outcome") ?? "");
  if (!account || account.length > 200)
    return { error: "Choose a valid account." };
  if (outcome !== "legitimate" && outcome !== "takeover")
    return { error: "Choose Legitimate or Takeover." };
  const decisionIds = form.getAll("decision_id").map(String);
  if (decisionIds.length === 0 || decisionIds.some((id) => !UUID.test(id)))
    return { error: "Reload the account: its open reviews are missing." };
  const fields = reviewFields(form);
  if (fields.error) return { error: fields.error };
  const restoreKeys =
    outcome === "legitimate" && form.get("restore_keys") === "on";
  const result = await analystApi<AccountResolution>(
    `/v1/accounts/${encodeURIComponent(account)}/resolve`,
    {
      decision_ids: decisionIds,
      ...confirmField(form),
      outcome,
      restore_keys: restoreKeys,
      actor: fields.actor,
      reason: fields.reason,
    },
  );
  if (result.error) return { error: result.error };
  revalidatePath("/", "layout");
  const r = result.data!;
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [
    r.resolved && `${plural(r.resolved, "review")} closed`,
    r.holds_released && `${plural(r.holds_released, "hold")} released`,
    r.holds_dropped && `${plural(r.holds_dropped, "hold")} dropped`,
    r.keys_restored.length && `restored ${r.keys_restored.join(", ")}`,
    r.keys_suspended.length && `suspended ${r.keys_suspended.join(", ")}`,
  ].filter(Boolean);
  return {
    success: `Resolved as ${r.outcome}: ${parts.join(", ") || "nothing changed"}.`,
  };
}
