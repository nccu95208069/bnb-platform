import { NextRequest, NextResponse } from "next/server";
import { OWNER_COOKIE, OWNER_SESSION_SECONDS, createOwnerSession, ownerAccessConfigured } from "@/lib/calendar-owner-session";
import { RedisOwnerCredentialStore, credentialBinding, credentialMatches, credentialSessionValid, changeOwnerPassword } from "@/lib/owner-password";
const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie", "Referrer-Policy": "no-referrer" };
const sameOrigin = (request: NextRequest) => request.headers.get("origin") === `${request.nextUrl.protocol}//${request.headers.get("host")}`;
function cookieResponse(request: NextRequest, session: string) {
  const response = NextResponse.json({ authenticated: true }, { headers });
  response.cookies.set(OWNER_COOKIE, session, { httpOnly: true, secure: request.nextUrl.protocol === "https:", sameSite: "strict", path: "/", maxAge: OWNER_SESSION_SECONDS });
  return response;
}
async function body(request: NextRequest) {
  if (Number(request.headers.get("content-length")) > 2048) throw new Error("登入資料格式不正確。");
  const text = await request.text();
  if (text.length > 2048) throw new Error("登入資料格式不正確。");
  try { const value = JSON.parse(text); if (!value || typeof value !== "object") throw new Error(); return value; } catch { throw new Error("登入資料格式不正確。"); }
}
function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const messages: Record<string, [number, string]> = {
    OWNER_UNAUTHORIZED: [401, "登入已過期，請重新登入。"], OWNER_CURRENT_PASSWORD: [400, "目前密碼不正確。"],
    OWNER_RATE_LIMITED: [429, "嘗試次數過多，請 15 分鐘後再試。"],
    OWNER_CHANGED_CONCURRENTLY: [409, "密碼剛剛已變更，請以新密碼重新登入。"],
    OWNER_WRITE_UNCERTAIN: [503, "設定結果暫時無法確認，請先以新密碼重新登入。"],
    "新密碼需要 12～128 個字元。": [400, "新密碼需要 12～128 個字元。"],
    "請使用較不容易猜到的密碼或長句。": [400, "請使用較不容易猜到的密碼或長句。"],
    "兩次新密碼不一致。": [400, "兩次新密碼不一致。"], "登入資料格式不正確。": [400, "登入資料格式不正確。"],
  };
  const [status, detail] = messages[code] ?? [503, "登入服務暫時無法使用，請稍後再試。"];
  return NextResponse.json({ detail }, { status, headers });
}
export async function GET(request: NextRequest) {
  if (!ownerAccessConfigured()) return NextResponse.json({ available: false, authenticated: false }, { headers });
  try {
    const credential = await new RedisOwnerCredentialStore().read();
    const authenticated = credentialSessionValid(request.cookies.get(OWNER_COOKIE)?.value, credential.value);
    return NextResponse.json({ available: true, authenticated, has_custom_password: authenticated && credential.value.kind === "password" }, { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ detail: "請從本站登入。" }, { status: 403, headers });
  if (!ownerAccessConfigured()) return NextResponse.json({ detail: "私人檢視尚未啟用。" }, { status: 503, headers });
  try {
    const input = await body(request), store = new RedisOwnerCredentialStore();
    if (!await store.consumeAttempt()) throw new Error("OWNER_RATE_LIMITED");
    const credential = await store.read();
    if (!await credentialMatches(input.code, credential.value)) return NextResponse.json({ detail: "密碼或登入碼不正確。" }, { status: 401, headers });
    return cookieResponse(request, createOwnerSession(Date.now(), credentialBinding(credential.value)));
  } catch (error) { return failure(error); }
}
export async function PATCH(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ detail: "請從本站變更密碼。" }, { status: 403, headers });
  if (!ownerAccessConfigured()) return NextResponse.json({ detail: "私人檢視尚未啟用。" }, { status: 503, headers });
  try {
    const session = await changeOwnerPassword(new RedisOwnerCredentialStore(), request.cookies.get(OWNER_COOKIE)?.value, await body(request));
    return cookieResponse(request, session);
  } catch (error) { return failure(error); }
}
export async function DELETE(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ detail: "請從本站登出。" }, { status: 403, headers });
  const response = NextResponse.json({ authenticated: false }, { headers });
  response.cookies.set(OWNER_COOKIE, "", { httpOnly: true, secure: request.nextUrl.protocol === "https:", sameSite: "strict", path: "/", maxAge: 0 });
  return response;
}
