import { createHash, createHmac } from 'node:crypto';
import type { CalendarBooking } from '../../components/calendar/calendar-types';
import type { Principal } from '../workspace-auth/types';

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
  mode: 'authority' | 'snapshot_preview';
  expectedAuthorityEpoch: number;
  expectedInventoryVersion: number | null;
  expectedSnapshotHash: string | null;
  grant: ReadGrant;
  roomIds: Record<string, string>;
  trustedSourceToken?: string;
};

type Page = { propertyId: string; inventoryVersion: number; authorityEpoch: number;
  readOnly: boolean; snapshot: { capturedAt: string; sourceHash: string } | null;
  bookings: unknown[]; nextCursor: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROOMS = ['101', '102', '201', '202', '301', '302'];
const PLATFORM: Record<string, string> = {
  booking: 'booking', 'booking.com': 'booking', agoda: 'agoda',
  airbnb: 'airbnb', line: 'direct', ctrip: 'ctrip',
  owljourney: 'owljourney', owlnest: 'owlnest', '奧丁丁': 'owlnest',
};
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

function snapshotTimestamp(value: unknown): value is string {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

/** The authority and fixed-snapshot preview switches both start closed. */
export function ironGateCalendarConfig(env: NodeJS.ProcessEnv = process.env): IronGateCalendarConfig {
  try {
    const authority = env.IRON_GATE_SWEETFUN_CALENDAR_ENABLED === 'true';
    const preview = env.IRON_GATE_SWEETFUN_CALENDAR_PREVIEW_ENABLED === 'true';
    if (authority === preview) throw Error();
    const grant = JSON.parse(env.IRON_GATE_SWEETFUN_CALENDAR_GRANT ?? 'null') as unknown;
    const roomIds = JSON.parse(env.IRON_GATE_SWEETFUN_ROOM_IDS ?? 'null') as unknown;
    const proofSecret = env.IRON_GATE_SWEETFUN_OS_PROOF_SECRET ?? '';
    const expectedAuthorityEpoch = authority ? Number(env.IRON_GATE_SWEETFUN_AUTHORITY_EPOCH) : 0;
    const expectedInventoryVersion = preview ?
      Number(env.IRON_GATE_SWEETFUN_SNAPSHOT_VERSION) : null;
    const expectedSnapshotHash = preview ?
      env.IRON_GATE_SWEETFUN_SNAPSHOT_HASH ?? null : null;
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
      !Number.isSafeInteger(expectedAuthorityEpoch) ||
      authority && expectedAuthorityEpoch < 1 ||
      preview && (!Number.isSafeInteger(expectedInventoryVersion) ||
        expectedInventoryVersion === null || expectedInventoryVersion < 1 ||
        !expectedSnapshotHash || !SHA256.test(expectedSnapshotHash)))
      throw Error();
    return { baseUrl: baseUrl(env.IRON_GATE_SWEETFUN_BASE_URL ?? ''),
      proofSecret, mode: preview ? 'snapshot_preview' : 'authority',
      expectedAuthorityEpoch, expectedInventoryVersion, expectedSnapshotHash,
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
  send: typeof fetch, maxBytes: number): Promise<unknown> {
  let response: Response;
  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.grant.token}`,
      'x-iron-gate-os-proof': proof(url, config, principal),
    };
    if (config.trustedSourceToken) {
      const target = new URL(url);
      if (target.protocol !== 'https:' ||
        !/^iron-gate-[a-z0-9]+-sweetfuns-projects\.vercel\.app$/.test(target.hostname))
        throw Error('IRON_GATE_CALENDAR_TRUSTED_SOURCE_TARGET');
      headers['x-vercel-trusted-oidc-idp-token'] = config.trustedSourceToken;
    }
    response = await send(url, { method: 'GET', headers,
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
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
    value.authorityEpoch === config.expectedAuthorityEpoch &&
    value.readOnly === (config.mode === 'snapshot_preview') &&
    (config.mode === 'authority' ||
      value.inventoryVersion === config.expectedInventoryVersion &&
      object(value.snapshot) && snapshotTimestamp(value.snapshot.capturedAt) &&
      value.snapshot.sourceHash === config.expectedSnapshotHash) &&
    Array.isArray(value.bookings) && value.bookings.length <= 100 &&
    (value.nextCursor === null || typeof value.nextCursor === 'string' &&
      /^[A-Za-z0-9_-]{1,512}$/.test(value.nextCursor));
}

function calendarBooking(booking: Record<string, unknown>,
  roomNumber: string, stayIndex: number, checkIn: string, checkOut: string,
  snapshotOnly: boolean): CalendarBooking {
  const id = `ig-${booking.id}-${stayIndex}-${roomNumber}`;
  const name = typeof booking.guestName === 'string' && booking.guestName.trim()
    ? booking.guestName.trim() : '姓名待核';
  const source = object(booking.sourceCalendar) ? booking.sourceCalendar : null;
  const rawPlatform = typeof source?.platform === 'string' ? source.platform.trim().toLowerCase() : '';
  const externalOrderNo = typeof source?.externalOrderNo === 'string' &&
    source.externalOrderNo.trim().length <= 128 ? source.externalOrderNo.trim() || null : null;
  const bookedAt = typeof source?.bookedAt === 'string' &&
    DATE.test(source.bookedAt) && date(day(source.bookedAt)) === source.bookedAt
    ? source.bookedAt : null;
  return { id, sheet_row_id: id, order_id: `IG-${booking.id}`,
    external_order_no: externalOrderNo, property_id: 'sweetfun', property_name: '水芳 Sweetfun',
    room_id: `sweetfun-${roomNumber}`, room_number: roomNumber,
    guest_name: name, guest_name_kind: name === '姓名待核' ? 'missing' : 'real',
    platform: PLATFORM[rawPlatform] ??
      (booking.source === 'os' || booking.source === 'line' ? 'direct' : 'other'),
    check_in: checkIn, check_out: checkOut,
    booked_at: bookedAt,
    room_rate: 0, payment_status: 'unknown', reservation_status: 'confirmed',
    notes: null, payments: [], audit_log: [], extra_guest_count: 0,
    extra_bed_count: 0, pet_count: 0, baby_supplies: [], service_note: null,
    source_read_only: true, snapshot_only: snapshotOnly,
    iron_gate_booking_id: String(booking.id),
    iron_gate_booking_version: Number(booking.version),
    iron_gate_source: booking.source as CalendarBooking['iron_gate_source'],
    iron_gate_channel_sync: booking.channelSyncState as CalendarBooking['iron_gate_channel_sync'],
    iron_gate_source_review: booking.sourceReviewRequired === true,
    requirements_known: false, payment_unconfirmed: true,
    source_payment_label: '財務仍以原帳本為準，未遷入此訂房檢視',
    price_hidden: true };
}

function blockedBooking(roomNumber: string, night: string,
  snapshotOnly: boolean): CalendarBooking {
  const id = `ig-block-${roomNumber}-${night}`;
  return { id, sheet_row_id: id, order_id: id, external_order_no: null,
    property_id: 'sweetfun', property_name: '水芳 Sweetfun',
    room_id: `sweetfun-${roomNumber}`, room_number: roomNumber,
    guest_name: '房晚待核', guest_name_kind: 'missing', platform: 'other',
    check_in: night, check_out: date(day(night) + 1), booked_at: null,
    room_rate: 0, payment_status: 'unknown', reservation_status: 'confirmed',
    notes: null, payments: [], audit_log: [], extra_guest_count: 0,
    extra_bed_count: 0, pet_count: 0, baby_supplies: [], service_note: null,
    source_read_only: true, snapshot_only: snapshotOnly,
    source_conflict: true, requirements_known: false,
    payment_unconfirmed: true, price_hidden: true };
}

/** Authoritative booking and occupancy read; any missing page or version drift fails closed. */
export async function readSweetfunIronGateCalendar(start: string, end: string,
  principal: Principal, config: IronGateCalendarConfig,
  send: typeof fetch = fetch): Promise<{ bookings: CalendarBooking[];
    inventoryVersion: number; authorityEpoch: number; soldRoomNights: number;
    blockedRoomNights: number; mode: IronGateCalendarConfig['mode'];
    snapshotCapturedAt: string | null;
    observedAt: string }> {
  const first = day(start), last = day(end);
  if (last <= first || last - first > 1500) throw Error('IRON_GATE_CALENDAR_INVALID_DATE');
  if (!(principal.allProperties || principal.propertyIds.includes('sweetfun')))
    throw Error('IRON_GATE_CALENDAR_FORBIDDEN');
  const origin = baseUrl(config.baseUrl);
  const queryFrom = date(first);
  const path = `/v1/properties/${config.grant.propertyId}/bookings`;
  const makePageUrl = (cursor: string | null) => {
    const url = new URL(path, `${origin}/`);
    url.searchParams.set('limit', '100');
    url.searchParams.set('from', queryFrom);
    url.searchParams.set('to', end);
    if (cursor) url.searchParams.set('cursor', cursor);
    return url.toString();
  };
  let cursor: string | null = null;
  let version: number | null = null;
  let snapshotCapturedAt: string | null = null;
  const seenCursors = new Set<string>();
  const seenBookings = new Set<string>();
  const bookings: CalendarBooking[] = [];
  const sold = new Set<string>();
  const roomById = new Map(Object.entries(config.roomIds).map(([room, id]) => [id, room]));
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    const raw = await getJson(makePageUrl(cursor), config, principal, send, 256 * 1024);
    if (!validPage(raw, config) || version !== null && raw.inventoryVersion !== version)
      throw Error('IRON_GATE_CALENDAR_VERSION_DRIFT');
    version = raw.inventoryVersion;
    if (config.mode === 'snapshot_preview') {
      if (snapshotCapturedAt !== null && raw.snapshot!.capturedAt !== snapshotCapturedAt)
        throw Error('IRON_GATE_CALENDAR_VERSION_DRIFT');
      snapshotCapturedAt = raw.snapshot!.capturedAt;
    }
    for (const item of raw.bookings) {
      if (!object(item) || !UUID.test(String(item.id)) ||
        item.propertyId !== config.grant.propertyId ||
        item.workspaceId !== config.grant.workspaceId ||
        !Number.isSafeInteger(item.version) || Number(item.version) < 1 ||
        !['os', 'line', 'website', 'external'].includes(String(item.source)) ||
        !['not_required', 'pending', 'verified', 'review_required']
          .includes(String(item.channelSyncState)) ||
        typeof item.sourceReviewRequired !== 'boolean' ||
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
              stayIndex, rawStay.checkIn, rawStay.checkOut,
              config.mode === 'snapshot_preview'));
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

  const observed = new Map<string, string>();
  for (let from = first; from < last; from += 31) {
    const to = Math.min(from + 31, last);
    const url = new URL(`/v1/properties/${config.grant.propertyId}/availability`, `${origin}/`);
    url.searchParams.set('from', date(from));
    url.searchParams.set('to', date(to));
    const raw = await getJson(url.toString(), config, principal, send, 128 * 1024);
    if (!object(raw) || raw.propertyId !== config.grant.propertyId ||
      raw.inventoryVersion !== version ||
      raw.authorityEpoch !== config.expectedAuthorityEpoch ||
      !Array.isArray(raw.cells) || raw.cells.length !== ROOMS.length * (to - from))
      throw Error('IRON_GATE_CALENDAR_VERSION_DRIFT');
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
    bookings.push(blockedBooking(roomById.get(roomId)!, night,
      config.mode === 'snapshot_preview'));
  }
  return { bookings, inventoryVersion: version,
    authorityEpoch: config.expectedAuthorityEpoch,
    mode: config.mode, snapshotCapturedAt,
    soldRoomNights: sold.size,
    blockedRoomNights: [...observed.values()].filter(state => state === 'blocked').length,
    observedAt: new Date().toISOString() };
}
