import { createHash, createHmac } from 'node:crypto';
import type { CalendarBooking } from '../../components/calendar/calendar-types';
import type { Principal } from '../workspace-auth/types';
import { sweetfunCalendarPlatform } from './sweetfun-platform.ts';

type ReadGrant = {
  credentialId: string;
  clientId: string;
  workspaceId: string;
  propertyId: string;
  token: string;
};

export type IronGateCalendarConfig = {
  baseUrl: string;
  proofSecret: string;
  expectedAuthorityEpoch: number;
  grant: ReadGrant;
  roomIds: Record<string, string>;
};

type Page = { propertyId: string; inventoryVersion: number; authorityEpoch: number;
  readOnly: boolean; bookings: unknown[]; nextCursor: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROOMS = ['101', '102', '201', '202', '301', '302'];
const DAY_MS = 86_400_000;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function day(value: string): number {
  if (!DATE.test(value)) throw Error('IRON_GATE_CALENDAR_INVALID_DATE');
  const millis = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(millis) || new Date(millis).toISOString().slice(0, 10) !== value)
    throw Error('IRON_GATE_CALENDAR_INVALID_DATE');
  return millis / DAY_MS;
}

function date(number: number): string {
  return new Date(number * DAY_MS).toISOString().slice(0, 10);
}

function baseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1'))
    throw Error('IRON_GATE_CALENDAR_CONFIG_INVALID');
  return url.origin;
}

/** This flag is separate from the existing Sheet reader and starts closed. */
export function ironGateCalendarConfig(env: NodeJS.ProcessEnv = process.env): IronGateCalendarConfig {
  try {
    if (env.IRON_GATE_SWEETFUN_CALENDAR_ENABLED !== 'true') throw Error();
    const grant = JSON.parse(env.IRON_GATE_SWEETFUN_CALENDAR_GRANT ?? 'null') as unknown;
    const roomIds = JSON.parse(env.IRON_GATE_SWEETFUN_ROOM_IDS ?? 'null') as unknown;
    const proofSecret = env.IRON_GATE_SWEETFUN_OS_PROOF_SECRET ?? '';
    const expectedAuthorityEpoch = Number(env.IRON_GATE_SWEETFUN_AUTHORITY_EPOCH);
    if (!object(grant) || Object.keys(grant).sort().join(',') !==
        'clientId,credentialId,propertyId,token,workspaceId' ||
      Object.values(grant).some(value => typeof value !== 'string') ||
      !UUID.test(String(grant.credentialId)) || !UUID.test(String(grant.clientId)) ||
      !UUID.test(String(grant.workspaceId)) || !UUID.test(String(grant.propertyId)) ||
      !TOKEN.test(String(grant.token)) || !object(roomIds) ||
      Object.keys(roomIds).sort().join(',') !== [...ROOMS].sort().join(',') ||
      Object.values(roomIds).some(value => typeof value !== 'string') ||
      ROOMS.some(room => !UUID.test(String(roomIds[room]))) ||
      new Set(Object.values(roomIds)).size !== ROOMS.length ||
      Buffer.byteLength(proofSecret, 'utf8') < 32 ||
      !Number.isSafeInteger(expectedAuthorityEpoch) || expectedAuthorityEpoch < 1)
      throw Error();
    return { baseUrl: baseUrl(env.IRON_GATE_SWEETFUN_BASE_URL ?? ''),
      proofSecret, expectedAuthorityEpoch,
      grant: grant as ReadGrant, roomIds: roomIds as Record<string, string> };
  } catch { throw Error('IRON_GATE_CALENDAR_CONFIG_INVALID'); }
}

