import { NextRequest, NextResponse } from "next/server";
import { RedisCustomerStore } from "@/lib/customer-workspaces/store";
import { digest } from "@/lib/customer-workspaces/auth";
import { headers } from "@/lib/customer-workspaces/http";
import { intakeEnabled, intakePreview } from "@/lib/customer-intake/config";
import { intakeAnswers, submitIntake } from "@/lib/customer-intake/service";
import { sendOperatorIntakeNotification } from "@/lib/workspace-auth/mail";
export const runtime = "nodejs";
const store = new RedisCustomerStore();
const errors: Record<string, [number, string]> = {
  FEATURE_UNAVAILABLE: [
    503,
    "線上申請目前尚未開放。你仍可使用頁面上的 Email 聯絡我們。",
  ],
  FORBIDDEN: [403, "請從服務頁重新送出。"],
  INVALID_INPUT: [400, "請確認聯絡方式、旅宿資料與聯絡同意。"],
  SHEET_LINK_INVALID: [400, "請貼上 Google Sheet 的完整檔案連結。"],
  JOIN_INCOMPLETE: [
    400,
    "請填妥旅宿、房間與 Sheet 連結，並確認已分享；也可以改選專人諮詢。",
  ],
  RATE_LIMITED: [
    429,
    "短時間內送出較多需求，請稍後再試，或直接 Email 聯絡我們。",
  ],
  IDEMPOTENCY_CONFLICT: [
    409,
    "這份需求已送出不同內容，請保留申請編號並聯絡我們。",
  ],
  VERSION_CONFLICT: [409, "同一份需求正在處理中，請稍後重試，勿重複填寫。"],
};
export async function POST(request: NextRequest) {
  try {
    if (!intakeEnabled()) throw new Error("FEATURE_UNAVAILABLE");
    if (request.headers.get("origin") !== request.nextUrl.origin)
      throw new Error("FORBIDDEN");
    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > 20000) throw new Error("INVALID_INPUT");
    await store.limit(
      `intake:ip:${digest(request.headers.get("x-vercel-forwarded-for") || "shared")}`,
      20,
    );
    const raw = await request.text();
    if (raw.length > 20000) throw new Error("INVALID_INPUT");
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(raw);
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error();
    } catch {
      throw new Error("INVALID_INPUT");
    }
    const answers = intakeAnswers(input);
    await store.limit(`intake:email:${digest(answers.email)}`, 5);
    await store.limit("intake:global", 100);
    const result = await submitIntake(store, input, ({ subject, text }) =>
      sendOperatorIntakeNotification(subject, text),
    );
    return NextResponse.json(
      { ...result, ...(intakePreview() ? { preview: true } : {}) },
      { status: 201, headers },
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const [status, detail] = errors[code] ?? [
      503,
      "目前無法確認送出結果。請保留本頁，稍後按同一個按鈕重試；不要另開一份需求。",
    ];
    return NextResponse.json(
      { code: errors[code] ? code : "WRITE_UNCONFIRMED", detail },
      { status, headers },
    );
  }
}
