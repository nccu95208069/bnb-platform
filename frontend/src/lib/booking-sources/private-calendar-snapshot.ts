import { configuredBlobCache, MirroredPrivateCalendarCache } from './private-calendar-backup';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { CalendarBooking } from '../../components/calendar/calendar-types';
import type { SheetSourceDefinition } from './config';
import type { BookingSourceSnapshot } from './sweetfun-sheet';

const MAX_BYTES = 8 * 1024 * 1024;
const RETENTION_SECONDS = 30 * 86400;
export type PrivateCalendarSnapshot = {
  schema: 1; property_id: string; source_id: string; version: string;
  verified_at: string; captured_at: string; started_at: number;
  snapshot: BookingSourceSnapshot; bookings: CalendarBooking[];
};
export interface PrivateCalendarCache {
  read(source: SheetSourceDefinition): Promise<PrivateCalendarSnapshot | null>;
  publish(source: SheetSourceDefinition, snapshot: BookingSourceSnapshot, bookings: CalendarBooking[], startedAt: number): Promise<void>;
}
export type Envelope = { version: string; verified_ms: number; started_at: number; captured_at: string; encrypted: string };
export type SnapshotCommand = (command: (string | number)[]) => Promise<unknown>;

export const PRIVATE_SNAPSHOT_COMMIT = `
local old = redis.call('GET', KEYS[1])
local history = old and cjson.decode(old) or {}
local next = cjson.decode(ARGV[1])
if history[1] and (history[1].verified_ms > next.verified_ms or (history[1].verified_ms == next.verified_ms and history[1].started_at >= next.started_at)) then return 0 end
local records = {next}
for _, record in ipairs(history) do
  if record.version ~= next.version and #records < 3 then table.insert(records, record) end
end
redis.call('SET', KEYS[1], cjson.encode(records), 'EX', ARGV[2])
return 1`;

function cacheKey(source: SheetSourceDefinition) { return `sweetfun-os:private-calendar:v1:${source.property.id}:${source.sourceId}`; }
function key(secret: string, source: SheetSourceDefinition) {
  if (secret.length < 32) throw Error('PRIVATE_SNAPSHOT_CONFIG');
  return Buffer.from(hkdfSync('sha256', secret, 'sweetfun-os:private-calendar:v1', `${source.property.id}:${source.sourceId}`, 32));
}
export function validPrivateSnapshot(value: PrivateCalendarSnapshot, source: SheetSourceDefinition, now = Date.now()) {
  const snapshot = value?.snapshot;
  return value?.schema === 1 && value.property_id === source.property.id && value.source_id === source.sourceId &&
    typeof value.version === 'string' && /^[a-f0-9]{64}$/.test(value.version) &&
    Number.isFinite(Date.parse(value.verified_at)) && Date.parse(value.verified_at) <= now + 60_000 &&
    Date.parse(value.captured_at) >= now - RETENTION_SECONDS * 1000 && Date.parse(value.captured_at) <= now + 60_000 &&
    Number.isSafeInteger(value.started_at) && value.started_at >= 0 && value.started_at <= Date.parse(value.captured_at) &&
    snapshot?.schema_version === 1 && snapshot.source?.id === source.sourceId && snapshot.source.anonymized === true && snapshot.source.read_only === true &&
    Array.isArray(snapshot.bookings) && Array.isArray(value.bookings) && snapshot.bookings.length > 0 && snapshot.bookings.length === value.bookings.length &&
    value.bookings.every((b, index) => b && b.id === snapshot.bookings[index]?.id && b.order_id === snapshot.bookings[index]?.order_id && b.property_id === source.property.id && source.property.rooms.some(r => r.id === b.room_id) && b.check_in === snapshot.bookings[index]?.check_in && b.check_out === snapshot.bookings[index]?.check_out && b.room_id === snapshot.bookings[index]?.room_id && b.room_rate === snapshot.bookings[index]?.room_rate);
}

export function sealPrivateSnapshot(value: PrivateCalendarSnapshot, source: SheetSourceDefinition, secret: string): Envelope {
  if (!validPrivateSnapshot(value, source)) throw Error('PRIVATE_SNAPSHOT_INVALID');
  const json = Buffer.from(JSON.stringify(value));
  if (json.length > MAX_BYTES) throw Error('PRIVATE_SNAPSHOT_SIZE');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(secret, source), iv);
  cipher.setAAD(Buffer.from(cacheKey(source)));
  const encrypted = Buffer.concat([cipher.update(gzipSync(json)), cipher.final()]);
  return { version: value.version, verified_ms: Date.parse(value.verified_at), started_at: value.started_at, captured_at: value.captured_at,
    encrypted: Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64') };
}
export function openPrivateSnapshot(envelope: Envelope, source: SheetSourceDefinition, secret: string): PrivateCalendarSnapshot {
  try {
    if (!envelope || typeof envelope.encrypted !== 'string' || envelope.encrypted.length > MAX_BYTES) throw Error();
    const bytes = Buffer.from(envelope.encrypted, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key(secret, source), bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(cacheKey(source))); decipher.setAuthTag(bytes.subarray(12, 28));
    const compressed = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
    const value = JSON.parse(gunzipSync(compressed, { maxOutputLength: MAX_BYTES }).toString('utf8')) as PrivateCalendarSnapshot;
    if (!validPrivateSnapshot(value, source) || value.version !== envelope.version || Date.parse(value.verified_at) !== envelope.verified_ms || value.started_at !== envelope.started_at || value.captured_at !== envelope.captured_at) throw Error();
    return value;
  } catch { throw Error('PRIVATE_SNAPSHOT_INVALID'); }
}

