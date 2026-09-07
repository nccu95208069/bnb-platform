import type { Channel } from './availability';

export const PRICING_KEY = 'sweetfun-os:pricing:v1:sweetfun';
export const PRICING_ROOMS = ['101', '102', '201', '202', '301', '302'];
export const PRICING_CHANNELS: Channel[] = ['direct', 'booking', 'agoda', 'airbnb', 'owljourney'];
export type PricingSnapshot = {
  schema: 1;
  property_id: 'sweetfun';
  observed_at: string;
  version: string;
  source_commit: string;
  cells: {
    date: string; room: string; channels: Partial<Record<Channel, number>>;
    rack_price: number | null; daytype: string; baseline_version: string;
    stock: { count: number | null; is_lock: boolean } | null;
  }[];
};
export function validatePricingSnapshot(value: unknown): PricingSnapshot {
  const s = value as PricingSnapshot;
  const seen = new Set<string>();
  if (s?.schema !== 1 || s.property_id !== 'sweetfun' || !Number.isFinite(Date.parse(s.observed_at)) ||
      Date.parse(s.observed_at) > Date.now() + 300000 || !/^[a-f0-9]{20}$/.test(s.version) ||
      !/^[a-f0-9]{40}$/.test(s.source_commit) || !Array.isArray(s.cells) || s.cells.length < 6 || s.cells.length > 6000) throw Error('INVALID_PRICING_SNAPSHOT');
  for (const c of s.cells) {
    const key = `${c.date}|${c.room}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c.date) || new Date(c.date).toISOString().slice(0,10) !== c.date ||
        !PRICING_ROOMS.includes(c.room) || seen.has(key) || typeof c.daytype !== 'string' ||
        typeof c.baseline_version !== 'string' || !c.channels ||
        Object.entries(c.channels).some(([ch,p]) => !PRICING_CHANNELS.includes(ch as Channel) || !Number.isSafeInteger(p) || p <= 0) ||
        (c.rack_price !== null && (!Number.isSafeInteger(c.rack_price) || c.rack_price <= 0)) ||
        (c.stock !== null && (typeof c.stock.is_lock !== 'boolean' || (c.stock.count !== null && (!Number.isSafeInteger(c.stock.count) || c.stock.count < 0))))) throw Error('INVALID_PRICING_CELL');
    seen.add(key);
  }
  return s;
}
