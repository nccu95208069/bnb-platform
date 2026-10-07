import { gunzipSync, gzipSync } from 'node:zlib';
import { pricingProperty } from '../property-pricing.ts';
import { validatePricingSnapshot, type PricingSnapshot } from '../pricing-snapshot.ts';
import { type CalendarChange, type InventoryObservation, canonical, digest } from './contract.ts';

export function encode(value: unknown) { return 'gz1:' + gzipSync(JSON.stringify(value)).toString('base64'); }
export function decode(raw: string): unknown {
  if (!raw.startsWith('gz1:')) throw Error('CHANGE_STORAGE_INVALID');
  return JSON.parse(gunzipSync(Buffer.from(raw.slice(4), 'base64'), { maxOutputLength: 8 * 1024 * 1024 }).toString('utf8'));
}
export type ChannelInventory = {
  schema: 1;
  property_id: string;
  version: string;
  observed_at: string;
  cells: (InventoryObservation & { observed_at: string; source_version: string })[];
};
export function readChannelInventory(raw: string | null, property: string): ChannelInventory | null {
  if (!raw) return null;
  const value = decode(raw) as ChannelInventory;
  if (value.schema !== 1 || value.property_id !== property || !Array.isArray(value.cells) || value.cells.length > 6000 || !/^[a-f0-9]{20}$/.test(value.version)) throw Error('CHANGE_STORAGE_INVALID');
  const rooms = pricingProperty(property).roomNames, seen = new Set<string>();
  for (const c of value.cells) {
    const key = `${c.date}|${c.room}`;
    if (!/^\d{4}-\d\d-\d\d$/.test(c.date) || !Number.isFinite(Date.parse(c.date)) || new Date(c.date).toISOString().slice(0,10) !== c.date || !rooms.includes(c.room) || seen.has(key) || typeof c.is_lock !== 'boolean' || (c.count !== null && (!Number.isSafeInteger(c.count) || c.count < 0 || c.count > 1000)) || !Number.isFinite(Date.parse(c.observed_at)) || Date.parse(c.observed_at) > Date.parse(value.observed_at)) throw Error('CHANGE_STORAGE_INVALID');
    seen.add(key);
  }
  if (!Number.isFinite(Date.parse(value.observed_at))) throw Error('CHANGE_STORAGE_INVALID');
  return value;
}
type Cell = PricingSnapshot['cells'][number];
type Count = { applied: number; superseded: number };
const newer = (incoming: string, existing?: string) => !existing || Date.parse(incoming) > Date.parse(existing);
const sameTime = (a: string, b?: string) => !!b && Date.parse(a) === Date.parse(b);
const latest = (values: (string | undefined)[]) => values.filter((v): v is string => !!v).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1)!;
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);

