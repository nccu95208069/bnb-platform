import type { CalendarBooking, CalendarResponse } from '../components/calendar/calendar-types';
import { validCalendarResponse } from '../components/calendar/calendar-retention.ts';

const MAX_ROWS = 2_000;
const HASH = /^[a-f0-9]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type CalendarManifest = {
  schema: 1;
  start: string;
  end: string;
  rows: [string, string][];
  digest: string;
};
export type CalendarDelta = {
  schema: 1;
  base_digest: string;
  digest: string;
  metadata: Omit<CalendarResponse, 'bookings'>;
  upserts: CalendarBooking[];
  removed: string[];
  order: string[];
};

// Hash the entire authorized row, including names, notes, payments and removals.
// Inventory versions alone cannot detect all of these changes.
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

async function hash(value: unknown) {
  const bytes = new TextEncoder().encode(stableJson(value));
  const result = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validDay(day: unknown): day is string {
  return typeof day === 'string' && DAY.test(day) && Number.isFinite(Date.parse(day)) &&
    new Date(day).toISOString().slice(0, 10) === day;
}

function uniqueIds(rows: CalendarBooking[]) {
  return rows.length <= MAX_ROWS && rows.every(row => typeof row.id === 'string' &&
    row.id.length > 0 && row.id.length <= 256) && new Set(rows.map(row => row.id)).size === rows.length;
}

export function validCalendarManifest(value: unknown): value is CalendarManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as CalendarManifest;
  return manifest.schema === 1 && validDay(manifest.start) && validDay(manifest.end) &&
    manifest.start < manifest.end && (Date.parse(manifest.end) - Date.parse(manifest.start)) / 86_400_000 <= 93 &&
    typeof manifest.digest === 'string' && HASH.test(manifest.digest) &&
    Array.isArray(manifest.rows) && manifest.rows.length <= MAX_ROWS &&
    manifest.rows.every(row => Array.isArray(row) && row.length === 2 &&
      typeof row[0] === 'string' && row[0].length > 0 && row[0].length <= 256 &&
      typeof row[1] === 'string' && HASH.test(row[1])) &&
    new Set(manifest.rows.map(row => row[0])).size === manifest.rows.length;
}

async function manifestDigest(start: string, end: string, rows: [string, string][]) {
  return hash([1, start, end, [...rows].sort((a, b) => a[0].localeCompare(b[0], 'en'))]);
}

export async function createCalendarManifest(data: CalendarResponse): Promise<CalendarManifest> {
  if (!validCalendarResponse(data, data.period_start, data.period_end) || !uniqueIds(data.bookings))
    throw Error('CALENDAR_SYNC_BASE_INVALID');
  const rows: [string, string][] = await Promise.all(data.bookings.map(async row => [row.id, await hash(row)]));
  const manifest: CalendarManifest = { schema: 1, start: data.period_start, end: data.period_end, rows,
    digest: await manifestDigest(data.period_start, data.period_end, rows) };
  if (!validCalendarManifest(manifest)) throw Error('CALENDAR_SYNC_BASE_INVALID');
  return manifest;
}

export async function createCalendarDelta(manifest: CalendarManifest, fresh: CalendarResponse): Promise<CalendarDelta> {
  if (!validCalendarManifest(manifest) || manifest.digest !== await manifestDigest(manifest.start, manifest.end, manifest.rows))
    throw Error('CALENDAR_SYNC_MANIFEST_INVALID');
  if (fresh.period_start !== manifest.start || fresh.period_end !== manifest.end)
    throw Error('CALENDAR_SYNC_RANGE_MISMATCH');
  const next = await createCalendarManifest(fresh);
  const prior = new Map(manifest.rows);
  const current = new Map(next.rows);
  const { bookings, ...metadata } = fresh;
  return { schema: 1, base_digest: manifest.digest, digest: next.digest, metadata,
    upserts: bookings.filter(row => prior.get(row.id) !== current.get(row.id)),
    removed: manifest.rows.filter(([id]) => !current.has(id)).map(([id]) => id),
    order: bookings.map(row => row.id) };
}

export async function applyCalendarDelta(base: CalendarResponse, manifest: CalendarManifest, value: unknown): Promise<CalendarResponse> {
  const delta = value as CalendarDelta;
  if (!delta || delta.schema !== 1 || delta.base_digest !== manifest.digest || !HASH.test(delta.digest) ||
      !delta.metadata || delta.metadata.period_start !== manifest.start || delta.metadata.period_end !== manifest.end ||
      !Array.isArray(delta.upserts) || !Array.isArray(delta.removed) || !Array.isArray(delta.order) ||
      delta.order.length > MAX_ROWS || delta.removed.length > MAX_ROWS || !uniqueIds(delta.upserts) ||
      !delta.removed.every(id => typeof id === 'string') || !delta.order.every(id => typeof id === 'string') ||
      new Set(delta.removed).size !== delta.removed.length || new Set(delta.order).size !== delta.order.length)
    throw Error('CALENDAR_SYNC_RESPONSE_INVALID');
  // The async request must still apply to the exact immutable base it described.
  if ((await createCalendarManifest(base)).digest !== manifest.digest) throw Error('CALENDAR_SYNC_BASE_CHANGED');
  const rows = new Map(base.bookings.map(row => [row.id, row]));
  for (const id of delta.removed) {
    if (!rows.delete(id)) throw Error('CALENDAR_SYNC_RESPONSE_INVALID');
  }
  for (const row of delta.upserts) {
    if (delta.removed.includes(row.id)) throw Error('CALENDAR_SYNC_RESPONSE_INVALID');
    rows.set(row.id, row);
  }
  if (rows.size !== delta.order.length || delta.order.some(id => !rows.has(id)))
    throw Error('CALENDAR_SYNC_RESPONSE_INVALID');
  const result = { ...delta.metadata, bookings: delta.order.map(id => rows.get(id)!) };
  if (!validCalendarResponse(result, manifest.start, manifest.end) ||
      (await createCalendarManifest(result)).digest !== delta.digest)
    throw Error('CALENDAR_SYNC_RESPONSE_INVALID');
  return result;
}
