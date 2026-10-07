import { NextRequest, NextResponse } from "next/server";
import { authenticate, CUSTOMER_COOKIE, digest, enabled } from "./auth.ts";
import { RedisCustomerStore } from "./store.ts";
import { standardSheetErrors } from "./standard-sheet-messages.ts";
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
export async function body(request: NextRequest, limit = 128000) {
  available();
  if (request.headers.get("origin") !== request.nextUrl.origin)
    throw new Error("FORBIDDEN");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_INPUT");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("INVALID_INPUT");
    }
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
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
    HOLD_ACTION_REQUIRED: [409, "請使用保留單操作，核對收款後再轉正式訂單。"],
  HOLDS_UNAVAILABLE: [503, "保留單功能尚未開放。"],
    HOLD_SCOPE_CONFIRMATION_REQUIRED: [400, "請確認本次只在 OS 占房，尚未同步外部通路或發送通知。"],
    HOLD_TOTAL_REQUIRED: [400, "建立保留前請填寫完整房費總額。"],
    HOLD_INTEGRATION_REQUIRED: [409, "此保留需要完成來源串接與核對後才能操作。"],
    HOLD_STATE_CONFLICT: [409, "保留狀態已改變，請重新載入後核對。"],
    INVALID_HOLD_DEADLINE: [400, "新期限必須晚於目前期限與現在，且不超過一年。"],
    RECEIPT_CONFIRMATION_REQUIRED: [400, "請先核對並確認實際收到或退還的金額。"],
    RECEIPT_ACCOUNT_REQUIRED: [400, "匯款或刷卡請選擇旅宿收款帳戶。"],
    BOOKING_SOURCE_IMMUTABLE: [409, "官網訂單必須保留 Official Website 來源；其他操作管道不會改變來源。"],
    ...standardSheetErrors,
    CALENDAR_PREVIEW_REQUIRED: [
      409,
      "暫存預覽已過期或不在這個瀏覽器。請回加入頁重新選檔；尚未保存的資料會在一小時後清除。",
    ],
    CALENDAR_PREVIEW_LOCKED: [
      409,
      "這份預覽正在確認保存。請先返回調整，再產生新預覽。",
    ],
    CALENDAR_ACCOUNT_CHANGED: [
      409,
      "登入帳號與本次確認的信箱不同。請使用畫面上確認的帳號，再保存預覽。",
    ],
    LOGIN_BROWSER_REQUIRED: [
      400,
      "請使用剛才申請登入連結的同一個瀏覽器；若已更換瀏覽器，請重新申請登入連結。",
    ],
    GOOGLE_SIGNIN_FAILED: [
      400,
      "Google 登入未完成或身分驗證失敗，請重新嘗試。",
    ],
    GOOGLE_ACCOUNT_NOT_FOUND: [
      400,
      "此 Google 帳號尚未加入。請先從加入頁開始預覽日曆。",
    ],
    GOOGLE_EMAIL_CHALLENGE_REQUIRED: [
      400,
      "此 Google 帳號的信箱需要另外確認，請改用信箱登入連結。",
    ],
    CALENDAR_GOOGLE_UNAVAILABLE: [
      503,
      "此環境尚未設定 Google 日曆授權，請先使用日曆檔匯入。",
    ],
    CALENDAR_SYNC_UNAVAILABLE: [
      409,
      "持續同步尚未啟用，請選擇一次搬入，或聯絡管理員完成設定。",
    ],
    CALENDAR_CONNECT_REQUIRED: [
      401,
      "Google 日曆授權已失效或權限不足，請重新連結有權讀取日曆的帳號。",
    ],
    CALENDAR_READ_FAILED: [
      503,
      "Google 日曆暫時無法讀取，請稍後重試。原有房況會保留。",
    ],
    CALENDAR_GRANT_OWNER: [
      403,
      "請由原先授權 Google 日曆的管理員讀取；若需更換帳號，請重新連結並核對來源。",
    ],
    CALENDAR_SOURCE_OWNS_OCCUPANCY: [
      409,
      "本館正在同步 Google 日曆。新增、調整住宿或取消，請先在 Google 日曆操作，再回來核對。",
    ],
    CALENDAR_SOURCE_EXISTS: [
      409,
      "這個日曆已匯入，請選擇更新既有來源，避免重複。",
    ],
    CALENDAR_SOURCE_CHANGED: [
      409,
      "日曆來源與預覽不同，請重新讀取同一組日曆，再核對預覽。",
    ],
    CALENDAR_RELINK_REQUIRED: [
      409,
      "跨來源連結需逐一核對日曆。請一次更新一個日曆來源，或聯絡管理員。",
    ],
    CALENDAR_EXPIRED: [409, "日曆預覽已過期，請重新讀取來源。"],
    CALENDAR_SIZE: [
      400,
      "日曆資料超過上限：檔案 3 MB、解壓後 8 MB、最多 30 個日曆與 2,000 個活動。請縮小日期範圍或分批匯出。",
    ],
    CALENDAR_FORMAT: [
      400,
      "無法完整讀取這個日曆檔。請重新匯出 ICS 或包含 ICS 的 ZIP。",
    ],
    CALENDAR_DUPLICATE_SOURCE: [
      400,
      "來源包含重複的日曆或活動識別，請分開核對並重新匯出。",
    ],
    CALENDAR_TIMEZONE: [400, "請填有效的旅宿時區，例如 Asia/Taipei。"],
    CALENDAR_RANGE: [400, "請選擇不超過兩年的日期範圍；末日需晚於起日。"],
    CALENDAR_DATE: [400, "活動日期或時區無法確定，請核對原始日曆。"],
    CALENDAR_IGNORE_REASON: [400, "排除活動時請填原因，並確認它不占用房間。"],
    CALENDAR_CHANGES_CONFIRM: [400, "請先勾選確認既有記錄的變更或取消。"],

    SOURCE_COVERAGE: [
      409,
      "此日期不在已核對的匯入範圍內。請先匯入涵蓋該日期的完整訂單；未顯示資料不能直接視為空房。",
    ],
    SOURCE_EMAIL_UNVERIFIED: [403, "請先確認登入信箱，再連結試算表。"],
    SOURCE_LOCKED: [
      409,
      "此旅宿已綁定其他來源，請先聯絡專人核對，避免混入另一館資料。",
    ],
    INVITATION_INVALID: [
      400,
      "邀請已過期、撤回或帳號狀態已變更。請業主重新邀請。",
    ],
    INVITATION_EXISTS: [
      409,
      "這個信箱已有待接受的邀請；如需更改權限，請先撤回原邀請。",
    ],
    MEMBER_EXISTS: [409, "這個帳號已是成員，請在成員列表調整權限或重新啟用。"],
    RATE_CONFLICT: [409, "同一房間的指定日期房價重疊，請先調整日期範圍。"],
    PRICING_NOT_ENABLED: [400, "請先到房價設定填寫價格並開啟價格顯示。"],
    OVERPAYMENT_CONFIRMATION_REQUIRED: [
      409,
      "這筆金額會超過訂單應收。請核對金額；若確定是溢收，勾選確認後再送出。",
    ],
    OPENING_BALANCE_REQUIRED: [
      409,
      "匯入前的實收金額尚未確認，請先由管理員核對期初實收。",
    ],
    OPENING_ALREADY_CONFIRMED: [
      409,
      "期初實收已確認，不能覆寫。新的收退款請逐筆登記。",
    ],
    REFUND_TOO_LARGE: [400, "退款不能超過已確認的實收餘額。"],
    FUTURE_RECEIPT: [
      400,
      "收退款時間不能填未來時間；尚未收到的款項請勿登記為實收。",
    ],
    ORDER_CANCELLED: [409, "這筆訂單已取消，不能再登記收款或修改應收。"],
    CANCELLATION_REQUIRES_SETTLEMENT: [
      409,
      "請先確認實收並完成退款登記，再取消訂單。",
    ],
    IMPORT_INCOMPLETE: [
      409,
      "資料尚未完整，未顯示訂單的日期不能視為空房。請先完成匯入與問題資料核對。",
    ],
    FORMAT_CONFIRMATION_REQUIRED: [
      400,
      "請先確認紀錄方式、欄位與房間對應，再匯入。",
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
    SHEET_REVIEW_REQUIRED: [409, "請先完成帳號啟用，再重新讀取來源。"],
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
    UNAUTHORIZED: [
      401,
      "請重新登入，再繼續操作；若登入失敗，請確認信箱及使用的登入方式。",
    ],
    ACCOUNT_EXISTS: [409, "此信箱無法建立新帳號，請嘗試登入。"],
    PASSWORD_INVALID: [400, "請使用 12～128 字元的密碼，並確認兩次輸入相同。"],
    TAG_EXISTS: [409, "已有相同名稱或月曆縮寫的標籤，請使用其他文字。"],
    ACCOUNT_DUPLICATE: [409, "已有相同名稱與末碼的收款帳戶，請直接選取。"],
    INVALID_INPUT: [400, "請檢查房間、日期及輸入內容。"],
    FORBIDDEN: [403, "目前帳號沒有操作權限。"],
    NOT_FOUND: [404, "找不到有權限存取的旅宿。"],
    SLUG_EXISTS: [409, "網址代稱已被使用，請換一個。"],
    VERSION_CONFLICT: [409, "資料剛被更新，請重新載入並核對後再儲存。"],
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