// Each domain keeps its own observation time. A price callback cannot erase a newer
// stock read; an inventory-only callback cannot make old prices appear freshly read.
export function mergeChange(event: CalendarChange, prior: PricingSnapshot | null, inventory: ChannelInventory | null) {
  const counts: Count = { applied: 0, superseded: 0 };
  let prices = prior;
  if (event.pricing_snapshot) {
    const incoming = event.pricing_snapshot;
    const cells = new Map(prior?.cells.map(c => [`${c.date}|${c.room}`, { ...c,
      observed_at: c.observed_at ?? prior.observed_at,
      stock_observed_at: c.stock_observed_at ?? c.observed_at ?? prior.observed_at,
      probability_observed_at: c.probability_observed_at ?? c.observed_at ?? prior.observed_at,
    } as Cell]));
    let changed = false;
    for (const cell of incoming.cells) {
      const key = `${cell.date}|${cell.room}`, before = cells.get(key);
      const next: Cell = before ? { ...before } : { date: cell.date, room: cell.room, channels: {}, rack_price: null, daytype: '', baseline_version: '', stock: null, observed_at: '1970-01-01T00:00:00.000Z' };
      const priceAt = cell.observed_at ?? incoming.observed_at;
      if (event.changes.includes('prices')) {
        const candidate = { channels: cell.channels, rack_price: cell.rack_price, daytype: cell.daytype, baseline_version: cell.baseline_version };
        const previous = { channels: next.channels, rack_price: next.rack_price, daytype: next.daytype, baseline_version: next.baseline_version };
        if (newer(priceAt, before?.observed_at) || (sameTime(priceAt, before?.observed_at) && equal(candidate, previous))) {
          Object.assign(next, candidate, { observed_at: priceAt }); counts.applied++; changed = true;
        } else counts.superseded++;
      }
      if (event.changes.includes('sales_probability')) {
        const probabilityAt = cell.probability_observed_at ?? incoming.observed_at;
        const probability = cell.sales_probability ?? null;
        const olderModel = probability && before?.sales_probability && probability.asof < before.sales_probability.asof;
        if (!olderModel && (newer(probabilityAt, before?.probability_observed_at) || (sameTime(probabilityAt, before?.probability_observed_at) && equal(probability, before?.sales_probability ?? null)))) {
          next.sales_probability = probability; next.probability_observed_at = probabilityAt; counts.applied++; changed = true;
        } else counts.superseded++;
      }
      cells.set(key, next);
    }
    if (changed) {
      const merged = [...cells.values()].sort((a, b) => a.date.localeCompare(b.date) || a.room.localeCompare(b.room));
      const observed_at = latest([prior?.observed_at, incoming.observed_at]);
      const result = { ...incoming, observed_at, cells: merged };
      result.version = digest(canonical(result)).slice(0, 20);
      prices = validatePricingSnapshot(result, event.property_id);
    }
  }
  let stocks = inventory;
  if (event.changes.includes('inventory')) {
    const observation = event.inventory_snapshot ?? {
      version: event.pricing_snapshot!.version, observed_at: event.pricing_snapshot!.observed_at,
      cells: event.pricing_snapshot!.cells.filter(c => c.stock !== null).map(c => ({ date: c.date, room: c.room, ...c.stock!, observed_at: c.stock_observed_at ?? c.observed_at ?? event.pricing_snapshot!.observed_at })),
    };
    if (!observation.cells.length) throw Error('INVALID_CHANGE');
    const cells = new Map(inventory?.cells.map(c => [`${c.date}|${c.room}`, c]));
    const priceCells = new Map(prior?.cells.map(c => [`${c.date}|${c.room}`, c]));
    let changed = false;
    for (const cell of observation.cells) {
      const key = `${cell.date}|${cell.room}`;
      const price = priceCells.get(key);
      const baseline = price?.stock ? { ...price.stock, observed_at: price.stock_observed_at ?? price.observed_at ?? prior!.observed_at } : null;
      const overlay = cells.get(key);
      const previous = overlay && (!baseline || Date.parse(overlay.observed_at) >= Date.parse(baseline.observed_at)) ? overlay : baseline;
      const at = 'observed_at' in cell ? String(cell.observed_at) : observation.observed_at;
      if (newer(at, previous?.observed_at) || (sameTime(at, previous?.observed_at) && cell.count === previous?.count && cell.is_lock === previous?.is_lock)) {
        cells.set(key, { date: cell.date, room: cell.room, count: cell.count, is_lock: cell.is_lock, observed_at: at, source_version: observation.version });
        counts.applied++; changed = true;
      } else counts.superseded++;
    }
    if (changed) {
      const value = { schema: 1 as const, property_id: event.property_id, observed_at: latest([inventory?.observed_at, observation.observed_at]), cells: [...cells.values()].sort((a, b) => a.date.localeCompare(b.date) || a.room.localeCompare(b.room)) };
      if (value.cells.length > 6000) throw Error('CHANGE_STORAGE_LIMIT');
      stocks = { ...value, version: digest(canonical(value)).slice(0, 20) };
    }
  }
  return { prices, inventory: stocks, counts };
}
