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
import type {
  AccountResolution,
  Correction,
  ProfileResponse,
} from "@/lib/types";

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
  if (result.error) {
    // 409: the open reviews changed since the page loaded. Reload them so the
    // next submit names the current set.
    if (result.status === 409) revalidatePath("/", "layout");
    return { error: result.error };
  }
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
  const done = `Resolved as ${r.outcome}: ${parts.join(", ") || "nothing changed"}.`;
  if (r.outcome === "takeover") return { success: done };
  // Legitimate: say what still keeps the account out of Healthy, and link to it.
  const page = `/accounts/${encodeURIComponent(account)}`;
  const profile = await analystApi<ProfileResponse>(
    `/v1/accounts/${encodeURIComponent(account)}/profile`,
  );
  const suspended = (profile.data?.key_status ?? []).filter(
    (k) => k.status === "suspended",
  );
  if (!suspended.length)
    return {
      success: `${done} Nothing else is open on this account, so it moves to Healthy.`,
    };
  return {
    success: `${done} ${suspended.map((k) => k.api_key_id).join(", ")} ${suspended.length === 1 ? "is" : "are"} still suspended: restore access to finish.`,
    next: suspended.map((k) => ({
      label: `Restore ${k.api_key_id}`,
      href: `${page}?restore=${encodeURIComponent(k.api_key_id)}`,
    })),
  };
}
