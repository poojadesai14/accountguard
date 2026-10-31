import "server-only";
import { requireSession } from "./auth";
import type { ApiResult } from "./types";

export async function analystApi<T>(
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  await requireSession();
  const base = process.env.API_BASE_URL;
  const token = process.env.ANALYST_TOKEN;
  if (!base || !token)
    return {
      error:
        "The dashboard connection is not configured. Set API_BASE_URL and ANALYST_TOKEN on the UI server.",
      status: 503,
    };
  try {
    const url = new URL(base);
    if (!["https:", "http:"].includes(url.protocol))
      throw new Error("Invalid API URL");
    const response = await fetch(new URL(path, url), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(65_000),
    });
    if (!response.ok) {
      const messages: Record<number, string> = {
        400: "The request could not be accepted. Check the selected values.",
        401: "The API rejected the dashboard's analyst token. Check the server configuration.",
        404: "This record could not be found.",
        409: "This record has changed or the action no longer applies. Refresh and review its current state.",
      };
      return {
        error:
          messages[response.status] ??
          "The API is temporarily unavailable. Please try again.",
        status: response.status,
      };
    }
    return { data: (await response.json()) as T };
  } catch {
    return {
      error:
        "We couldn't reach the API. It may be waking up after being idle. Please try again shortly.",
      status: 503,
    };
  }
}
