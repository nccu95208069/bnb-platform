import { NextRequest, NextResponse } from "next/server";
import { headers, inputBody, store } from "@/lib/website-booking/http";
import { sourceOwnerCommand, sourceOwnerRead } from "@/lib/customer-sources/owner-actions";

export const runtime = "nodejs";
const statuses: Record<string, number> = {
  INVALID_INPUT: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404,
  VERSION_CONFLICT: 409, SOURCE_COVERAGE: 409, CALENDAR_SOURCE_OWNS_OCCUPANCY: 409,
  IMPORT_INCOMPLETE: 409, ROOM_CONFLICT: 409, ORDER_UNVERIFIED: 409,
  PREVIEW_CHANGED: 409, IDEMPOTENCY_CONFLICT: 409, CONNECTION_EXPIRED: 410,
  CANCELLATION_REQUIRES_SETTLEMENT: 409, LIMIT_REACHED: 409, RATE_LIMITED: 429,
  WRITE_UNCONFIRMED: 503, SOURCES_UNAVAILABLE: 503,
};
function failed(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  return NextResponse.json({ code: code in statuses ? code : "SOURCES_UNAVAILABLE" },
    { status: statuses[code] ?? 503, headers });
}
export async function POST(request: NextRequest) {
  try {
    const input = await inputBody(request, 12288);
    const result = input.action === "preview" || input.action === "commit" ?
      await sourceOwnerCommand(store, input, request.headers.get("authorization")) :
      await sourceOwnerRead(store, input, request.headers.get("authorization"));
    return NextResponse.json(result, { headers });
  } catch (error) { return failed(error); }
}
