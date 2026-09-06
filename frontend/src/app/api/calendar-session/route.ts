import { NextRequest, NextResponse } from "next/server";
import { OWNER_COOKIE, OWNER_SESSION_SECONDS, createOwnerSession, ownerAccessConfigured, validOwnerCode, validOwnerSession } from "@/lib/calendar-owner-session";
const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie", "Referrer-Policy": "no-referrer" };
export async function GET(request: NextRequest) {
  return NextResponse.json({ available: ownerAccessConfigured(), authenticated: validOwnerSession(request.cookies.get(OWNER_COOKIE)?.value) }, { headers });
}
export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== `${request.nextUrl.protocol}//${request.headers.get("host")}`) return NextResponse.json({ detail: "請從本站登入。" }, { status: 403, headers });
  if (!ownerAccessConfigured()) return NextResponse.json({ detail: "私人檢視尚未啟用。" }, { status: 503, headers });
  if (Number(request.headers.get("content-length")) > 1024) return NextResponse.json({ detail: "登入資料格式不正確。" }, { status: 400, headers });
  const text = await request.text();
  if (text.length > 1024) return NextResponse.json({ detail: "登入資料格式不正確。" }, { status: 400, headers });
  let code: unknown;
  try { code = JSON.parse(text).code; } catch { /* Invalid input is a failed login. */ }
  if (!validOwnerCode(code)) return NextResponse.json({ detail: "登入碼不正確。" }, { status: 401, headers });
  const response = NextResponse.json({ authenticated: true }, { headers });
  response.cookies.set(OWNER_COOKIE, createOwnerSession(), { httpOnly: true, secure: request.nextUrl.protocol === "https:", sameSite: "strict", path: "/", maxAge: OWNER_SESSION_SECONDS });
  return response;
}
export async function DELETE(request: NextRequest) {
  if (request.headers.get("origin") !== `${request.nextUrl.protocol}//${request.headers.get("host")}`) return NextResponse.json({ detail: "請從本站登出。" }, { status: 403, headers });
  const response = NextResponse.json({ authenticated: false }, { headers });
  response.cookies.set(OWNER_COOKIE, "", { httpOnly: true, secure: request.nextUrl.protocol === "https:", sameSite: "strict", path: "/", maxAge: 0 });
  return response;
}
