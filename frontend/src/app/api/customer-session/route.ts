import { NextRequest, NextResponse } from "next/server";
import {
  CUSTOMER_COOKIE,
  login,
  SESSION_SECONDS,
  sessionFor,
} from "@/lib/customer-workspaces/auth";
import {
  available,
  body,
  failure,
  headers,
  limitSession,
  principal,
  store,
} from "@/lib/customer-workspaces/http";
import { loadWorkspace } from "@/lib/customer-workspaces/service";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const account = await principal(request);
    const active = await Promise.all(
      account.workspaces.map(async (reference) => {
        try {
          await loadWorkspace(store, account.id, reference.slug);
          return reference;
        } catch (error) {
          if (error instanceof Error && error.message === "NOT_FOUND")
            return null;
          throw error;
        }
      }),
    );
    return NextResponse.json(
      {
        email: account.email,
        workspaces: active
          .filter((reference) => reference !== null)
          .map(({ id, name, slug }) => ({
            id,
            name,
            slug,
          })),
      },
      { headers },
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    const input = await body(request);
    await limitSession(request);
    const account = await login(store, input);
    const response = NextResponse.json({ ok: true }, { headers });
    response.cookies.set(CUSTOMER_COOKIE, sessionFor(account), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_SECONDS,
    });
    return response;
  } catch (error) {
    return failure(error);
  }
}
export async function DELETE(request: NextRequest) {
  try {
    available();
    await body(request);
    const response = NextResponse.json({ ok: true }, { headers });
    response.cookies.set(CUSTOMER_COOKIE, "", {
      path: "/",
      maxAge: 0,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    });
    return response;
  } catch (error) {
    return failure(error);
  }
}
