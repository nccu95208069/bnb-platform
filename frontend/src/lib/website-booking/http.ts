import { NextRequest, NextResponse } from "next/server";
import { RedisCustomerStore } from "../customer-workspaces/store.ts";
import { record } from "./config.ts";
export const store = new RedisCustomerStore();
export const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", Vary: "Authorization" };
export function bearer(request: NextRequest) {
  const value = request.headers.get("authorization");
  return value && /^Bearer [A-Za-z0-9_.-]{32,256}$/.test(value) ? value.slice(7) : null;
}
export async function inputBody(request: NextRequest, limit = 32768) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw Error("INVALID_INPUT");
  const reader = request.body?.getReader();
  if (!reader) throw Error("INVALID_INPUT");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw Error("INVALID_INPUT"); }
    chunks.push(value);
  }
  try { return record(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { throw Error("INVALID_INPUT"); }
}
export function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const errors: Record<string, [number, string]> = {
    INVALID_INPUT: [400, "請確認輸入內容。"], UNAUTHORIZED: [401, "請先完成登入或服務授權。"],
    FORBIDDEN: [403, "沒有此操作的權限。"], NOT_FOUND: [404, "找不到這筆資料。"],
    WEBSITE_OWNER_MISMATCH: [403, "請使用這次連接指定的業主信箱登入並確認。"],
    WEBSITE_BOOKING_UNAVAILABLE: [503, "線上預訂尚未開放，既有訂单仍可查詢。"],
    BINDING_UNAVAILABLE: [503, "旅宿綁定需要重新核對。"],
    CONFIGURATION_CHANGED: [409, "設定或房價已更新，請重新查詢。"],
    PHYSICAL_MAPPING_CHANGED: [409, "實體房間對應已變更，請先完成庫存核對。"],
    LEGACY_INTEGRATION_REQUIRED: [409, "此旅宿需要先完成既有訂單與通路串接，才能開放官網收單。"],
    CONNECTION_EXPIRED: [410, "連接申請已過期，請回建站台重新申請。"],
    CONNECTION_SUPERSEDED: [409, "網站已核准更新設定，請回建站台查看目前連接。"],
    QUOTE_EXPIRED: [409, "報價已過期或已使用，請重新查詢房況。"],
    ROOM_CONFLICT: [409, "這個日期的房間已被預訂，請重新查詢。"],
    ROOM_TYPE_PRICE_CONFLICT: [409, "此房型的價格需要業主核對。"],
    PRICING_NOT_ENABLED: [409, "此旅宿尚未完成房價設定。"],
    VERSION_CONFLICT: [409, "房況或設定剛被更新，請重新核對。"],
    IDEMPOTENCY_CONFLICT: [409, "相同查詢碼已有不同內容，請查回原操作。"],
    SLUG_EXISTS: [409, "日曆網址代稱已被使用，請換一個。"],
    LIMIT_REACHED: [409, "已達服務容量，請聯絡管理員。"],
    RATE_LIMITED: [429, "操作較頻繁，請稍後再試。"],
    WRITE_UNCONFIRMED: [503, "結果尚未確認，請保留原查詢碼核對，勿重複建立。"],
    LOGIN_BROWSER_REQUIRED: [400, "請使用剛才申請連結的同一個瀏覽器。"],
    LOGIN_DELIVERY_UNCONFIRMED: [503, "登入信寄送結果尚未確認，請先查看信箱；重試只核對原寄信請求。"],
    LINK_INVALID: [400, "登入連結已過期，請重新申請。"],
    PAIRING_EXPIRED: [410, "LINE 配對碼已過期或無效，請回 OS 重新產生。"],
    OWNER_CONFIRMATION_REQUIRED: [400, "請由業主確認這次操作。"],
    HOLD_SCOPE_CONFIRMATION_REQUIRED: [400, "請確認本次操作的占房範圍。"],
    RECEIPT_CONFIRMATION_REQUIRED: [400, "請確認已實際收到款項。"],
    RECEIPT_ACCOUNT_REQUIRED: [400, "請選擇已設定的收款帳戶。"],
    OVERPAYMENT_CONFIRMATION_REQUIRED: [409, "收款超過待收金額，請另行確認。"],
    REFUND_TOO_LARGE: [409, "退款金額超過已收款。"],
    OPENING_BALANCE_REQUIRED: [409, "請先核對期初款項。"],
    HOLD_STATE_CONFLICT: [409, "訂單狀態已改變，請重新核對。"],
    HOLD_INTEGRATION_REQUIRED: [409, "此訂單需要先核對外部占房狀態。"],
    INVALID_HOLD_DEADLINE: [400, "請確認新的保留期限。"],
    CANCELLATION_REQUIRES_SETTLEMENT: [409, "此訂單已有款項，請先完成結算。"],
  };
  const [status, detail] = errors[code] ?? [503, "服務暫時無法確認結果，請保留原查詢碼。"];
  return NextResponse.json({ code: errors[code] ? code : "SERVICE_UNAVAILABLE", detail }, { status, headers });
}
