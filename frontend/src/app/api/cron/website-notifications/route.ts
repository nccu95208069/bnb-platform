import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { RedisCustomerStore } from "@/lib/customer-workspaces/store";
import { enabled } from "@/lib/customer-workspaces/auth";
import { emailDeliveryBindings, emailDeliverySiteScopes, runWebsiteEmailDelivery } from "@/lib/website-booking/delivery";

export const runtime = "nodejs";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET ? Buffer.from(`Bearer ${process.env.CRON_SECRET}`) : null;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  if (!expected || actual.length !== expected.length || !timingSafeEqual(actual, expected) || request.headers.has("cookie") || request.headers.has("origin"))
    return NextResponse.json({ schemaVersion: 1, code: "UNAUTHORIZED" }, { status: 401, headers });
  if (!enabled() || process.env.WEBSITE_BOOKING_EMAIL_DELIVERY_ENABLED !== "true")
    return NextResponse.json({ schemaVersion: 1, enabled: false }, { headers });
  try {
    const result = await runWebsiteEmailDelivery(new RedisCustomerStore(), emailDeliveryBindings(), { siteScopes: emailDeliverySiteScopes() });
    return NextResponse.json({ ...result, enabled: true }, { headers, status: result.pending ? 503 : 200 });
  } catch {
    return NextResponse.json({ schemaVersion: 1, code: "EMAIL_DELIVERY_UNAVAILABLE" }, { status: 503, headers });
  }
}
