import type { SheetSourceDefinition } from "../booking-sources/config.ts";
import { timingSafeEqual } from "node:crypto";
import { initialState, reconcile, publicSnapshot } from "./reconcile.ts";
import type { MonitorStore } from "./store.ts";
import type { BookingSourceSnapshot } from "../booking-sources/sweetfun-sheet.ts";

export function authorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 32 || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`), actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^(MONITOR_(STORAGE_CONFIG|STORAGE_INVALID|STORAGE_UNAVAILABLE|STORAGE_SIZE_LIMIT|GOOGLE_CONFIG|GOOGLE_AUTH|GOOGLE_READ|SOURCE_NOT_CONFIGURED|SOURCE_MISMATCH)|SHEET_(SCHEMA_MISMATCH|MISSING_ROW_ID|INVALID_DATE|INVALID_ROOM_NIGHT|EMPTY_SOURCE|IDENTITY_MISMATCH|GRID_UNSUPPORTED|INCOMPLETE_READ))$/.test(message) ? message : "MONITOR_CHECK_FAILED";
}
export async function runMonitor(deps: { store: MonitorStore; source?: SheetSourceDefinition; seed: () => Promise<BookingSourceSnapshot>; read: () => Promise<unknown[][]>; now?: () => string }) {
  const now = deps.now ?? (() => new Date().toISOString());
  const owner = await deps.store.acquire();
  if (!owner) return { status: "busy" as const };
  try {
    const current = await deps.store.read() ?? initialState(await deps.seed());
    let next;
    try { next = reconcile(current, await deps.read(), now(), deps.source); }
    catch (error) { next = { ...current, checkedAt: now(), error: safeError(error), pending: null }; }
    if (!await deps.store.commit(owner, next)) return { status: "superseded" as const };
    // Authoritative re-read after publication, not just a successful write response.
    const verified = await deps.store.read();
    if (!verified || verified.checkedAt !== next.checkedAt || verified.snapshot.source.snapshot_version !== next.snapshot.source.snapshot_version) throw new Error("MONITOR_STORAGE_UNAVAILABLE");
    return { status: next.error ? "error" as const : next.pending ? "confirming" as const : "ok" as const,
      sync: publicSnapshot(verified, now()).source.sync, version: verified.snapshot.source.snapshot_version };
  } finally {
    // An expiring fenced lock is safe if release fails. Never expose provider errors.
    await deps.store.release(owner).catch(() => undefined);
  }
}
