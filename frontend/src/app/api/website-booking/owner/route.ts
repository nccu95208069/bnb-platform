import { NextRequest, NextResponse } from "next/server";
import { authenticate, CUSTOMER_COOKIE } from "@/lib/customer-workspaces/auth";
import { body } from "@/lib/customer-workspaces/http";
import { LOGIN_PROOF_COOKIE, LOGIN_SECONDS, newLoginProof, requestEmailLogin } from "@/lib/customer-workspaces/passwordless";
import { intakePreview } from "@/lib/customer-intake/config";
import { sendCustomerLifecycleMail } from "@/lib/workspace-auth/mail";
import { email, fields, requireEnabled } from "@/lib/website-booking/config";
import { approveConnection, connectionFor, ownerConnection } from "@/lib/website-booking/connections";
import { failure, headers, store } from "@/lib/website-booking/http";
import { WEBSITE_LOGIN_COOKIE } from "@/lib/website-booking/login";
import { prepareLinePairing } from "@/lib/website-booking/line-pairing";
export const runtime = "nodejs";
const ownerHeaders = { ...headers, Vary: "Cookie" };
export async function GET(request: NextRequest) {
  try {
    let account;
    try { account = await authenticate(store, request.cookies.get(CUSTOMER_COOKIE)?.value); }
    catch (e) { if (e instanceof Error && e.message === "UNAUTHORIZED") return NextResponse.json({ authenticated: false }, { headers: ownerHeaders }); throw e; }
    const result = await ownerConnection(store, account, request.nextUrl.searchParams.get("connection"));
    return NextResponse.json(result, { headers: ownerHeaders });
  } catch (e) { return failure(e); }
}
export async function POST(request: NextRequest) {
  try {
    const input = await body(request, 32768);
    requireEnabled();
    if (input.action === "login-prepare") {
      fields(input, ["action", "connectionId"]);
      const c = (await connectionFor(store, input.connectionId)).value;
      const previous = request.cookies.get(LOGIN_PROOF_COOKIE)?.value;
      const proof = previous && /^[\w-]{43}$/.test(previous) ? previous : newLoginProof();
      const response = NextResponse.json({ ok: true }, { headers: ownerHeaders });
      const options = { httpOnly: true, secure: request.nextUrl.protocol === "https:", sameSite: "lax" as const, path: "/", maxAge: LOGIN_SECONDS };
      response.cookies.set(LOGIN_PROOF_COOKIE, proof, options);
      response.cookies.set(WEBSITE_LOGIN_COOKIE, c.id, options);
      return response;
    }
    if (input.action === "login-request") {
      fields(input, ["action", "connectionId", "email", "requestKey"]);
      const c = (await connectionFor(store, input.connectionId)).value;
      if (request.cookies.get(WEBSITE_LOGIN_COOKIE)?.value !== c.id) throw Error("LOGIN_BROWSER_REQUIRED");
      if (email(input.email) !== c.ownerEmail) throw Error("WEBSITE_OWNER_MISMATCH");
      const result = await requestEmailLogin(store, { email: input.email, requestKey: input.requestKey,
        proof: request.cookies.get(LOGIN_PROOF_COOKIE)?.value, websiteConnectionId: c.id }, sendCustomerLifecycleMail, intakePreview());
      if (result.status === "preview") return NextResponse.json({ delivery: "preview", detail: "此環境停用寄信，尚未寄出登入連結。請使用可寄信的驗收環境，或聯絡管理員。" }, { headers: ownerHeaders });
      if (result.status !== "accepted") throw Error("LOGIN_DELIVERY_UNCONFIRMED");
      return NextResponse.json({ delivery: "accepted", detail: "登入連結已寄出，請在同一個瀏覽器開啟信件。登入後仍需確認網站設定，才會建立日曆。" }, { headers: ownerHeaders });
    }
    const account = await authenticate(store, request.cookies.get(CUSTOMER_COOKIE)?.value);
    await store.limit(`website-owner:${account.id}`, 60);
    if (input.action === "line-prepare") return NextResponse.json(await prepareLinePairing(store, account, input), { headers: ownerHeaders });
    return NextResponse.json(await approveConnection(store, account, input), { headers: ownerHeaders });
  } catch (e) { return failure(e); }
}
