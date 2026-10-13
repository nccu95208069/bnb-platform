import { NextRequest, NextResponse } from "next/server";
import { store, headers } from "@/lib/customer-workspaces/http";
import { customerOrigin } from "@/lib/customer-workspaces/site-url";
import { ACCEPTANCE_GMAIL_COOKIE, beginAcceptanceGmail } from "@/lib/workspace-auth/acceptance-gmail-oauth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    if (request.headers.get("origin") !== customerOrigin() || request.nextUrl.origin !== customerOrigin())
      throw new Error("FORBIDDEN");
    const started = await beginAcceptanceGmail(store);
    const response = NextResponse.redirect(started.url, { status: 303, headers });
    response.cookies.set(ACCEPTANCE_GMAIL_COOKIE, started.browser, {
      httpOnly: true, secure: true, sameSite: "lax",
      path: "/api/acceptance-mail/google/callback", maxAge: 600,
    });
    return response;
  } catch {
    return NextResponse.json({ code: "MAIL_SETUP_UNAVAILABLE" }, { status: 503, headers });
  }
}