export function canPublish(snapshot: BookingSourceSnapshot, bookings: CalendarBooking[]) {
  const sync = snapshot.source.sync;
  const verified = sync?.last_successful_check_at;
  if (!verified || sync.status !== 'healthy' || Date.now() - Date.parse(verified) > 5 * 60_000) return false;
  // Archived historical rows may legitimately have no current private counterpart. A mismatch
  // in the monitor's current reconciliation window must never replace the last complete view.
  return !bookings.some(b => b.payment_unconfirmed || (!b.source_conflict && b.source_notes_unconfirmed && b.check_out >= sync.cutoff));
}

export function makePrivateSnapshot(source: SheetSourceDefinition, snapshot: BookingSourceSnapshot, bookings: CalendarBooking[], startedAt: number): PrivateCalendarSnapshot | null {
  if (!canPublish(snapshot, bookings)) return null;
  const capturedAt = new Date().toISOString();
  const version = createHash('sha256').update(JSON.stringify([source.sourceId, snapshot.source.snapshot_version, bookings])).digest('hex');
  const value: PrivateCalendarSnapshot = { schema: 1, property_id: source.property.id, source_id: source.sourceId, version,
    verified_at: snapshot.source.sync!.last_successful_check_at!, captured_at: capturedAt, started_at: startedAt, snapshot, bookings };
  return value;
}

export class RedisPrivateCalendarCache implements PrivateCalendarCache {
  private command: SnapshotCommand;
  private secret: string;
  constructor(command: SnapshotCommand, secret: string) { this.command = command; this.secret = secret; }
  async read(source: SheetSourceDefinition) {
    const raw = await this.command(['GET', cacheKey(source)]);
    if (raw === null) return null;
    if (typeof raw !== 'string' || raw.length > MAX_BYTES) throw Error('PRIVATE_SNAPSHOT_INVALID');
    const history = JSON.parse(raw) as Envelope[];
    if (!Array.isArray(history) || !history.length || history.length > 3) throw Error('PRIVATE_SNAPSHOT_INVALID');
    for (const envelope of history) {
      try { return openPrivateSnapshot(envelope, source, this.secret); } catch { /* Try a previous verified version. */ }
    }
    throw Error('PRIVATE_SNAPSHOT_INVALID');
  }
  async publish(source: SheetSourceDefinition, snapshot: BookingSourceSnapshot, bookings: CalendarBooking[], startedAt: number) {
    if (!canPublish(snapshot, bookings)) return;
    const value = makePrivateSnapshot(source, snapshot, bookings, startedAt);
    if (!value) return;
    const envelope = sealPrivateSnapshot(value, source, this.secret);
    const result = await this.command(['EVAL', PRIVATE_SNAPSHOT_COMMIT, 1, cacheKey(source), JSON.stringify(envelope), RETENTION_SECONDS]);
    if (result !== 0 && result !== 1) throw Error('PRIVATE_SNAPSHOT_WRITE');
    if (result === 0) return;
    const confirmed = await this.read(source);
    if (!confirmed || Date.parse(confirmed.verified_at) < Date.parse(value.verified_at) || (confirmed.verified_at === value.verified_at && confirmed.started_at < value.started_at)) throw Error('PRIVATE_SNAPSHOT_WRITE');
  }
}

export function configuredPrivateCalendarCache(options: { writeBackup?: boolean } = {}): PrivateCalendarCache | undefined {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  const secret = process.env.CALENDAR_OWNER_SESSION_SECRET;
  if (!secret || secret.length < 32) return undefined;
  const stores: PrivateCalendarCache[] = [];
  if (url && token && new URL(url).protocol === 'https:') stores.push(new RedisPrivateCalendarCache(async command => {
    const response = await fetch(url, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(1500),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    if (!response.ok) throw Error('PRIVATE_SNAPSHOT_UNAVAILABLE');
    const body = await response.json(); if (body.error) throw Error('PRIVATE_SNAPSHOT_UNAVAILABLE'); return body.result;
  }, secret));
  const backup = configuredBlobCache(secret);
  if (backup) stores.push(backup);
  return stores.length ? new MirroredPrivateCalendarCache(stores, options.writeBackup ?? false) : undefined;
}

