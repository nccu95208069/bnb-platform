import type { AvailabilityQuery, AvailabilityResult, InventoryState } from '@/lib/availability';
import { containsRange, rangesCover, type CalendarRange } from './calendar-prefetch';

const states: InventoryState[] = ['available', 'sold', 'held', 'blocked', 'maintenance', 'unknown', 'conflict', 'past'];
const dayMs = 86_400_000;

export function validAvailabilityWindow(value: unknown, query: AvailabilityQuery, property: string): value is AvailabilityResult {
  if (!value || typeof value !== 'object') return false;
  const data = value as AvailabilityResult;
  if (data.property_id !== property || !data.query || !containsRange(data.query, query) ||
    data.query.channel !== query.channel || data.query.demo_cycle !== query.demo_cycle ||
    JSON.stringify(data.query.rooms) !== JSON.stringify(query.rooms) || !Array.isArray(data.rooms) ||
    !data.rooms.length || new Set(data.rooms).size !== data.rooms.length || !Array.isArray(data.cells) ||
    !data.counts || typeof data.snapshot_id !== 'string' || typeof data.price_hidden !== 'boolean') return false;
  if (query.rooms.length && JSON.stringify(data.rooms) !== JSON.stringify(query.rooms)) return false;
  const days = (Date.parse(data.query.end) - Date.parse(data.query.start)) / dayMs;
  if (!Number.isInteger(days) || days < 1 || days > 93 || data.cells.length !== days * data.rooms.length) return false;
  const keys = new Set<string>();
  for (const cell of data.cells) {
    if (!cell || cell.date < data.query.start || cell.date >= data.query.end ||
      !/^\d{4}-\d{2}-\d{2}$/.test(cell.date) || !data.rooms.includes(cell.room) || !states.includes(cell.state)) return false;
    const key = `${cell.date}:${cell.room}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

export function availabilityVersion(data: AvailabilityResult) {
  return JSON.stringify([data.snapshot_id, data.price_hidden]);
}

export function selectAvailabilityWindow(windows: AvailabilityResult[], range: CalendarRange): AvailabilityResult | null {
  const anchor = [...windows].reverse().find(data => containsRange(data.query, range)) ??
    [...windows].reverse().find(data => data.query.start <= range.start && data.query.end > range.start);
  if (!anchor) return null;
  const peers = windows.filter(data => availabilityVersion(data) === availabilityVersion(anchor));
  if (!rangesCover(peers.map(data => data.query), range)) return null;
  const cells = [...new Map(peers.flatMap(data => data.cells)
    .filter(cell => cell.date >= range.start && cell.date < range.end)
    .map(cell => [`${cell.date}:${cell.room}`, cell])).values()];
  const counts = Object.fromEntries(states.map(state => [state, 0])) as Record<InventoryState, number>;
  for (const cell of cells) counts[cell.state]++;
  return { ...anchor, query: { ...anchor.query, ...range }, cells, counts };
}
