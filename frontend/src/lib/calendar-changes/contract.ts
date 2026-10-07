import { createHash, timingSafeEqual } from 'node:crypto';
import { pricingProperty, type PricingProperty } from '../property-pricing.ts';
import { validatePricingSnapshot, type PricingSnapshot } from '../pricing-snapshot.ts';

export const CHANGE_KINDS = ['booking', 'inventory', 'prices', 'sales_probability'] as const;
export type ChangeKind = typeof CHANGE_KINDS[number];
export type InventoryObservation = { date: string; room: string; count: number | null; is_lock: boolean };
export type InventorySnapshot = { version: string; observed_at: string; cells: InventoryObservation[] };
export type CalendarChange = {
  schema: 1;
  event_id: string;
  property_id: PricingProperty;
  occurred_at: string;
  source_version: string;
  changes: ChangeKind[];
  verified: true;
  pricing_snapshot?: PricingSnapshot;
  inventory_snapshot?: InventorySnapshot;
};
export type ChangeClient = { id: string; token_sha256: string; properties: PricingProperty[]; changes: ChangeKind[] };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{7,127}$/.test(v);
export const digest = (v: string) => createHash('sha256').update(v).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const eventDigest = (event: CalendarChange) => digest(canonical(event));
export function validTimestamp(v: unknown, now = new Date()): v is string {
  return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) && Number.isFinite(Date.parse(v)) && Date.parse(v) <= now.getTime() + 300_000;
}
function validDay(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
}
export function authenticateChangeClient(header: string | null, config = process.env.CALENDAR_CHANGE_CLIENTS): ChangeClient | null {
  if (!config) return null;
  let clients: unknown;
  try { clients = JSON.parse(config); } catch { throw Error('CHANGE_AUTH_CONFIG'); }
  if (!Array.isArray(clients) || clients.length > 20 || clients.some(c => !record(c) || !id(c.id) || typeof c.token_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(c.token_sha256) || !Array.isArray(c.properties) || !c.properties.length || c.properties.some((p: unknown) => !['sweetfun', 'offland'].includes(String(p))) || !Array.isArray(c.changes) || !c.changes.length || c.changes.some((k: unknown) => !CHANGE_KINDS.includes(k as ChangeKind)))) throw Error('CHANGE_AUTH_CONFIG');
  if (new Set(clients.map(c => c.id)).size !== clients.length || new Set(clients.map(c => c.token_sha256)).size !== clients.length) throw Error('CHANGE_AUTH_CONFIG');
  if (!header?.startsWith('Bearer ') || header.length < 39 || header.length > 1024) return null;
  const actual = Buffer.from(digest(header.slice(7)), 'hex');
  return (clients as ChangeClient[]).find(c => timingSafeEqual(actual, Buffer.from(c.token_sha256, 'hex'))) ?? null;
}
export function validateChange(value: unknown, client: ChangeClient, now = new Date()): CalendarChange {
  if (!record(value) || !exact(value, ['schema', 'event_id', 'property_id', 'occurred_at', 'source_version', 'changes', 'verified', 'pricing_snapshot', 'inventory_snapshot']) || value.schema !== 1 || !id(value.event_id) || !id(value.source_version) || value.verified !== true || !validTimestamp(value.occurred_at, now) || !Array.isArray(value.changes) || !value.changes.length || new Set(value.changes).size !== value.changes.length || value.changes.some(k => !CHANGE_KINDS.includes(k))) throw Error('INVALID_CHANGE');
  if (!client.properties.includes(value.property_id as PricingProperty) || value.changes.some(k => !client.changes.includes(k))) throw Error('CHANGE_FORBIDDEN');
  const config = pricingProperty(value.property_id as string);
  const event = value as unknown as CalendarChange;
  const priceChange = event.changes.includes('prices') || event.changes.includes('sales_probability');
  if (priceChange !== !!event.pricing_snapshot) throw Error('INVALID_CHANGE');
  if (event.pricing_snapshot) {
    const snapshot = validatePricingSnapshot(event.pricing_snapshot, event.property_id);
    if (snapshot.version !== event.source_version || Date.parse(snapshot.observed_at) > Date.parse(event.occurred_at)) throw Error('INVALID_CHANGE');
    // Reuse the existing complete export shape, but never accept unowned fields or PII.
    if (!exact(snapshot as unknown as Record<string, unknown>, ['schema', 'property_id', 'observed_at', 'version', 'source_commit', 'cells'])) throw Error('INVALID_CHANGE');
    for (const cell of snapshot.cells) {
      if (!exact(cell as unknown as Record<string, unknown>, ['date', 'room', 'channels', 'observed_at', 'stock_observed_at', 'probability_observed_at', 'rack_price', 'daytype', 'baseline_version', 'sales_probability', 'stock']) || cell.daytype.length > 80 || cell.baseline_version.length > 128 || Object.values(cell.channels).some(p => p! > 10_000_000)) throw Error('INVALID_CHANGE');
      if (cell.sales_probability && !exact(cell.sales_probability, ['value', 'asof', 'source_version'])) throw Error('INVALID_CHANGE');
      if (cell.stock && !exact(cell.stock, ['count', 'is_lock'])) throw Error('INVALID_CHANGE');
    }
  }
  if (event.inventory_snapshot) {
    const inventory = event.inventory_snapshot;
    if (!event.changes.includes('inventory') || !record(inventory) || !exact(inventory, ['version', 'observed_at', 'cells']) || !id(inventory.version) || !validTimestamp(inventory.observed_at, now) || Date.parse(inventory.observed_at) > Date.parse(event.occurred_at) || !Array.isArray(inventory.cells) || !inventory.cells.length || inventory.cells.length > 6000) throw Error('INVALID_CHANGE');
    const seen = new Set<string>();
    for (const cell of inventory.cells) {
      if (!record(cell) || !exact(cell, ['date', 'room', 'count', 'is_lock']) || !validDay(cell.date) || typeof cell.room !== 'string' || !config.roomNames.includes(cell.room) || typeof cell.is_lock !== 'boolean' || (cell.count !== null && (typeof cell.count !== 'number' || !Number.isSafeInteger(cell.count) || cell.count < 0 || cell.count > 1000)) || seen.has(`${cell.date}|${cell.room}`)) throw Error('INVALID_CHANGE');
      seen.add(`${cell.date}|${cell.room}`);
    }
  }
  if (event.changes.includes('inventory') && !event.inventory_snapshot && !event.pricing_snapshot?.cells.some(c => c.stock !== null)) throw Error('INVALID_CHANGE');
  return event;
}

export async function readChangeBody(request: Request) {
  const max = 2 * 1024 * 1024;
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw Error('INVALID_CHANGE');
  if (Number(request.headers.get('content-length') || 0) > max) throw Error('CHANGE_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw Error('INVALID_CHANGE');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > max) { await reader.cancel(); throw Error('CHANGE_TOO_LARGE'); }
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('INVALID_CHANGE'); }
  } finally { reader.releaseLock(); }
}
