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
import { reviewFields, UUID, type FormState } from "@/lib/review";
import type { AccountResolution, DecisionDetail } from "@/lib/types";
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
    actor: fields.actor,
    reason: fields.reason,
  });
  if (result.error) return { error: result.error };
  refreshDecision(id);
  // Marking legitimate never restores a suspended key; say so, so the review
  // doesn't look finished while the account is still blocked.
  if (action === "mark_legitimate") {
    const detail = await analystApi<DecisionDetail>(`/v1/decisions/${id}`);
    const key = detail.data?.key;
    if (detail.data && restoreIsLastStep(detail.data.decision, key))
      return {
        success: `Marked legitimate. Key ${key!.api_key_id} is still suspended: restore access to finish.`,
      };
  }
  return {
    success: "Action recorded. The decision and audit history are up to date.",
  };
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
    { actor: fields.actor, reason: fields.reason },
  );
  if (result.error) return { error: result.error };
  revalidatePath("/", "layout");
  return { success: "Key access restored. This action has been recorded." };
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
