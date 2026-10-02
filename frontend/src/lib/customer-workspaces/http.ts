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
    IMPORT_INCOMPLETE: [
      409,
      "資料尚未完整，未顯示訂單的日期不能視為空房。請先完成匯入與問題資料核對。",
    ],
    FORMAT_CONFIRMATION_REQUIRED: [
      400,
      "請先確認欄位、房間、訂單粒度與金額意義，再匯入。",
    ],
    SOURCE_CHANGED: [
      409,
      "Sheet 在預覽後有變更。尚未匯入，請重新讀取並核對預覽。",
    ],
    SHEET_READER_UNAVAILABLE: [
      503,
      "系統讀表服務尚未就緒，請稍後重試或聯絡專人；這不代表你分享失敗。",
    ],
    SHEET_NOT_SHARED: [
      400,
      "目前讀不到這份 Sheet。請確認連結正確，並將檢視權限分享給頁面上的系統帳號。",
    ],
    SHEET_READ_FAILED: [503, "Google 暫時無法回應，請稍後重新檢查。"],
    SHEET_REVIEW_REQUIRED: [
      409,
      "申請仍待核對試算表使用權限。服務人員確認後會通知你繼續。",
    ],
    LINK_INVALID: [
      400,
      "連結已過期、已使用或帳號狀態已變更。請回登入頁申請新連結，或聯絡服務人員。",
    ],
    REGISTRATION_CLOSED: [
      403,
      "請先完成加入申請，並使用確認信中的連結設定帳號。",
    ],
    GOOGLE_UNAVAILABLE: [503, "此測試環境尚未設定 Google 授權。"],
    GOOGLE_CONNECT_FAILED: [400, "Google 授權未完成，請重新連線。"],
    GOOGLE_CONNECT_REQUIRED: [
      401,
      "請先連結自己的 Google 帳號；授權約一小時後需重新連線。",
    ],
    SHEET_UNAVAILABLE: [
      400,
      "無法讀取試算表，請確認 Google 帳號的存取權限與連結。",
    ],
    IMPORT_SIZE: [
      400,
      "每次可讀取最多 501 列、52 欄；請將資料整理成較小分頁再試。",
    ],
    IMPORT_EXPIRED: [409, "預覽已過期，請重新讀取試算表。"],
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
