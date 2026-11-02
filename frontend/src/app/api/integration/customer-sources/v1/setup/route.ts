import { NextRequest, NextResponse } from "next/server";
import { store, headers, inputBody } from "@/lib/website-booking/http";
import { exchangeSourceCode, sourceClient } from "@/lib/customer-sources/grants";

export const runtime = "nodejs";
const statuses: Record<string, number> = { INVALID_INPUT:400, UNAUTHORIZED:401, FORBIDDEN:403,
  CONNECTION_EXPIRED:410, IDEMPOTENCY_CONFLICT:409, VERSION_CONFLICT:409,
  WRITE_UNCONFIRMED:503, RATE_LIMITED:429, LIMIT_REACHED:409, SOURCES_UNAVAILABLE:503 };
export async function POST(request: NextRequest) {
  try {
    const client = sourceClient(request.headers.get("authorization"));
    await store.limit(`source-exchange:${client.id}`, 300);
    return NextResponse.json(await exchangeSourceCode(store, client, await inputBody(request, 8192)), { headers });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return NextResponse.json({ code: code in statuses ? code : "SOURCES_UNAVAILABLE" },
      { status: statuses[code] ?? 503, headers });
  }
}
