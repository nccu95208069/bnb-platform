import { NextRequest, NextResponse } from "next/server";
import { store, headers, inputBody } from "@/lib/website-booking/http";
import { mutateSourceBooking, sourceBookingLink, sourceBookingStatus } from "@/lib/customer-sources/bookings";

export const runtime = "nodejs";
const statuses: Record<string, number> = { INVALID_INPUT:400, UNAUTHORIZED:401, FORBIDDEN:403,
  NOT_FOUND:404, IDEMPOTENCY_CONFLICT:409, VERSION_CONFLICT:409, SOURCE_CONFLICT:409,
  SOURCE_VERSION_CONFLICT:409, SOURCE_UPDATE_CONFLICT:409, SOURCE_UPDATE_CONTRACT_REQUIRED:409,
  ROOM_CONFLICT:409, WRITE_UNCONFIRMED:503, RATE_LIMITED:429, LIMIT_REACHED:409,
  SOURCES_UNAVAILABLE:503 };
function failed(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  return NextResponse.json({ code: code in statuses ? code : "SOURCES_UNAVAILABLE" },
    { status: statuses[code] ?? 503, headers });
}
export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams, grantId = query.get("grant_id"), auth = request.headers.get("authorization");
    const result = query.has("request_key") ?
      await sourceBookingStatus(store, grantId, auth, query.get("request_key")) :
      await sourceBookingLink(store, grantId, Number(query.get("grant_version")), auth,
        query.get("source_account"), query.get("external_order_id"));
    return NextResponse.json(result, { headers });
  } catch (error) { return failed(error); }
}
export async function POST(request: NextRequest) {
  try {
    return NextResponse.json(await mutateSourceBooking(store, await inputBody(request, 8192),
      request.headers.get("authorization")), { headers });
  } catch (error) { return failed(error); }
}
