import { NextRequest, NextResponse } from "next/server";
import { optionalAccount } from "@/lib/customer-workspaces/calendar-onboarding-http";
import {
  body,
  failure,
  headers,
  limitSession,
  store,
} from "@/lib/customer-workspaces/http";
import {
  acceptInvitation,
  invitationInfo,
} from "@/lib/customer-workspaces/invitations";
import {
  CUSTOMER_COOKIE,
  sessionFor,
  SESSION_SECONDS,
} from "@/lib/customer-workspaces/auth";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const input = await body(request);
    await limitSession(request);
    const signedIn = await optionalAccount(request);
    if (input.action === "info")
      return NextResponse.json(
        await invitationInfo(store, input.token, signedIn),
        {
          headers,
        },
      );
    if (input.action !== "accept") throw new Error("INVALID_INPUT");
    const { account, slug } = await acceptInvitation(
      store,
      input.token,
      input.password,
      input.confirmPassword,
      signedIn,
    );
    const response = NextResponse.json(
      { ok: true, destination: `/w/${slug}/calendar` },
      { headers },
    );
    response.cookies.set(CUSTOMER_COOKIE, sessionFor(account), {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_SECONDS,
    });
    return response;
  } catch (error) {
    return failure(error);
  }
}
