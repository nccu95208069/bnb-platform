import { NextRequest, NextResponse } from "next/server";
import {
  available,
  headers,
  principal,
  store,
} from "@/lib/customer-workspaces/http";
import {
  CALENDAR_STATE_COOKIE,
  calendarGoogleConfig,
  finishCalendarGoogle,
} from "@/lib/customer-workspaces/calendar-google";
import {
  CUSTOMER_COOKIE,
  SESSION_SECONDS,
  sessionFor,
} from "@/lib/customer-workspaces/auth";
import {
  ONBOARDING_COOKIE,
  draftHash,
} from "@/lib/customer-workspaces/calendar-onboarding";
import {
  isGoogleSignInState,
  finishGoogleSignIn,
} from "@/lib/customer-workspaces/google-signin";
import type { Account } from "@/lib/customer-workspaces/types";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  let location = "/start?calendar=failed",
    origin = request.nextUrl.origin;
  let signedIn: Account | null = null;
  try {
    available();
    origin = new URL(calendarGoogleConfig().redirectUri).origin;
    const state = request.nextUrl.searchParams.get("state") ?? "";
    if (await isGoogleSignInState(store, state)) {
      location = request.cookies.get(ONBOARDING_COOKIE)?.value
        ? "/join/calendar?calendar=failed"
        : "/start?google=failed";
      const cookie = request.cookies.get(ONBOARDING_COOKIE)?.value;
      const result = await finishGoogleSignIn(
        store,
        state,
        request.cookies.get(CALENDAR_STATE_COOKIE)?.value ?? "",
        request.nextUrl.searchParams.get("code") ?? "",
        cookie ? draftHash(cookie) : undefined,
      );
      location = result.destination;
      signedIn = result.account;
    } else {
      const account = await principal(request);
      const result = await finishCalendarGoogle(
        store,
        account.id,
        request.nextUrl.searchParams.get("state") ?? "",
        request.cookies.get(CALENDAR_STATE_COOKIE)?.value ?? "",
        request.nextUrl.searchParams.get("code") ?? "",
      );
      location = `/w/${result.slug}/import?property=${encodeURIComponent(result.propertyId)}&calendar=connected`;
    }
  } catch {
    /* Provider data and credentials never enter a redirect or response. */
  }
  const response = NextResponse.redirect(new URL(location, origin), {
    headers,
  });
  if (signedIn)
    response.cookies.set(CUSTOMER_COOKIE, sessionFor(signedIn), {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_SECONDS,
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
