import { NextRequest, NextResponse } from "next/server";
import { principal, store, headers } from "@/lib/customer-workspaces/http";
import {
  finishGoogle,
  googleConfig,
  GOOGLE_STATE_COOKIE,
} from "@/lib/customer-workspaces/customer-google";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  let location = "/start?google=failed";
  try {
    const account = await principal(request);
    const connected = await finishGoogle(
      store,
      account.id,
      request.nextUrl.searchParams.get("state") ?? "",
      request.cookies.get(GOOGLE_STATE_COOKIE)?.value ?? "",
      request.nextUrl.searchParams.get("code") ?? "",
    );
    location = `/w/${connected.slug}/import?property=${encodeURIComponent(connected.propertyId)}&google=connected`;
  } catch {
    /* Never return provider responses, codes, tokens or raw errors. */
  }
  let origin = request.nextUrl.origin;
  try {
    origin = new URL(googleConfig().redirectUri).origin;
  } catch {
    /* Feature remains unavailable. */
  }
  const response = NextResponse.redirect(new URL(location, origin), {
    headers,
  });
  response.cookies.set(GOOGLE_STATE_COOKIE, "", {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/api/customer-google/callback",
    maxAge: 0,
  });
  return response;
}
