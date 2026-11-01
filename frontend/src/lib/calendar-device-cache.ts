"use client";

// A convenience copy, never an authentication source or a verified live read.
// Callers must show its savedAt and refresh it before enabling write actions.
export const CALENDAR_DEVICE_CACHE_TTL = 24 * 60 * 60 * 1000;
export const CALENDAR_DEVICE_CACHE_EVENT = 'sweetfun-calendar-cache-cleared';
const SCHEMA = 1;
const DAY = 86_400_000;
const MAX_WINDOWS = 7;
const MAX_SPAN_DAYS = 235;
const MAX_RECORDS = 40;
const MAX_RECORD_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 8_000_000;
const DATABASE = 'sweetfun-calendar-device-cache';
const STORE = 'windows';
const CHANNEL = 'sweetfun-calendar-cache-control-v1';

type Membership = { id: string; tenantId: string; role: string; status: string;
  allProperties: boolean; propertyIds: string[] };
export type CalendarDeviceAccess = {
  membership: Membership | null;
  initialized: boolean;
  sessionVerifiedAt: number;
  loading?: boolean;
  sessionLoading?: boolean;
  requiresPasswordReset?: boolean;
};
export type CalendarDeviceScope = Readonly<{ key: string; generation: number; verifiedAt: number }>;
export type CalendarDeviceKind = 'bookings' | 'availability';
export type CalendarDeviceWindow<T> = { start: string; end: string; data: T; savedAt: number };
type Validator<T> = (data: unknown, start: string, end: string) => data is T;
type RecordValue = CalendarDeviceWindow<unknown> & { id: string; schema: number;
  scope: string; kind: CalendarDeviceKind; queryKey: string };

// A transaction callback stays synchronous so IndexedDB never commits between
// reading and replacing records. Injected stores allow failure/race regression tests.
export type CalendarDeviceStore = {
  read: () => Promise<unknown[]>;
  update: (change: (rows: unknown[]) => unknown[]) => Promise<void>;
};

function validRange(start: unknown, end: unknown): start is string {
  const day = (value: unknown): value is string => typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
  return day(start) && day(end) && start < end && Date.parse(end) - Date.parse(start) <= 93 * DAY;
}
function validRecord(value: unknown, now: number): value is RecordValue {
  if (!value || typeof value !== 'object') return false;
  const row = value as RecordValue;
  return row.schema === SCHEMA && typeof row.id === 'string' && typeof row.scope === 'string' &&
    (row.kind === 'bookings' || row.kind === 'availability') && typeof row.queryKey === 'string' &&
    Number.isFinite(row.savedAt) && row.savedAt <= now && now - row.savedAt < CALENDAR_DEVICE_CACHE_TTL &&
    validRange(row.start, row.end) && row.id === JSON.stringify([row.scope, row.kind, row.queryKey, row.start, row.end]);
}
function byteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
function detached<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function sameGroup(row: RecordValue, scope: CalendarDeviceScope, kind: CalendarDeviceKind, queryKey: string) {
  return row.scope === scope.key && row.kind === kind && row.queryKey === queryKey;
}
function bounded(rows: RecordValue[]) {
  const recent = rows.sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_RECORDS);
  let bytes = 0;
  return recent.filter(row => { bytes += byteLength(row); return bytes <= MAX_TOTAL_BYTES; });
}
function boundedGroup(rows: RecordValue[]) {
  const group = rows.sort((a, b) => b.savedAt - a.savedAt).slice(0, MAX_WINDOWS);
  while (group.length > 1 && (Math.max(...group.map(item => Date.parse(item.end))) -
    Math.min(...group.map(item => Date.parse(item.start)))) > MAX_SPAN_DAYS * DAY) group.pop();
  return group;
}

