import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BookingSourceSnapshot } from "./sweetfun-sheet";
import { configuredStore } from "../sheet-monitor/store";
import { initialState, publicSnapshot } from "../sheet-monitor/reconcile";

// Deployed as a private server artifact, never in public/ or version control.
export async function readBookingSnapshot(): Promise<BookingSourceSnapshot | null> {
  if (process.env.CALENDAR_SOURCE !== "sheet_snapshot") return null;
  if (process.env.SHEET_MONITOR_ENABLED === "true") {
    // Storage outages fail closed. Never replace a newer live snapshot with an old
    // bundled seed. The browser retains its last successfully loaded data on errors.
    const state = await configuredStore().read() ?? initialState(await readSeedSnapshot());
    return publicSnapshot(state, new Date().toISOString());
  }
  return readSeedSnapshot();
}

export async function readSeedSnapshot(): Promise<BookingSourceSnapshot> {
  const snapshot: BookingSourceSnapshot = JSON.parse(await readFile(path.join(process.cwd(), ".calendar-data/source-snapshot.json"), "utf8"));
  if (snapshot.schema_version !== 1 || !snapshot.source?.anonymized || !snapshot.source?.read_only || !Array.isArray(snapshot.bookings)) {
    throw new Error("INVALID_CALENDAR_SNAPSHOT");
  }
  return snapshot;
}
