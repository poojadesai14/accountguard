import { NextRequest, NextResponse } from "next/server";
import { authConfig, SESSION_COOKIE, verifySession } from "@/lib/session";

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (pathname === "/login") return NextResponse.next();
  if (
    !verifySession(request.cookies.get(SESSION_COOKIE)?.value, authConfig())
  ) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", pathname + request.nextUrl.search);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|robots.txt).*)",
  ],
};
