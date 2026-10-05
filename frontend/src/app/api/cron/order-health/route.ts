import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { RedisCustomerStore } from "@/lib/customer-workspaces/store";
import { backgroundAccess } from "@/lib/order-health/access";
import { configured, runPending } from "@/lib/order-health/service";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET ? Buffer.from(`Bearer ${process.env.CRON_SECRET}`) : null;
  const actual = Buffer.from(request.headers.get("authorization") || "");
  if (!expected || actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!configured()) return NextResponse.json({ enabled: false });
  try {
    const store = new RedisCustomerStore();
    return NextResponse.json(await runPending(store, (scope) => backgroundAccess(store, scope)));
  } catch {
    return NextResponse.json({ error: "Worker unavailable" }, { status: 503 });
  }
}
