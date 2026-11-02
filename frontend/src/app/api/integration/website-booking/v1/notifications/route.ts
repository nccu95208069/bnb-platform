import { NextRequest, NextResponse } from "next/server";
import { digest, enabled } from "@/lib/customer-workspaces/auth";
import { RedisCustomerStore } from "@/lib/customer-workspaces/store";
import { notificationOperation, notificationWorker } from "@/lib/website-booking/notifications";

export const runtime = "nodejs";
const store = new RedisCustomerStore();
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", Vary: "Authorization" };
const errors: Record<string, number> = {
  INVALID_INPUT: 400, PROVIDER_PROOF_REQUIRED: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  NOTIFICATION_ACK_CONFLICT: 409, NOTIFICATION_CLAIM_CONFLICT: 409, VERSION_CONFLICT: 409, RATE_LIMITED: 429,
  WEBSITE_BOOKING_UNAVAILABLE: 503, WRITE_UNCONFIRMED: 503,
};
async function body(request: NextRequest) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw Error("INVALID_INPUT");
  const reader = request.body?.getReader();
  if (!reader) throw Error("INVALID_INPUT");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 4096) { await reader.cancel(); throw Error("INVALID_INPUT"); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Error("INVALID_INPUT"); }
}
export async function POST(request: NextRequest) {
  try {
    if (!enabled()) throw Error("WEBSITE_BOOKING_UNAVAILABLE");
    await store.limit(`website-notification-auth:${digest(request.headers.get("x-vercel-forwarded-for") || "shared")}`, 1200);
    if (request.headers.has("cookie") || request.headers.has("origin")) throw Error("UNAUTHORIZED");
    const authorization = request.headers.get("authorization");
    const worker = notificationWorker(authorization?.match(/^Bearer ([A-Za-z0-9._~+/-]+=*)$/)?.[1] ?? null);
    const result = await notificationOperation(store, worker, await body(request));
    return NextResponse.json(result, { headers });
  } catch (error) {
    const known = error instanceof Error && Object.hasOwn(errors, error.message) ? error.message : "SERVICE_UNAVAILABLE";
    return NextResponse.json({ schemaVersion: 1, code: known }, { status: errors[known] ?? 503, headers });
  }
}