export function createCalendarDeviceCache(store: CalendarDeviceStore, now = () => Date.now()) {
  let generation = 0;
  let invalidatedAt = -1;
  const current = (scope: CalendarDeviceScope | null): scope is CalendarDeviceScope =>
    !!scope && scope.generation === generation && scope.verifiedAt >= invalidatedAt;
  return {
    scope(access: CalendarDeviceAccess, options: { properties: string[]; viewPrices: boolean; effectiveRole?: string }): CalendarDeviceScope | null {
      const member = access.membership;
      // Match the existing session bootstrap's 30-second reuse policy. Loading
      // a device copy never creates, refreshes, or extends a login session.
      if (!access.initialized || access.sessionLoading || access.requiresPasswordReset || !member ||
        member.status !== 'active' || !member.id || !member.tenantId ||
        !Number.isFinite(access.sessionVerifiedAt) || access.sessionVerifiedAt <= 0 ||
        access.sessionVerifiedAt < invalidatedAt || now() - access.sessionVerifiedAt < 0 ||
        now() - access.sessionVerifiedAt >= 30_000) return null;
      // This flag comes only from the freshly verified server projection. The
      // two known calendar properties remain explicit even when an all-property
      // membership does not redundantly enumerate their IDs.
      const allowed = [...new Set(member.allProperties ? ['sweetfun', 'offland'] : member.propertyIds)].sort();
      const properties = [...new Set(options.properties.length ? options.properties : allowed)].sort();
      if (!properties.length || !properties.every(id => allowed.includes(id)) ||
        properties.some(id => id !== 'sweetfun' && id !== 'offland')) return null;
      return { key: JSON.stringify([SCHEMA, member.tenantId, member.id, member.role,
        options.effectiveRole ?? member.role, member.allProperties, allowed, properties, options.viewPrices]),
        generation, verifiedAt: access.sessionVerifiedAt };
    },
    async load<T>(scope: CalendarDeviceScope | null, kind: CalendarDeviceKind, queryKey: string, validate: Validator<T>): Promise<CalendarDeviceWindow<T>[]> {
      if (!current(scope) || queryKey.length > 1000) return [];
      const epoch = generation;
      try {
        const rows = await store.read();
        if (epoch !== generation || !current(scope)) return [];
        const live = rows.filter(row => validRecord(row, now())) as RecordValue[];
        if (live.length !== rows.length) void store.update(raw => epoch === generation && current(scope)
          ? raw.filter(row => validRecord(row, now())) : raw).catch(() => {});
        return boundedGroup(bounded(live.filter(row => sameGroup(row, scope, kind, queryKey))))
          .filter(row => validate(row.data, row.start, row.end))
          .map(row => ({ start: row.start, end: row.end, data: detached(row.data) as T, savedAt: row.savedAt }));
      } catch { return []; } // Quota/private-browsing/storage failures leave network reading intact.
    },
    async save<T>(scope: CalendarDeviceScope | null, kind: CalendarDeviceKind, queryKey: string,
      value: Omit<CalendarDeviceWindow<T>, 'savedAt'> & { savedAt?: number }, validate: Validator<T>): Promise<void> {
      if (!current(scope) || queryKey.length > 1000 || !validRange(value.start, value.end)) return;
      const epoch = generation;
      try {
        if (!validate(value.data, value.start, value.end)) return;
        const row: RecordValue = { ...detached(value), savedAt: value.savedAt ?? now(),
          id: JSON.stringify([scope.key, kind, queryKey, value.start, value.end]),
          schema: SCHEMA, scope: scope.key, kind, queryKey };
        if (!validRecord(row, now()) || byteLength(row) > MAX_RECORD_BYTES) return;
        await store.update(raw => {
          if (epoch !== generation || !current(scope)) return raw;
          const live = raw.filter(item => validRecord(item, now())) as RecordValue[];
          const others = live.filter(item => !sameGroup(item, scope, kind, queryKey));
          const group = boundedGroup([row, ...live.filter(item => sameGroup(item, scope, kind, queryKey) && item.id !== row.id)]);
          // Limit retained coverage, not merely request count: each request may
          // contain two months. Newer requests win when the user moves far away.
          return bounded([...others, ...group]);
        });
      } catch { /* A cache write must never fail the calendar request. */ }
    },
    // Revocation happens before the first await. A pending load/save from an old
    // scope cannot reintroduce private data after logout or a permission change.
    async clear(): Promise<void> {
      generation++;
      invalidatedAt = now();
      try { await store.update(() => []); } catch { /* Unavailable storage has no readable cache. */ }
    },
  };
}

function indexedDbStore(): CalendarDeviceStore {
  let opening: Promise<IDBDatabase> | null = null;
  const open = () => {
    if (!opening) opening = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(Error('CACHE_UNAVAILABLE')); return; }
      const request = indexedDB.open(DATABASE, SCHEMA);
      let finished = false;
      const fail = () => { finished = true; clearTimeout(timeout); reject(Error('CACHE_UNAVAILABLE')); };
      const timeout = setTimeout(fail, 3000);
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const name of Array.from(database.objectStoreNames)) database.deleteObjectStore(name);
        database.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onerror = fail;
      request.onblocked = fail;
      request.onsuccess = () => {
        if (finished) { request.result.close(); return; }
        finished = true; clearTimeout(timeout);
        request.result.onversionchange = () => { request.result.close(); opening = null; };
        resolve(request.result);
      };
    }).catch(error => { opening = null; throw error; });
    return opening;
  };
  return {
    async read() {
      const database = await open();
      return new Promise<unknown[]>((resolve, reject) => {
        const tx = database.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).getAll();
        let rows: unknown[] = [];
        request.onsuccess = () => { rows = request.result; };
        tx.oncomplete = () => resolve(rows);
        tx.onerror = tx.onabort = () => reject(Error('CACHE_UNAVAILABLE'));
      });
    },
    async update(change) {
      const database = await open();
      return new Promise<void>((resolve, reject) => {
        const tx = database.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const request = store.getAll();
        request.onsuccess = () => {
          try {
            const next = change(request.result);
            store.clear();
            for (const row of next) store.put(row);
          } catch { tx.abort(); }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(Error('CACHE_UNAVAILABLE'));
      });
    },
  };
}

const cache = createCalendarDeviceCache(indexedDbStore());
let channel: BroadcastChannel | null = null;
function listenForClear() {
  if (channel || typeof window === 'undefined' || typeof window.BroadcastChannel === 'undefined') return;
  try {
    channel = new window.BroadcastChannel(CHANNEL);
    channel.onmessage = event => {
      if (event.data?.type !== 'clear') return;
      void cache.clear();
      window.dispatchEvent(new window.CustomEvent(CALENDAR_DEVICE_CACHE_EVENT, { detail: { remote: true } }));
    };
  } catch { /* The current tab still clears its data and in-flight operations. */ }
}
export function createCalendarDeviceScope(access: CalendarDeviceAccess,
  options: { properties: string[]; viewPrices: boolean; effectiveRole?: string }) {
  listenForClear();
  return cache.scope(access, options);
}
export const loadCalendarDeviceWindows = cache.load;
export const saveCalendarDeviceWindow = cache.save;
export async function clearCalendarDeviceCache(options: { broadcast?: boolean; notify?: boolean } = {}) {
  listenForClear();
  const clearing = cache.clear();
  if (options.notify !== false && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function')
    window.dispatchEvent(new window.CustomEvent(CALENDAR_DEVICE_CACHE_EVENT, { detail: { remote: false } }));
  try { if (options.broadcast !== false) channel?.postMessage({ type: 'clear' }); } catch { /* No private payload is broadcast. */ }
  await clearing;
}
