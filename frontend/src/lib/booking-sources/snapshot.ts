import { SWEETFUN_SOURCE, type SheetSourceDefinition } from "./config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BookingSourceSnapshot } from "./sweetfun-sheet";
import { configuredStore } from "../sheet-monitor/store";
import { initialState, publicSnapshot } from "../sheet-monitor/reconcile";

// Deployed as a private server artifact, never in public/ or version control.
export async function readBookingSnapshot(source: SheetSourceDefinition = SWEETFUN_SOURCE): Promise<BookingSourceSnapshot | null> {
  if (process.env.CALENDAR_SOURCE !== "sheet_snapshot") return null;
  if (process.env.SHEET_MONITOR_ENABLED === "true") {
    // Storage outages fail closed. Never replace a newer live snapshot with an old
    // bundled seed. The browser retains its last successfully loaded data on errors.
    const state = await configuredStore(source).read() ?? initialState(await readSeedSnapshot(source));
    return publicSnapshot(state, new Date().toISOString());
  }
  return readSeedSnapshot(source);
}

export async function readSeedSnapshot(source: SheetSourceDefinition = SWEETFUN_SOURCE): Promise<BookingSourceSnapshot> {
  const snapshot: BookingSourceSnapshot = JSON.parse(await readFile(path.join(process.cwd(), ".calendar-data", source.snapshotFile), "utf8"));
  if (snapshot.schema_version !== 1 || !snapshot.source?.anonymized || !snapshot.source?.read_only || !Array.isArray(snapshot.bookings)) {
    throw new Error("INVALID_CALENDAR_SNAPSHOT");
  }
  if (snapshot.source.id !== source.sourceId || snapshot.bookings.some(b => b.property_id !== source.property.id || !source.property.rooms.some(r => r.id === b.room_id))) throw new Error("MONITOR_SOURCE_MISMATCH");
  return snapshot;
}
