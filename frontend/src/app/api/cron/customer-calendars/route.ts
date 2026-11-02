import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { enabled } from "@/lib/customer-workspaces/auth";
import { RedisCustomerStore } from "@/lib/customer-workspaces/store";
import { runCalendarJobs } from "@/lib/customer-workspaces/calendar-jobs";
import { calendarSyncReady } from "@/lib/customer-workspaces/calendar-google";
import { synchronizeCalendarWorkspace } from "@/lib/customer-workspaces/calendar-sync";
import { scheduleStandardSheetSync } from "@/lib/customer-workspaces/standard-sheet-jobs";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET
      ? Buffer.from(`Bearer ${process.env.CRON_SECRET}`)
      : null,
    actual = Buffer.from(request.headers.get("authorization") ?? "");
  if (
    !expected ||
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  )
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!enabled() || !calendarSyncReady())
    return NextResponse.json({ enabled: false });
  try {
    const store = new RedisCustomerStore();
    return NextResponse.json(
      await runCalendarJobs(store, async (target, deadline) => {
        await synchronizeCalendarWorkspace(store, target, deadline);
        await scheduleStandardSheetSync(store, target.workspaceId);
      }),
    );
  } catch {
    return NextResponse.json({ error: "Sync unavailable" }, { status: 503 });
  }
}
