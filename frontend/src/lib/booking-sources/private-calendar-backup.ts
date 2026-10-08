import { createHash } from 'node:crypto';
import { get, list, put, del } from '@vercel/blob';
import type { SheetSourceDefinition } from './config';
import type { BookingSourceSnapshot } from './sweetfun-sheet';
import type { CalendarBooking } from '../../components/calendar/calendar-types';
import { makePrivateSnapshot, openPrivateSnapshot, sealPrivateSnapshot, type Envelope, type PrivateCalendarCache, type PrivateCalendarSnapshot } from './private-calendar-snapshot';

export interface PrivateObjectStore {
  list(prefix: string): Promise<string[]>;
  read(path: string): Promise<string | null>;
  write(path: string, body: string): Promise<void>;
  remove(paths: string[]): Promise<void>;
}
const MAX_BYTES = 8 * 1024 * 1024;
const prefixFor = (source: SheetSourceDefinition) => `sweetfun-os/calendar/v1/${source.property.id}/${createHash('sha256').update(source.sourceId).digest('hex').slice(0, 16)}/`;
const inverted = (value: number) => String(9_999_999_999_999 - value).padStart(13, '0');
const filename = (value: PrivateCalendarSnapshot) => `${inverted(Date.parse(value.verified_at))}-${inverted(value.started_at)}-${value.version}.json`;
export const newestSnapshotFirst = (a: PrivateCalendarSnapshot, b: PrivateCalendarSnapshot) => Date.parse(b.verified_at) - Date.parse(a.verified_at) || b.started_at - a.started_at;

// Immutable paths avoid a late request overwriting the newest version. The backing
// store is private; only encrypted envelopes leave this process, never guest URLs.
export class BlobPrivateCalendarCache implements PrivateCalendarCache {
  private objects: PrivateObjectStore;
  private secret: string;
  constructor(objects: PrivateObjectStore, secret: string) { this.objects = objects; this.secret = secret; }
  private async paths(source: SheetSourceDefinition) {
    const prefix = prefixFor(source);
    return (await this.objects.list(prefix)).filter(path => path.startsWith(prefix) && /^\d{13}-\d{13}-[a-f0-9]{64}\.json$/.test(path.slice(prefix.length))).sort();
  }
  private async load(path: string, source: SheetSourceDefinition) {
    const raw = await this.objects.read(path);
    if (!raw || raw.length > MAX_BYTES) throw Error('PRIVATE_SNAPSHOT_INVALID');
    const value = openPrivateSnapshot(JSON.parse(raw) as Envelope, source, this.secret);
    if (path !== prefixFor(source) + filename(value)) throw Error('PRIVATE_SNAPSHOT_INVALID');
    return value;
  }
  async read(source: SheetSourceDefinition) {
    const paths = await this.paths(source);
    if (!paths.length) return null;
    for (const path of paths.slice(0, 6)) {
      try { return await this.load(path, source); } catch { /* Previous complete version remains useful. */ }
    }
    throw Error('PRIVATE_SNAPSHOT_INVALID');
  }
  async publish(source: SheetSourceDefinition, snapshot: BookingSourceSnapshot, bookings: CalendarBooking[], startedAt: number) {
    const value = makePrivateSnapshot(source, snapshot, bookings, startedAt);
    if (!value) return;
    const previous = await this.read(source).catch(error => {
      if (error instanceof Error && error.message === 'PRIVATE_SNAPSHOT_INVALID') return null;
      throw error;
    });
    if (previous && (newestSnapshotFirst(previous, value) <= 0 || (previous.version === value.version && Date.parse(value.verified_at) - Date.parse(previous.verified_at) < 300_000))) return;
    const path = prefixFor(source) + filename(value);
    await this.objects.write(path, JSON.stringify(sealPrivateSnapshot(value, source, this.secret)));
    const confirmed = await this.load(path, source);
    if (confirmed.version !== value.version) throw Error('PRIVATE_SNAPSHOT_WRITE');
    const paths = await this.paths(source);
    const versions = new Set<string>(), keep = new Set<string>();
    for (const candidate of paths) {
      const version = candidate.slice(-69, -5);
      if (!versions.has(version) && versions.size < 3) { versions.add(version); keep.add(candidate); }
    }
    // Delete only this namespace's already observed, older files, after readback.
    // A concurrent newer upload is either retained or absent from this deletion set.
    const remove = paths.filter(candidate => !keep.has(candidate));
    if (remove.length) await this.objects.remove(remove);
  }
}

export class MirroredPrivateCalendarCache implements PrivateCalendarCache {
  private stores: PrivateCalendarCache[];
  private writeSecondaries: boolean;
  constructor(stores: PrivateCalendarCache[], writeSecondaries = true) { this.stores = stores; this.writeSecondaries = writeSecondaries; }
  async read(source: SheetSourceDefinition) {
    const results = await Promise.allSettled(this.stores.map(store => store.read(source)));
    const values = results.flatMap(r => r.status === 'fulfilled' && r.value ? [r.value] : []).sort(newestSnapshotFirst);
    if (values.length) return values[0];
    if (results.some(r => r.status === 'rejected')) throw Error('PRIVATE_SNAPSHOT_UNAVAILABLE');
    return null;
  }
  async publish(source: SheetSourceDefinition, snapshot: BookingSourceSnapshot, bookings: CalendarBooking[], startedAt: number) {
    const writers = this.writeSecondaries ? this.stores : this.stores.slice(0, 1);
    const results = await Promise.allSettled(writers.map(store => store.publish(source, snapshot, bookings, startedAt)));
    // Live reads still succeed, but any failed replica is visible in diagnostics.
    if (results.some(r => r.status === 'rejected')) throw Error('PRIVATE_SNAPSHOT_WRITE');
  }
}

export function configuredBlobCache(secret: string): PrivateCalendarCache | undefined {
  if (!process.env.CALENDAR_BACKUP_BLOB_STORE_ID) return undefined;
  const options = () => ({ storeId: process.env.CALENDAR_BACKUP_BLOB_STORE_ID!,
    ...(!process.env.VERCEL_OIDC_TOKEN && process.env.CALENDAR_BACKUP_READ_WRITE_TOKEN ? { token: process.env.CALENDAR_BACKUP_READ_WRITE_TOKEN } : {}),
    abortSignal: AbortSignal.timeout(1800) });
  return new BlobPrivateCalendarCache({
    async list(prefix) {
      const paths: string[] = []; let cursor: string | undefined;
      do {
        const result = await list({ ...options(), prefix, cursor, limit: 1000 });
        paths.push(...result.blobs.map(b => b.pathname));
        if (!result.hasMore) return paths;
        if (!result.cursor || paths.length >= 5000) throw Error('PRIVATE_SNAPSHOT_SIZE');
        cursor = result.cursor;
      } while (cursor);
      return paths;
    },
    async read(path) {
      const result = await get(path, { ...options(), access: 'private', useCache: false });
      if (!result || result.statusCode !== 200) return null;
      if (result.blob.size > MAX_BYTES) throw Error('PRIVATE_SNAPSHOT_SIZE');
      return new Response(result.stream).text();
    },
    async write(path, body) { await put(path, body, { ...options(), access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: 'application/octet-stream' }); },
    async remove(paths) { await del(paths, options()); },
  }, secret);
}
