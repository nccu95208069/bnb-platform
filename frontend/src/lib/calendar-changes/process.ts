import { validatePricingSnapshot } from '../pricing-snapshot.ts';
import { decode, encode, mergeChange, readChannelInventory } from './merge.ts';
import type { ChangeReceipt, ChangeStore, LoadedChange } from './store.ts';

export type BookingCheck = { status: 'ok' | 'busy' | 'superseded' | 'error' | 'confirming'; version?: string };
export type ChangeDependencies = { store: ChangeStore; checkBookings: (property: string) => Promise<BookingCheck>; now?: () => Date };
export const terminal = (receipt: ChangeReceipt) => !['queued', 'awaiting_source'].includes(receipt.status);
const safeError = (error: unknown) => error instanceof Error && /^(CHANGE_STORAGE_(INVALID|LIMIT)|INVALID_PRICING_(SNAPSHOT|CELL)|PRICING_PROPERTY_MISMATCH)$/.test(error.message) ? error.message : 'CHANGE_CHECK_FAILED';

// HTTP deliveries and the recovery cron share this processor. Only the booking
// source is re-read here; price and inventory events carry the producer's readback.
export async function processChange(input: LoadedChange, deps: ChangeDependencies): Promise<ChangeReceipt> {
  if (terminal(input.value.receipt)) return input.value.receipt;
  const { store } = deps, now = deps.now ?? (() => new Date());
  const event = input.value.event;
  const owner = await store.acquire(event.property_id);
  if (!owner) return input.value.receipt;
  try {
    const loaded = await store.read(event.property_id, input.value.receipt.client_id, event.event_id);
    if (!loaded) throw Error('CHANGE_STORAGE_INVALID');
    if (terminal(loaded.value.receipt) || Date.parse(loaded.value.receipt.next_check_at ?? '') > now().getTime()) return loaded.value.receipt;
    const at = now().toISOString();
    const receipt: ChangeReceipt = { ...loaded.value.receipt, attempts: loaded.value.receipt.attempts + 1, checked_at: at, error_code: null };
    let bookingReady = !event.changes.includes('booking');
    let merged: ReturnType<typeof mergeChange> | undefined;
    let rawPrices: string | null = null, rawInventory: string | null = null;
    try {
      if (!bookingReady) {
        const checked = await deps.checkBookings(event.property_id);
        bookingReady = checked.status === 'ok';
        receipt.booking_version = checked.version ?? null;
        if (!bookingReady) receipt.error_code = `BOOKING_${checked.status.toUpperCase()}`;
      }
      if (bookingReady) {
        [rawPrices, rawInventory] = await Promise.all([store.rawPrice(event.property_id), store.rawInventory(event.property_id)]);
        const prior = rawPrices ? validatePricingSnapshot(decode(rawPrices), event.property_id) : null;
        const inventory = readChannelInventory(rawInventory, event.property_id);
        merged = mergeChange(event, prior, inventory);
        receipt.price_version = merged.prices?.version ?? null;
        receipt.inventory_version = merged.inventory?.version ?? null;
        receipt.applied_values = merged.counts.applied;
        receipt.superseded_values = merged.counts.superseded;
      }
    } catch (error) { receipt.error_code = safeError(error); }
    if (!merged || receipt.error_code) {
      receipt.status = receipt.attempts >= 8 ? 'failed' : 'awaiting_source';
      receipt.verified = false;
      receipt.next_check_at = receipt.status === 'failed' ? null : new Date(now().getTime() + Math.min(300_000, 30_000 * 2 ** (receipt.attempts - 1))).toISOString();
      receipt.completed_at = receipt.status === 'failed' ? at : null;
      // No partial price publication while booking reconciliation is pending.
      if (!await store.commit(loaded, owner, receipt)) return loaded.value.receipt;
      return receipt;
    }
    receipt.status = merged.counts.superseded ? merged.counts.applied ? 'partially_applied' : 'superseded' : 'applied';
    receipt.verified = receipt.status === 'applied';
    receipt.completed_at = now().toISOString();
    receipt.next_check_at = null;
    receipt.error_code = receipt.status === 'applied' ? null : 'NEWER_OBSERVATION_RETAINED';
    // Both baselines are fenced even for a single-domain change: manual refresh
    // may run concurrently and must cause a retry rather than a lost update.
    const prices = { before: rawPrices, after: merged.prices ? encode(merged.prices) : null };
    const inventory = { before: rawInventory, after: merged.inventory ? encode(merged.inventory) : null };
    if (!await store.commit(loaded, owner, receipt, prices, inventory)) return loaded.value.receipt;
    return receipt;
  } finally { await store.release(event.property_id, owner).catch(() => undefined); }
}

export async function recoverChanges(property: string, deps: ChangeDependencies, limit = 3) {
  const pending = await deps.store.pending(property, (deps.now?.() ?? new Date()).toISOString(), limit);
  const results = [];
  for (const change of pending) {
    try { results.push(await processChange(change, deps)); }
    catch { results.push({ event_id: change.value.event.event_id, status: 'retry_pending' }); }
  }
  return results;
}
