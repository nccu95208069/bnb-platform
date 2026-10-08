import { NextRequest, NextResponse } from "next/server";
import {
  body,
  failure,
  headers,
  store,
  limitSession,
} from "@/lib/customer-workspaces/http";
import {
  CUSTOMER_COOKIE,
  SESSION_SECONDS,
} from "@/lib/customer-workspaces/auth";
import { sessionFor } from "@/lib/customer-workspaces/auth";
import {
  LOGIN_PROOF_COOKIE,
  LOGIN_SECONDS,
  newLoginProof,
  requestEmailLogin,
  consumeEmailLogin,
} from "@/lib/customer-workspaces/passwordless";
import { CALENDAR_STATE_COOKIE } from "@/lib/customer-workspaces/calendar-google";
import {
  beginGoogleSignIn,
  linkVerifiedGoogleIdentity,
} from "@/lib/customer-workspaces/google-signin";
import {
  ONBOARDING_COOKIE,
  draftHash,
  draftForHash,
  updateCalendarDraft,
} from "@/lib/customer-workspaces/calendar-onboarding";
import { previewAvailable } from "@/lib/customer-workspaces/calendar-onboarding-http";
import { intakePreview } from "@/lib/customer-intake/config";
import { sendCustomerLifecycleMail } from "@/lib/workspace-auth/mail";
import { normalizedEmail, validEmail } from "@/lib/workspace-auth/types";
import { WEBSITE_LOGIN_COOKIE } from "@/lib/website-booking/login";
import { connectionFor } from "@/lib/website-booking/connections";
export const runtime = "nodejs";
export async function POST(request: NextRequest) {
  try {
    const input = await body(request);
    await limitSession(request);
    if (input.action === "prepare") {
      const previous = request.cookies.get(LOGIN_PROOF_COOKIE)?.value;
      const proof =
        previous && /^[\w-]{43}$/.test(previous) ? previous : newLoginProof();
      const response = NextResponse.json({ ok: true }, { headers });
      response.cookies.set(LOGIN_PROOF_COOKIE, proof, {
        httpOnly: true,
        secure: request.nextUrl.protocol === "https:",
        sameSite: "lax",
        path: "/",
        maxAge: LOGIN_SECONDS,
      });
      return response;
    }
    if (input.action === "google") {
      const started = await beginGoogleSignIn(store),
        response = NextResponse.json({ url: started.url }, { headers });
      response.cookies.set(CALENDAR_STATE_COOKIE, started.browser, {
        httpOnly: true,
        secure: request.nextUrl.protocol === "https:",
        sameSite: "lax",
        path: "/api/customer-calendar/callback",
        maxAge: 600,
      });
      return response;
    }
    if (input.action === "request") {
      let hash: string | undefined;
      if (input.destination === "calendar") {
        previewAvailable();
        hash = draftHash(request.cookies.get(ONBOARDING_COOKIE)?.value);
        const saved = await draftForHash(store, hash);
        const email = normalizedEmail(input.email);
        if (
          !validEmail(email) ||
          typeof input.requestKey !== "string" ||
          !/^[\w-]{36}$/.test(input.requestKey)
        )
          throw new Error("INVALID_INPUT");
        if (!saved.value.prepared || saved.value.completed)
          throw new Error("FORMAT_CONFIRMATION_REQUIRED");
        if (saved.value.googleIdentity && saved.value.claimEmail !== email)
          throw new Error("CALENDAR_ACCOUNT_CHANGED");
        if (
          saved.value.claimEmail !== email ||
          saved.value.loginRequestId !== input.requestKey
        )
          await updateCalendarDraft(store, hash, saved, {
            claimEmail: email,
            loginRequestId: input.requestKey,
          });
      } else if (input.destination !== "start")
        throw new Error("INVALID_INPUT");
      const result = await requestEmailLogin(
        store,
        {
          email: input.email,
          requestKey: input.requestKey,
          proof: request.cookies.get(LOGIN_PROOF_COOKIE)?.value,
          draftHash: hash,
        },
        sendCustomerLifecycleMail,
        intakePreview(),
      );
      return NextResponse.json(
        {
          detail: hash
            ? result.status === "accepted"
              ? "登入連結已寄出，請在同一瀏覽器開啟信件連結。預覽會保留，登入後再確認保存。"
              : result.status === "preview"
                ? "此環境停用寄信，尚未驗證信箱；請聯絡管理員使用可寄信的驗收環境。"
                : "目前無法確認信件寄送結果，請先檢查收件匣；若未收到，可稍後重新申請連結。"
            : "若此信箱可登入，你會收到登入連結。請在同一瀏覽器開啟。新客戶可先從加入頁預覽日曆。",
        },
        { headers },
      );
    }
    if (input.action === "consume") {
      let hash: string | undefined;
      const cookie = request.cookies.get(ONBOARDING_COOKIE)?.value;
      if (cookie && /^[\w-]{43}$/.test(cookie)) hash = draftHash(cookie);
      let draft;
      if (hash) {
        try {
          draft = await draftForHash(store, hash);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "CALENDAR_PREVIEW_REQUIRED"
          )
            throw error;
        }
      }
      const result = await consumeEmailLogin(
        store,
        input.token,
        request.cookies.get(LOGIN_PROOF_COOKIE)?.value,
        hash,
        draft?.value.loginRequestId,
        request.cookies.get(WEBSITE_LOGIN_COOKIE)?.value,
      );
      let account = result.account;
      if (result.websiteConnectionId) {
        const connection = (await connectionFor(store, result.websiteConnectionId)).value;
        if (connection.ownerEmail !== account.email) throw new Error("UNAUTHORIZED");
      }
      if (result.draftHash) {
        if (
          !draft ||
          result.draftHash !== hash ||
          draft.value.claimEmail !== account.email ||
          !draft.value.prepared
        )
          throw new Error("CALENDAR_ACCOUNT_CHANGED");
        if (draft.value.googleIdentity)
          account = await linkVerifiedGoogleIdentity(
            store,
            account,
            draft.value.googleIdentity,
          );
      }
      const response = NextResponse.json(
        { url: result.websiteConnectionId ? `/website-booking?connection=${result.websiteConnectionId}` : result.draftHash ? "/join/calendar?verified=1" : "/start" },
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
    }
    throw new Error("INVALID_INPUT");
  } catch (error) {
    return failure(error);
  }
}
