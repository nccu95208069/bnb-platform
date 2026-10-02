import { NextRequest, NextResponse } from "next/server";
import {
  body,
  failure,
  headers,
  limitSession,
  store,
} from "@/lib/customer-workspaces/http";
import {
  accountKey,
  CUSTOMER_COOKIE,
  digest,
  sessionFor,
  SESSION_SECONDS,
} from "@/lib/customer-workspaces/auth";
import {
  accountLinkInfo,
  accountLinkUrl,
  consumeAccountLink,
  issueAccountLink,
} from "@/lib/customer-workspaces/account-links";
import { provisionVerifiedApplication } from "@/lib/customer-intake/onboarding";
import { deliverOnce } from "@/lib/customer-intake/delivery";
import { intakePreview, INTAKE_RECIPIENT } from "@/lib/customer-intake/config";
import { normalizedEmail, validEmail } from "@/lib/workspace-auth/types";
import { sendCustomerLifecycleMail } from "@/lib/workspace-auth/mail";
import type { Account } from "@/lib/customer-workspaces/types";
import { randomUUID } from "node:crypto";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: NextRequest) {
  try {
    const input = await body(request);
    await limitSession(request);
    if (input.action === "info")
      return NextResponse.json(await accountLinkInfo(store, input.token), {
        headers,
      });
    if (input.action === "recover") {
      const email = normalizedEmail(input.email);
      if (!validEmail(email)) throw new Error("INVALID_INPUT");
      await store.limit(`recovery:${digest(email)}`, 3);
      await store.limit("recovery:global", 100);
      const account = (await store.read<Account>(accountKey(email))).value;
      if (account) {
        const id = randomUUID(),
          link = await issueAccountLink(store, "recovery", id, email);
        await deliverOnce(
          store,
          `recovery-mail:${id}`,
          email,
          "旅宿服務｜重新設定密碼",
          `你剛剛要求重新設定旅宿工作區的密碼。請於 24 小時內開啟：\n${accountLinkUrl(link)}\n\n若不是你提出的要求，請忽略本信；原密碼仍可使用。\n聯絡信箱：${INTAKE_RECIPIENT}`,
          sendCustomerLifecycleMail,
          intakePreview(),
        );
      }
      return NextResponse.json(
        {
          ok: true,
          detail:
            "如果這個信箱已有帳號，我們會寄出密碼重設連結。請也檢查垃圾郵件。",
        },
        { headers },
      );
    }
    if (input.action !== "activate") throw new Error("INVALID_INPUT");
    const { account, link } = await consumeAccountLink(
      store,
      input.token,
      input.password,
      input.confirmPassword,
    );
    let destination = "/start";
    if (link.purpose === "onboarding")
      destination = (
        await provisionVerifiedApplication(store, link.id, account)
      ).destination;
    else if (account.workspaces.length === 1)
      destination = `/w/${account.workspaces[0].slug}/calendar`;
    const response = NextResponse.json({ ok: true, destination }, { headers });
    response.cookies.set(CUSTOMER_COOKIE, sessionFor(account), {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_SECONDS,
    });
    return response;
  } catch (e) {
    return failure(e);
  }
}
