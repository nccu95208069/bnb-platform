import { NextRequest, NextResponse } from "next/server";
import { headers, principal, store } from "@/lib/customer-workspaces/http";
import { ironGateReadConfig, readIronGateBooking } from "@/lib/customer-workspaces/iron-gate-read.server";

export const runtime = "nodejs";
type Context = { params: Promise<{ slug: string; propertyId: string; bookingId: string }> };

/** Read-only shadow endpoint. The existing OS booking store remains authoritative. */
export async function GET(request: NextRequest, context: Context) {
  try {
    const account = await principal(request);
    const { slug, propertyId, bookingId } = await context.params;
    await store.limit(`iron-gate-shadow:${account.id}`, 300);
    const booking = await readIronGateBooking(store, account.id, slug, propertyId,
      bookingId, ironGateReadConfig());
    return NextResponse.json(booking, { headers });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const status = code === "NOT_FOUND" ? 404 : code === "FORBIDDEN" ? 403 :
      code === "INVALID_INPUT" ? 400 :
      ["IRON_GATE_READ_CONFIG_INVALID", "FEATURE_UNAVAILABLE"].includes(code) ? 503 :
      code === "IRON_GATE_READ_FAILED" ? 502 : 401;
    return NextResponse.json({ error: { code: status === 502 ? "UPSTREAM_UNAVAILABLE" :
      status === 503 ? "FEATURE_UNAVAILABLE" : status === 401 ? "UNAUTHORIZED" : code } },
    { status, headers });
  }
}