function proof(url: string, config: IronGateCalendarConfig, principal: Principal,
  nowMs = Date.now()): string {
  if (!principal.id || !(principal.allProperties || principal.propertyIds.includes('sweetfun')))
    throw Error('IRON_GATE_CALENDAR_FORBIDDEN');
  const parsed = new URL(url);
  const claims = { v: 1, aud: 'iron-gate-v1', credentialId: config.grant.credentialId,
    clientId: config.grant.clientId, workspaceId: config.grant.workspaceId,
    propertyId: config.grant.propertyId, subjectId: principal.id,
    actions: ['booking:read'], fields: ['guest_name'],
    issuedAtMs: nowMs, expiresAtMs: nowMs + 5000, method: 'GET',
    pathAndQuery: `${parsed.pathname}${parsed.search}`, idempotencyKey: null,
    bodySha256: createHash('sha256').digest('hex') };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${encoded}.${createHmac('sha256', config.proofSecret)
    .update(encoded).digest('base64url')}`;
}

async function getJson(url: string, config: IronGateCalendarConfig, principal: Principal,
  send: typeof fetch, maxBytes: number, timeoutMs = 5000): Promise<unknown> {
  let response: Response;
  try {
    response = await send(url, { method: 'GET', headers: {
      authorization: `Bearer ${config.grant.token}`,
      'x-iron-gate-os-proof': proof(url, config, principal),
    }, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch { throw Error('IRON_GATE_CALENDAR_UNAVAILABLE'); }
  if (!response.ok) throw Error('IRON_GATE_CALENDAR_UNAVAILABLE');
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
    throw Error('IRON_GATE_CALENDAR_UNAVAILABLE');
  const reader = response.body?.getReader();
  if (!reader) throw Error('IRON_GATE_CALENDAR_UNAVAILABLE');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw Error(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw Error('IRON_GATE_CALENDAR_UNAVAILABLE'); }
}

function validPage(value: unknown, config: IronGateCalendarConfig): value is Page {
  return object(value) && value.propertyId === config.grant.propertyId &&
    Number.isSafeInteger(value.inventoryVersion) && Number(value.inventoryVersion) >= 0 &&
    value.authorityEpoch === config.expectedAuthorityEpoch && value.readOnly === false &&
    Array.isArray(value.bookings) && value.bookings.length <= 100 &&
    (value.nextCursor === null || typeof value.nextCursor === 'string' &&
      /^[A-Za-z0-9_-]{1,512}$/.test(value.nextCursor));
}

function calendarBooking(booking: Record<string, unknown>,
  roomNumber: string, stayIndex: number, checkIn: string, checkOut: string): CalendarBooking {
  const id = `ig-${booking.id}-${stayIndex}-${roomNumber}`;
  const name = typeof booking.guestName === 'string' && booking.guestName.trim()
    ? booking.guestName.trim() : '姓名待核';
  const source = object(booking.sourceCalendar) ? booking.sourceCalendar : null;
  return { id, sheet_row_id: id, order_id: `IG-${booking.id}`,
    external_order_no: null, property_id: 'sweetfun', property_name: '水芳 Sweetfun',
    room_id: `sweetfun-${roomNumber}`, room_number: roomNumber,
    guest_name: name, guest_name_kind: name === '姓名待核' ? 'missing' : 'real',
    platform: sweetfunCalendarPlatform(source?.platform), check_in: checkIn, check_out: checkOut,
    booked_at: null,
    room_rate: 0, payment_status: 'unknown', reservation_status: 'confirmed',
    notes: null, payments: [], audit_log: [], extra_guest_count: 0,
    extra_bed_count: 0, pet_count: 0, baby_supplies: [], service_note: null,
    source_read_only: true, requirements_known: false, payment_unconfirmed: true,
    source_payment_label: '財務仍以原帳本為準，未遷入此訂房檢視',
    price_hidden: true };
}

function blockedBooking(roomNumber: string, night: string): CalendarBooking {
  const id = `ig-block-${roomNumber}-${night}`;
  return { id, sheet_row_id: id, order_id: id, external_order_no: null,
    property_id: 'sweetfun', property_name: '水芳 Sweetfun',
    room_id: `sweetfun-${roomNumber}`, room_number: roomNumber,
    guest_name: '房晚待核', guest_name_kind: 'missing', platform: 'other',
    check_in: night, check_out: date(day(night) + 1), booked_at: null,
    room_rate: 0, payment_status: 'unknown', reservation_status: 'confirmed',
    notes: null, payments: [], audit_log: [], extra_guest_count: 0,
    extra_bed_count: 0, pet_count: 0, baby_supplies: [], service_note: null,
    source_read_only: true, source_conflict: true, requirements_known: false,
    payment_unconfirmed: true, price_hidden: true };
}

/** A single Iron Gate state read supplies both bookings and sparse occupancy. */
export async function readSweetfunIronGateCalendarSnapshot(start: string, end: string,
  principal: Principal, config: IronGateCalendarConfig,
  send: typeof fetch = fetch): Promise<{ bookings: CalendarBooking[];
    inventoryVersion: number; authorityEpoch: number; soldRoomNights: number;
    blockedRoomNights: number; observedAt: string }> {
  const first = day(start), last = day(end);
  if (last <= first || last - first > 410) throw Error('IRON_GATE_CALENDAR_INVALID_DATE');
  if (!(principal.allProperties || principal.propertyIds.includes('sweetfun')))
    throw Error('IRON_GATE_CALENDAR_FORBIDDEN');
  const url = new URL(`/v1/properties/${config.grant.propertyId}/calendar-snapshot`,
    `${baseUrl(config.baseUrl)}/`);
  url.searchParams.set('from', start);
  url.searchParams.set('to', end);
  const raw = await getJson(url.toString(), config, principal, send, 1024 * 1024, 8000);
  if (!object(raw) || raw.propertyId !== config.grant.propertyId ||
    raw.workspaceId !== config.grant.workspaceId || raw.from !== start || raw.to !== end ||
    !Number.isSafeInteger(raw.inventoryVersion) || Number(raw.inventoryVersion) < 0 ||
    raw.authorityEpoch !== config.expectedAuthorityEpoch || raw.readOnly !== false ||
    !Array.isArray(raw.bookings) || raw.bookings.length > 2048 ||
    !Array.isArray(raw.cells) || raw.cells.length > 4096)
    throw Error('IRON_GATE_CALENDAR_INVALID_SNAPSHOT');
  const roomById = new Map(Object.entries(config.roomIds).map(([room, id]) => [id, room]));
  const observed = new Map<string, string>();
  for (const cell of raw.cells) {
    if (!object(cell) || !roomById.has(String(cell.roomId)) ||
      typeof cell.date !== 'string' || day(cell.date) < first || day(cell.date) >= last ||
      !['sold', 'held', 'blocked'].includes(String(cell.state)))
      throw Error('IRON_GATE_CALENDAR_INVALID_INVENTORY');
    const key = `${cell.roomId}:${cell.date}`;
    if (observed.has(key)) throw Error('IRON_GATE_CALENDAR_INVALID_INVENTORY');
    observed.set(key, String(cell.state));
  }
  const seenBookings = new Set<string>();
  const sold = new Set<string>();
  const bookings: CalendarBooking[] = [];
  for (const item of raw.bookings) {
    if (!object(item) || !UUID.test(String(item.id)) ||
      item.propertyId !== config.grant.propertyId ||
      item.workspaceId !== config.grant.workspaceId ||
      !['confirmed', 'held'].includes(String(item.status)) ||
      !Array.isArray(item.stays) || item.stays.length > 32 ||
      seenBookings.has(String(item.id)))
      throw Error('IRON_GATE_CALENDAR_INVALID_BOOKING');
    seenBookings.add(String(item.id));
    if (item.status === 'held') throw Error('IRON_GATE_CALENDAR_HELD_UNSUPPORTED');
    for (const [stayIndex, rawStay] of item.stays.entries()) {
      if (!object(rawStay) || typeof rawStay.checkIn !== 'string' ||
        typeof rawStay.checkOut !== 'string' || !Array.isArray(rawStay.roomIds) ||
        rawStay.roomIds.length < 1 || rawStay.roomIds.length > 6)
        throw Error('IRON_GATE_CALENDAR_INVALID_BOOKING');
      const from = day(rawStay.checkIn), to = day(rawStay.checkOut);
      if (to <= from || to - from > 1500) throw Error('IRON_GATE_CALENDAR_INVALID_BOOKING');
      for (const roomId of rawStay.roomIds) {
        const roomNumber = roomById.get(String(roomId));
        if (!roomNumber) throw Error('IRON_GATE_CALENDAR_INVALID_BOOKING');
        if (to > first && from < last)
          bookings.push(calendarBooking(item, roomNumber, stayIndex,
            rawStay.checkIn, rawStay.checkOut));
        for (let n = Math.max(from, first); n < Math.min(to, last); n++) {
          const key = `${roomId}:${date(n)}`;
          if (sold.has(key)) throw Error('IRON_GATE_CALENDAR_COLLISION');
          sold.add(key);
        }
      }
    }
  }
  if (sold.size !== [...observed.values()].filter(state => state === 'sold').length ||
    [...sold].some(key => observed.get(key) !== 'sold') ||
    [...observed.values()].some(state => state === 'held'))
    throw Error('IRON_GATE_CALENDAR_INVENTORY_DRIFT');
  for (const [key, state] of observed) if (state === 'blocked') {
    const [roomId, night] = key.split(':');
    bookings.push(blockedBooking(roomById.get(roomId)!, night));
  }
  return { bookings, inventoryVersion: Number(raw.inventoryVersion),
    authorityEpoch: config.expectedAuthorityEpoch, soldRoomNights: sold.size,
    blockedRoomNights: [...observed.values()].filter(state => state === 'blocked').length,
    observedAt: new Date().toISOString() };
}

/** Authoritative booking and occupancy read; any missing page or version drift fails closed. */
export async function readSweetfunIronGateCalendar(start: string, end: string,
  principal: Principal, config: IronGateCalendarConfig,
  send: typeof fetch = fetch): Promise<{ bookings: CalendarBooking[];
    inventoryVersion: number; authorityEpoch: number; soldRoomNights: number;
    blockedRoomNights: number;
    observedAt: string }> {
  const first = day(start), last = day(end);
  if (last <= first || last - first > 1500) throw Error('IRON_GATE_CALENDAR_INVALID_DATE');
  if (!(principal.allProperties || principal.propertyIds.includes('sweetfun')))
    throw Error('IRON_GATE_CALENDAR_FORBIDDEN');
  const origin = baseUrl(config.baseUrl);
  const queryFrom = date(first - 1);
  const path = `/v1/properties/${config.grant.propertyId}/bookings`;
  const makePageUrl = (cursor: string | null) => {
    const url = new URL(path, `${origin}/`);
    url.searchParams.set('limit', '100');
    url.searchParams.set('from', queryFrom);
    url.searchParams.set('to', end);
    if (cursor) url.searchParams.set('cursor', cursor);
    return url.toString();
  };
  const roomById = new Map(Object.entries(config.roomIds).map(([room, id]) => [id, room]));
  // Inventory and booking pages are independent read-only requests. Start
  // them together, then require one inventory version before publishing data.
  const availabilityRead = (async () => {
    const ranges: { from: number; to: number }[] = [];
    for (let from = first; from < last; from += 31)
      ranges.push({ from, to: Math.min(from + 31, last) });
    const observed = new Map<string, string>();
    let inventoryVersion: number | null = null;
    for (let index = 0; index < ranges.length; index += 4) {
      const pages = await Promise.all(ranges.slice(index, index + 4).map(async ({ from, to }) => {
        const url = new URL(`/v1/properties/${config.grant.propertyId}/availability`, `${origin}/`);
        url.searchParams.set('from', date(from));
        url.searchParams.set('to', date(to));
        const raw = await getJson(url.toString(), config, principal, send, 128 * 1024);
        return { from, to, raw };
      }));
      for (const { from, to, raw } of pages) {
        if (!object(raw) || raw.propertyId !== config.grant.propertyId ||
          !Number.isSafeInteger(raw.inventoryVersion) ||
          raw.authorityEpoch !== config.expectedAuthorityEpoch ||
          !Array.isArray(raw.cells) || raw.cells.length !== ROOMS.length * (to - from) ||
          inventoryVersion !== null && raw.inventoryVersion !== inventoryVersion)
          throw Error('IRON_GATE_CALENDAR_VERSION_DRIFT');
        inventoryVersion = Number(raw.inventoryVersion);
        for (const cell of raw.cells) {
          if (!object(cell) || !roomById.has(String(cell.roomId)) ||
            typeof cell.date !== 'string' || day(cell.date) < from || day(cell.date) >= to ||
            !['sold', 'blocked', 'unsold', 'held'].includes(String(cell.state)))
            throw Error('IRON_GATE_CALENDAR_INVALID_INVENTORY');
          const key = `${cell.roomId}:${cell.date}`;
          if (observed.has(key)) throw Error('IRON_GATE_CALENDAR_INVALID_INVENTORY');
          observed.set(key, String(cell.state));
        }
      }
    }
    return { observed, inventoryVersion };
  })();
  // Attach the rejection handler now, even if booking pagination takes longer.
  const settledAvailability = availabilityRead.then(value => ({ value }), error => ({ error }));
  let cursor: string | null = null;
  let version: number | null = null;
  const seenCursors = new Set<string>();
  const seenBookings = new Set<string>();
  const bookings: CalendarBooking[] = [];
  const sold = new Set<string>();
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    const raw = await getJson(makePageUrl(cursor), config, principal, send, 256 * 1024);
    if (!validPage(raw, config) || version !== null && raw.inventoryVersion !== version)
      throw Error('IRON_GATE_CALENDAR_VERSION_DRIFT');
    version = raw.inventoryVersion;
    for (const item of raw.bookings) {
      if (!object(item) || !UUID.test(String(item.id)) ||
        item.propertyId !== config.grant.propertyId ||
        item.workspaceId !== config.grant.workspaceId ||
        !['confirmed', 'cancelled', 'held'].includes(String(item.status)) ||
        !Array.isArray(item.stays) || item.stays.length > 32 ||
        seenBookings.has(String(item.id)))
        throw Error('IRON_GATE_CALENDAR_INVALID_BOOKING');
      seenBookings.add(String(item.id));
      if (item.status === 'held') throw Error('IRON_GATE_CALENDAR_HELD_UNSUPPORTED');
      if (item.status !== 'confirmed') continue;
      for (const [stayIndex, rawStay] of item.stays.entries()) {
        if (!object(rawStay) || typeof rawStay.checkIn !== 'string' ||
          typeof rawStay.checkOut !== 'string' || !Array.isArray(rawStay.roomIds) ||
          rawStay.roomIds.length < 1 || rawStay.roomIds.length > 6)
          throw Error('IRON_GATE_CALENDAR_INVALID_BOOKING');
        const from = day(rawStay.checkIn), to = day(rawStay.checkOut);
        if (to <= from || to - from > 1500) throw Error('IRON_GATE_CALENDAR_INVALID_BOOKING');
        for (const roomId of rawStay.roomIds) {
          const roomNumber = roomById.get(String(roomId));
          if (!roomNumber) throw Error('IRON_GATE_CALENDAR_INVALID_BOOKING');
          if (to > first && from < last)
            bookings.push(calendarBooking(item, roomNumber,
              stayIndex, rawStay.checkIn, rawStay.checkOut));
          for (let n = Math.max(from, first); n < Math.min(to, last); n++) {
            const key = `${roomId}:${date(n)}`;
            if (sold.has(key)) throw Error('IRON_GATE_CALENDAR_COLLISION');
            sold.add(key);
          }
        }
      }
    }
    if (!raw.nextCursor) break;
    if (seenCursors.has(raw.nextCursor)) throw Error('IRON_GATE_CALENDAR_CURSOR_LOOP');
    seenCursors.add(raw.nextCursor);
    cursor = raw.nextCursor;
    if (pageNumber === 49) throw Error('IRON_GATE_CALENDAR_PAGE_LIMIT');
  }
  if (version === null) throw Error('IRON_GATE_CALENDAR_UNAVAILABLE');

  const inventory = await settledAvailability;
  if ('error' in inventory) throw inventory.error;
  const { observed, inventoryVersion } = inventory.value;
  if (inventoryVersion !== version) throw Error('IRON_GATE_CALENDAR_VERSION_DRIFT');
  if (observed.size !== ROOMS.length * (last - first) ||
    [...sold].some(key => observed.get(key) !== 'sold') ||
    [...observed].some(([key, state]) =>
      state === 'sold' && !sold.has(key) || state === 'held'))
    throw Error('IRON_GATE_CALENDAR_INVENTORY_DRIFT');
  const head = await getJson(makePageUrl(null), config, principal, send, 256 * 1024);
  if (!validPage(head, config) || head.inventoryVersion !== version)
    throw Error('IRON_GATE_CALENDAR_VERSION_DRIFT');
  for (const [key, state] of observed) if (state === 'blocked') {
    const [roomId, night] = key.split(':');
    bookings.push(blockedBooking(roomById.get(roomId)!, night));
  }
  return { bookings, inventoryVersion: version,
    authorityEpoch: config.expectedAuthorityEpoch,
    soldRoomNights: sold.size,
    blockedRoomNights: [...observed.values()].filter(state => state === 'blocked').length,
    observedAt: new Date().toISOString() };
}
