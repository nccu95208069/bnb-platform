import { NextResponse } from "next/server";
import { readSeedSnapshot } from "@/lib/booking-sources/snapshot";
import { readOperationalSheet } from "@/lib/sheet-monitor/google";
import { configuredStore } from "@/lib/sheet-monitor/store";
import { authorized, runMonitor, safeError } from "@/lib/sheet-monitor/runner";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!authorized(request.headers.get("authorization"), process.env.CRON_SECRET)) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 });
  if (process.env.SHEET_MONITOR_ENABLED !== "true" || process.env.CALENDAR_SOURCE !== "sheet_snapshot") return NextResponse.json({ code: "MONITOR_DISABLED" }, { status: 503 });
  try {
    const result = await runMonitor({ store: configuredStore(), read: readOperationalSheet, seed: readSeedSnapshot });
    return NextResponse.json(result, { status: result.status === "error" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ code: safeError(error) }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
// Human operators and Agents use the same authenticated, idempotent check contract.
export const POST = GET;
