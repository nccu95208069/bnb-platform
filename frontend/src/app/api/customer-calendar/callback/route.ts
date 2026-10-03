import { NextRequest, NextResponse } from "next/server";
import { headers, principal, store } from "@/lib/customer-workspaces/http";
import {
  CALENDAR_STATE_COOKIE,
  calendarGoogleConfig,
  finishCalendarGoogle,
} from "@/lib/customer-workspaces/calendar-google";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  let location = "/start?calendar=failed",
    origin = request.nextUrl.origin;
  try {
    origin = new URL(calendarGoogleConfig().redirectUri).origin;
    const account = await principal(request);
    const result = await finishCalendarGoogle(
      store,
      account.id,
      request.nextUrl.searchParams.get("state") ?? "",
      request.cookies.get(CALENDAR_STATE_COOKIE)?.value ?? "",
      request.nextUrl.searchParams.get("code") ?? "",
    );
    location = `/w/${result.slug}/import?property=${encodeURIComponent(result.propertyId)}&calendar=connected`;
  } catch {
    /* Provider data and credentials never enter a redirect or response. */
  }
  const response = NextResponse.redirect(new URL(location, origin), {
    headers,
  });
  response.cookies.set(CALENDAR_STATE_COOKIE, "", {
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
    path: "/api/customer-calendar/callback",
    maxAge: 0,
  });
  return response;
}
