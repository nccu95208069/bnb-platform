import { NextRequest, NextResponse } from "next/server";
import { store, headers } from "@/lib/customer-workspaces/http";
import { acceptanceGmailConfig, ACCEPTANCE_GMAIL_COOKIE, finishAcceptanceGmail } from "@/lib/workspace-auth/acceptance-gmail-oauth";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  let origin: string;
  try {
    origin = acceptanceGmailConfig().origin;
    if (request.nextUrl.origin !== origin) throw new Error("FORBIDDEN");
  } catch {
    return NextResponse.json({ code: "MAIL_SETUP_UNAVAILABLE" }, { status: 503, headers });
  }
  let result = "failed";
  if (request.nextUrl.searchParams.get("error") === "access_denied") result = "denied";
  else {
    try {
      await finishAcceptanceGmail(
        store,
        request.nextUrl.searchParams.get("state") ?? "",
        request.cookies.get(ACCEPTANCE_GMAIL_COOKIE)?.value ?? "",
        request.nextUrl.searchParams.get("code") ?? "",
      );
      result = "connected";
    } catch { /* Never return authorization codes, tokens, or provider response bodies. */ }
  }
  const response = NextResponse.redirect(new URL(`/acceptance-mail?result=${result}`, origin),
    { status: 303, headers });
  response.cookies.set(ACCEPTANCE_GMAIL_COOKIE, "", {
    httpOnly: true, secure: true, sameSite: "lax",
    path: "/api/acceptance-mail/google/callback", maxAge: 0,
  });
  return response;
}
