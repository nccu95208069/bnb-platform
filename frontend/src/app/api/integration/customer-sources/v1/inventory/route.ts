import { NextRequest, NextResponse } from "next/server";
import { store, headers, inputBody } from "@/lib/website-booking/http";
import { acquireInventoryGuard, inventoryStatus, recordInventoryVerified } from "@/lib/customer-sources/inventory";

export const runtime = "nodejs";
const statuses: Record<string, number> = { INVALID_INPUT:400, UNAUTHORIZED:401, FORBIDDEN:403,
  NOT_FOUND:404, IDEMPOTENCY_CONFLICT:409, VERSION_CONFLICT:409, ROOM_CONFLICT:409,
  FENCE_CONFLICT:409, SOURCE_READBACK_REQUIRED:409,
  WRITE_UNCONFIRMED:503, RATE_LIMITED:429, LIMIT_REACHED:409, SOURCES_UNAVAILABLE:503 };
function failed(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  return NextResponse.json({ code: code in statuses ? code : "SOURCES_UNAVAILABLE" },
    { status: statuses[code] ?? 503, headers });
}
export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(await inventoryStatus(store, request.nextUrl.searchParams.get("grant_id"),
      request.headers.get("authorization"), request.nextUrl.searchParams.get("operation_key")), { headers });
  } catch (error) { return failed(error); }
}
export async function POST(request: NextRequest) {
  try {
    const input = await inputBody(request, 32768), auth = request.headers.get("authorization");
    const result = input.action === "acquire_guard" ? await acquireInventoryGuard(store, input, auth) :
      await recordInventoryVerified(store, input, auth);
    return NextResponse.json(result, { headers });
  } catch (error) { return failed(error); }
}
