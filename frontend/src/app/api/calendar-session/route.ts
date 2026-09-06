import { principalFor, MEMBER_COOKIE, createMemberSession } from "@/lib/workspace-auth/session";
import { ADMIN_EMAIL, normalizedEmail, nextWorkspace } from "@/lib/workspace-auth/types";
import { RedisWorkspaceStore } from "@/lib/workspace-auth/store";
import { NextRequest, NextResponse } from "next/server";
import { OWNER_COOKIE, OWNER_SESSION_SECONDS, createOwnerSession, ownerAccessConfigured } from "@/lib/calendar-owner-session";
import { RedisOwnerCredentialStore, credentialBinding, credentialMatches, changeOwnerPassword, createPasswordCredential, passwordProblem } from "@/lib/owner-password";
const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie", "Referrer-Policy": "no-referrer" };
const sameOrigin = (request: NextRequest) => request.headers.get("origin") === `${request.nextUrl.protocol}//${request.headers.get("host")}`;
function cookieResponse(request: NextRequest, session: string, member = false) {
  const response = NextResponse.json({ authenticated: true }, { headers });
  response.cookies.set(member ? MEMBER_COOKIE : OWNER_COOKIE, session, { httpOnly: true, secure: request.nextUrl.protocol === "https:", sameSite: "strict", path: "/", maxAge: OWNER_SESSION_SECONDS });
  response.cookies.set(member ? OWNER_COOKIE : MEMBER_COOKIE, "", { path: "/", maxAge: 0, httpOnly: true, secure: request.nextUrl.protocol === "https:", sameSite: "strict" });
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
    UNAUTHORIZED: [401, "信箱或密碼不正確，或帳號尚未啟用。"],
    PASSWORD_INVALID: [400, "密碼需為不易猜測的 12～128 個字元，且兩次輸入一致。"],
    RATE_LIMITED: [429, "嘗試次數過多，請稍後再試。"],
    VERSION_CONFLICT: [409, "帳號剛剛已更新，請重新登入。"],
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
    const principal = await principalFor(request);
    const hasCustomPassword = principal?.role === "owner" ? (await new RedisOwnerCredentialStore().read()).value.kind === "password" : Boolean(principal);
    return NextResponse.json({ available: true, authenticated: Boolean(principal), has_custom_password: hasCustomPassword,
      membership: principal ? { ...principal, tenantId: "sweetfun-workspace", tenantName: "Sweetfun OS", phone: null, status: "active" } : null }, { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ detail: "請從本站登入。" }, { status: 403, headers });
  if (!ownerAccessConfigured()) return NextResponse.json({ detail: "私人檢視尚未啟用。" }, { status: 503, headers });
  try {
    const input = await body(request), email = normalizedEmail(input.email), workspace = new RedisWorkspaceStore();
    await workspace.limit("login-global", 100, 900);
    await workspace.limit(`login:${email}`, 20, 900);
    if (email === ADMIN_EMAIL) {
      const store = new RedisOwnerCredentialStore();
      if (!await store.consumeAttempt()) throw new Error("OWNER_RATE_LIMITED");
      const credential = await store.read();
      if (!await credentialMatches(input.code, credential.value)) throw new Error("UNAUTHORIZED");
      return cookieResponse(request, createOwnerSession(Date.now(), credentialBinding(credential.value)));
    }
    const member = (await workspace.read()).value.members.find(m => m.email === email);
    if (!member || member.status !== "active" || !member.credential || !await credentialMatches(input.code, member.credential)) throw new Error("UNAUTHORIZED");
    return cookieResponse(request, createMemberSession(member), true);
  } catch (error) { return failure(error); }
}
export async function PATCH(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ detail: "請從本站變更密碼。" }, { status: 403, headers });
  if (!ownerAccessConfigured()) return NextResponse.json({ detail: "私人檢視尚未啟用。" }, { status: 503, headers });
  try {
    const input = await body(request), principal = await principalFor(request);
    if (!principal) throw new Error("OWNER_UNAUTHORIZED");
    if (principal.role === "owner") {
      const session = await changeOwnerPassword(new RedisOwnerCredentialStore(), request.cookies.get(OWNER_COOKIE)?.value, input);
      return cookieResponse(request, session);
    }
    const store = new RedisWorkspaceStore();
    await store.limit(`password:${principal.id}`, 10, 900);
    const state = await store.read(), member = state.value.members.find(m => m.id === principal.id);
    if (!member?.credential || !await credentialMatches(input.currentPassword, member.credential)) throw new Error("OWNER_CURRENT_PASSWORD");
    if (passwordProblem(input.password) || input.password !== input.confirmPassword) throw new Error("PASSWORD_INVALID");
    const updated = { ...member, credential: await createPasswordCredential(input.password), version: member.version + 1, invitation: null };
    await store.replace(state.raw, nextWorkspace(state.value, state.value.members.map(m => m.id === member.id ? updated : m), "password_changed", member.id, member.id));
    return cookieResponse(request, createMemberSession(updated), true);
  } catch (error) { return failure(error); }
}
export async function DELETE(request: NextRequest) {
  if (!sameOrigin(request)) return NextResponse.json({ detail: "請從本站登出。" }, { status: 403, headers });
  const response = NextResponse.json({ authenticated: false }, { headers });
  response.cookies.set(MEMBER_COOKIE, "", { httpOnly: true, secure: request.nextUrl.protocol === "https:", sameSite: "strict", path: "/", maxAge: 0 });
  response.cookies.set(OWNER_COOKIE, "", { httpOnly: true, secure: request.nextUrl.protocol === "https:", sameSite: "strict", path: "/", maxAge: 0 });
  return response;
}
