import { NextRequest, NextResponse } from "next/server";
import { authenticate, CUSTOMER_COOKIE, digest, enabled } from "./auth.ts";
import { RedisCustomerStore } from "./store.ts";
export const store = new RedisCustomerStore();
export const headers = {
  "Cache-Control": "private, no-store",
  Vary: "Cookie",
  "Referrer-Policy": "no-referrer",
};
export function available() {
  if (!enabled()) throw new Error("FEATURE_UNAVAILABLE");
}
export async function principal(request: NextRequest) {
  available();
  return authenticate(store, request.cookies.get(CUSTOMER_COOKIE)?.value);
}
export async function body(request: NextRequest) {
  available();
  if (request.headers.get("origin") !== request.nextUrl.origin)
    throw new Error("FORBIDDEN");
  const raw = await request.text();
  if (raw.length > 16000) throw new Error("INVALID_INPUT");
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("INVALID_INPUT");
  }
}
export async function limitSession(request: NextRequest) {
  // Vercel overwrites this header; do not trust arbitrary forwarded-for chains.
  await store.limit(
    `session:${digest(request.headers.get("x-vercel-forwarded-for") || "shared")}`,
    30,
  );
}
export function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const errors: Record<string, [number, string]> = {
    FEATURE_UNAVAILABLE: [503, "新客戶入口尚未開放。"],
    UNAUTHORIZED: [401, "請登入；若登入失敗，請確認信箱與密碼。"],
    ACCOUNT_EXISTS: [409, "此信箱無法建立新帳號，請嘗試登入。"],
    PASSWORD_INVALID: [400, "請使用 12～128 字元的密碼，並確認兩次輸入相同。"],
    INVALID_INPUT: [400, "請檢查房間、日期及輸入內容。"],
    FORBIDDEN: [403, "目前帳號沒有操作權限。"],
    NOT_FOUND: [404, "找不到有權限存取的旅宿。"],
    SLUG_EXISTS: [409, "網址代稱已被使用，請換一個。"],
    VERSION_CONFLICT: [409, "房況剛被更新，請重新載入房況後再建立。"],
    IDEMPOTENCY_CONFLICT: [409, "此操作已送出不同內容，請重新載入並核對訂單。"],
    ROOM_CONFLICT: [409, "所選房間在住宿期間已有訂房，請調整日期或房間。"],
    WRITE_UNCONFIRMED: [
      503,
      "寫入結果暫時無法確認。請保留表單重試，系統會避免重複建立。",
    ],
    RATE_LIMITED: [429, "操作較頻繁，請稍後再試。"],
    LIMIT_REACHED: [409, "已達此版本的容量限制，請聯絡管理者。"],
  };
  const [status, detail] = errors[code] ?? [
    503,
    "服務暫時無法使用，請保留內容稍後重試。",
  ];
  return NextResponse.json(
    { code: errors[code] ? code : "SERVICE_UNAVAILABLE", detail },
    { status, headers },
  );
}
