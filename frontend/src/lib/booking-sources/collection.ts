import type { SheetSourceDefinition } from "./config.ts";
import type { BookingSourceSnapshot } from "./sweetfun-sheet.ts";

// A failed property never removes a successfully loaded property's bookings.
// Failed sources are explicitly unavailable, not represented as empty inventory.
export async function collectSnapshots(sources: SheetSourceDefinition[], read: (source: SheetSourceDefinition) => Promise<BookingSourceSnapshot | null>) {
  const results = await Promise.allSettled(sources.map(source => read(source)));
  const snapshots: { definition: SheetSourceDefinition; snapshot: BookingSourceSnapshot }[] = [];
  const errors: { property_id: string; label: string }[] = [];
  for (const [i, result] of results.entries()) {
    const definition = sources[i];
    if (result.status === "fulfilled" && result.value) snapshots.push({ definition, snapshot: result.value });
    else errors.push({ property_id: definition.property.id, label: definition.property.sourceLabel });
  }
  if (!snapshots.length) throw new Error("CALENDAR_SOURCES_UNAVAILABLE");
  return { snapshots, errors };
}
