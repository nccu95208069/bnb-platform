import { randomUUID } from "node:crypto";
import { readCalendarSources, type CalendarReadEvent } from "@/lib/booking-sources/calendar-reader";
import { configuredPrivateCalendarCache } from "@/lib/booking-sources/private-calendar-snapshot";
import { recordCalendarHealth } from "@/lib/booking-sources/calendar-diagnostics";
import { overlayPayments } from "@/lib/os-payments";
import { sourceDefinition, activeSources } from "@/lib/booking-sources/config";
import { NextResponse } from "next/server";
import { readSeedSnapshot, readBookingSnapshot } from "@/lib/booking-sources/snapshot";
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
    const source = sourceDefinition(new URL(request.url).searchParams.get("source") || "sweetfun");
    if (!activeSources().some(s => s.key === source.key)) return NextResponse.json({ code: "MONITOR_DISABLED" }, { status: 503 });
    const startedAt = Date.now(), requestId = randomUUID();
    let values: unknown[][] | undefined;
    const result = await runMonitor({ source, store: configuredStore(source), read: async () => { values = await readOperationalSheet(source); return values; }, seed: () => readSeedSnapshot(source) });
    // Independent replica refreshes every five minutes; the primary saves every successful check.
    const cache = configuredPrivateCalendarCache({ writeBackup: new Date(startedAt).getUTCMinutes() % 5 === 0 });
    if (result.status === "ok" && values && cache) {
      const events: CalendarReadEvent[] = [];
      try {
        // Reuse the successful Sheet read; never persist private fields in monitor state.
        // A new snapshot revision that no longer matches these values cannot be cached.
        await readCalendarSources([source], "0001-01-01", "9999-12-31", true, {
          cache, startedAt, snapshot: readBookingSnapshot, details: async () => values!, payments: overlayPayments,
          report: event => { events.push(event); console.info(JSON.stringify({ event: "calendar_backup_refresh", request_id: requestId, ...event })); },
        });
      } catch { console.warn(JSON.stringify({ event: "calendar_backup_unavailable", request_id: requestId, property_id: source.property.id })); }
      await recordCalendarHealth(events, requestId, startedAt);
    }
    return NextResponse.json(result, { status: result.status === "error" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ code: safeError(error) }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
// Human operators and Agents use the same authenticated, idempotent check contract.
export const POST = GET;
