import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "./session";

export async function requireSession() {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!verifySession(cookie, process.env.UI_PASSWORD)) redirect("/login");
}
