import { NextRequest, NextResponse } from "next/server";
import { available, store } from "@/lib/customer-workspaces/http";
import { acceptTenantEvent, eventClient, eventReceipt } from "@/lib/customer-events/contract";

export const runtime = "nodejs";
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const errors: Record<string, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  IDEMPOTENCY_CONFLICT: 409,
  SOURCE_NOT_VERIFIED: 409,
  VERSION_CONFLICT: 409,
  RATE_LIMITED: 429,
  EVENTS_UNAVAILABLE: 503,
  FEATURE_UNAVAILABLE: 503,
};
function failure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  return NextResponse.json(
    { code: code in errors ? code : "EVENTS_UNAVAILABLE" },
    { status: errors[code] ?? 503, headers },
  );
}
async function json(request: NextRequest) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? ""))
    throw new Error("INVALID_INPUT");
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > 8192))
    throw new Error("INVALID_INPUT");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("INVALID_INPUT");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) {
      await reader.cancel();
      throw new Error("INVALID_INPUT");
    }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("INVALID_INPUT"); }
}
export async function POST(request: NextRequest) {
  try {
    available();
    const client = eventClient(request.headers.get("authorization"));
    return NextResponse.json(await acceptTenantEvent(store, client, await json(request)), { headers });
  } catch (error) { return failure(error); }
}
export async function GET(request: NextRequest) {
  try {
    available();
    const client = eventClient(request.headers.get("authorization"));
    return NextResponse.json(
      await eventReceipt(store, client, request.nextUrl.searchParams.get("event_id") ?? ""),
      { headers },
    );
  } catch (error) { return failure(error); }
}
