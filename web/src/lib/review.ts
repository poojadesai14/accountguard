export type FormState = { error?: string; success?: string };
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function reviewFields(form: FormData) {
  const actor = String(form.get("actor") ?? "").trim();
  const reason = String(form.get("reason") ?? "").trim();
  if (!actor || actor.length > 100)
    return { error: "Enter your name (up to 100 characters)." };
  if (!reason || reason.length > 2000)
    return { error: "Add a reason for this action (up to 2,000 characters)." };
  return { actor, reason };
}
