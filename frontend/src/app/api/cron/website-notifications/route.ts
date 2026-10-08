import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { RedisCustomerStore } from "@/lib/customer-workspaces/store";
import { enabled } from "@/lib/customer-workspaces/auth";
import { emailDeliveryBindings, emailDeliverySiteScopes, runWebsiteEmailDelivery, runWebsiteExpiryReminders } from "@/lib/website-booking/delivery";

export const runtime = "nodejs";
export const maxDuration = 300;
const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET ? Buffer.from(`Bearer ${process.env.CRON_SECRET}`) : null;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  // Authenticate the scheduler solely with its dedicated bearer secret. Proxy
  // cookies/origin headers neither grant access nor invalidate an authentic cron.
  if (!expected || actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return NextResponse.json({ schemaVersion: 1, code: "UNAUTHORIZED" }, { status: 401, headers });
  const emailEnabled = process.env.WEBSITE_BOOKING_EMAIL_DELIVERY_ENABLED === "true";
  const expiryEnabled = process.env.WEBSITE_BOOKING_EXPIRY_REMINDERS_ENABLED === "true";
  if (!enabled() || (!emailEnabled && !expiryEnabled))
    return NextResponse.json({ schemaVersion: 1, enabled: false }, { headers });
  try {
    const store = new RedisCustomerStore(), bindings = emailDeliveryBindings(), siteScopes = emailDeliverySiteScopes();
    const expiry = expiryEnabled ? await runWebsiteExpiryReminders(store, bindings, { siteScopes }) : { bindings: 0, queued: 0 };
    const result = emailEnabled ? await runWebsiteEmailDelivery(store, bindings, { siteScopes, enqueueExpired: false }) : { schemaVersion: 1, processed: 0, sent: 0, unknown: 0, pending: 0, scanned: 0 };
    return NextResponse.json({ ...result, enabled: true, emailEnabled, expiryEnabled, expiry }, { headers, status: result.pending ? 503 : 200 });
  } catch {
    return NextResponse.json({ schemaVersion: 1, code: "EMAIL_DELIVERY_UNAVAILABLE" }, { status: 503, headers });
  }
}
