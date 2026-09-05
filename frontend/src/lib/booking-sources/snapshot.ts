import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BookingSourceSnapshot } from "./sweetfun-sheet";

// Deployed as a private server artifact, never in public/ or version control.
export async function readBookingSnapshot(): Promise<BookingSourceSnapshot | null> {
  if (process.env.CALENDAR_SOURCE !== "sheet_snapshot") return null;
  const snapshot: BookingSourceSnapshot = JSON.parse(await readFile(path.join(process.cwd(), ".calendar-data/source-snapshot.json"), "utf8"));
  if (snapshot.schema_version !== 1 || !snapshot.source?.anonymized || !snapshot.source?.read_only || !Array.isArray(snapshot.bookings)) {
    throw new Error("INVALID_CALENDAR_SNAPSHOT");
  }
  return snapshot;
}
