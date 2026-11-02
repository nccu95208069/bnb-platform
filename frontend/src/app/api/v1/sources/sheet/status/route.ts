import { sourceDefinition } from "@/lib/booking-sources/config";
import { NextResponse } from "next/server";
import { authorized, safeError } from "@/lib/sheet-monitor/runner";
import { configuredStore } from "@/lib/sheet-monitor/store";
import { publicSnapshot } from "@/lib/sheet-monitor/reconcile";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  if (!authorized(request.headers.get("authorization"), process.env.CRON_SECRET)) return NextResponse.json({ code: "UNAUTHORIZED" }, { status: 401 });
  if (process.env.SHEET_MONITOR_ENABLED !== "true") return NextResponse.json({ enabled: false });
  try {
    const source = sourceDefinition(new URL(request.url).searchParams.get("source") || "sweetfun");
    const state = await configuredStore(source).read();
    return NextResponse.json({ enabled: true, sync: state ? publicSnapshot(state, new Date().toISOString()).source.sync : null, audit: state?.audit ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return NextResponse.json({ code: safeError(error) }, { status: 503 }); }
}
