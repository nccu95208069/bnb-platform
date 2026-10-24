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
  mode: 'authority' | 'snapshot_preview';
  expectedAuthorityEpoch: number;
  expectedInventoryVersion: number | null;
  expectedSnapshotHash: string | null;
  grant: ReadGrant;
  roomIds: Record<string, string>;
};

type Page = { propertyId: string; inventoryVersion: number; authorityEpoch: number;
  readOnly: boolean; snapshot: { capturedAt: string; sourceHash: string } | null;
  bookings: unknown[]; nextCursor: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[0-9a-f]{64}$/;
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

function snapshotTimestamp(value: unknown): value is string {
  return typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function optionalDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { day(value); return value; } catch { return null; }
}

function paymentOrderId(bookingId: string, ref: unknown, viewPrices: boolean): string {
  if (!viewPrices || typeof ref !== 'string' ||
    !/^(?:L:[A-Za-z0-9-]{8,64}|J:[A-Za-z0-9_-]{8,100})$/.test(ref))
    return `IG-${bookingId}`;
  const original = ref.startsWith('L:') ? ref.slice(2) : `ungrouped:${ref.slice(2)}`;
  return `SF-${createHash('sha256').update(`sweetfun-operations-sheet-v1:order:${original}`)
    .digest('hex').slice(0, 20)}`;
}

function baseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1'))
    throw Error('IRON_GATE_CALENDAR_CONFIG_INVALID');
  return url.origin;
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
    actions: ['booking:read'], fields: principal.viewPrices ?
      ['guest_name', 'payment_status', 'money'] : ['guest_name'],
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
  viewPrices: boolean, snapshotOnly = false): CalendarBooking {
  const id = `ig-${booking.id}-${stayIndex}-${roomNumber}`;
  const name = typeof booking.guestName === 'string' && booking.guestName.trim()
    ? booking.guestName.trim() : '姓名待核';
  const source = object(booking.sourceCalendar) ? booking.sourceCalendar : null;
  const manualSource = booking.source === 'os';
  const sourceOrderRef = typeof source?.sourceOrderRef === 'string' &&
    /^(?:L:[A-Za-z0-9-]{8,64}|J:[A-Za-z0-9_-]{8,100})$/.test(source.sourceOrderRef)
    ? source.sourceOrderRef : null;
  const paymentId = paymentOrderId(String(booking.id), viewPrices ? sourceOrderRef : null, viewPrices);
  const notificationId = viewPrices ?
    paymentOrderId(String(booking.id), sourceOrderRef, true) : undefined;
  const review = viewPrices && object(booking.paymentReview) ? booking.paymentReview : null;
  const paymentStatus = review && ['paid', 'deposit'].includes(String(review.status)) &&
    ['sheet_flag', 'payment_events'].includes(String(review.source))
    ? review.status as 'paid' | 'deposit' : 'unknown';
  const paymentSource = paymentStatus !== 'unknown' ? String(review?.source) : 'unknown';
  const amounts = booking.stayAmountsCents;
  const priced = viewPrices && Array.isArray(amounts) &&
    amounts.length === (booking.stays as unknown[]).length &&
    Number.isSafeInteger(booking.totalCents) && Number(booking.totalCents) >= 0 &&
    amounts.every(value => Number.isSafeInteger(value) && value >= 0) &&
    amounts.reduce((sum: number, value: number) => sum + value, 0) === booking.totalCents;
  const cents = priced ? Number(amounts[stayIndex]) : 0;
  const orderTotalCents = viewPrices && booking.currency === 'TWD' &&
    Number.isSafeInteger(booking.totalCents) && Number(booking.totalCents) >= 0 &&
    Number(booking.totalCents) <= 1_000_000_000_000
    ? Number(booking.totalCents) : undefined;
  return { id, sheet_row_id: id, order_id: `IG-${booking.id}`,
    notification_order_id: notificationId,
    payment_order_id: paymentId,
    source_booking_version: Number.isSafeInteger(booking.version) && Number(booking.version) >= 1
      ? Number(booking.version) : undefined,
    iron_gate_booking_id: String(booking.id),
    iron_gate_booking_version: Number(booking.version),
    iron_gate_source: booking.source as CalendarBooking['iron_gate_source'],
    iron_gate_channel_sync: booking.channelSyncState as CalendarBooking['iron_gate_channel_sync'],
    iron_gate_source_review: booking.sourceReviewRequired === true,
    source_legacy_payment: viewPrices && !!sourceOrderRef,
    owlnest_order_no: viewPrices && sourceOrderRef?.startsWith('L:') ? sourceOrderRef.slice(2) : null,
    external_order_no: viewPrices && typeof source?.externalOrderNo === 'string'
      ? source.externalOrderNo : null,
    property_id: 'sweetfun', property_name: '水芳 Sweetfun',
    room_id: `sweetfun-${roomNumber}`, room_number: roomNumber,
    guest_name: name, guest_name_kind: name === '姓名待核' ? 'missing' : 'real',
    platform: manualSource ? 'direct' : sweetfunCalendarPlatform(source?.platform), check_in: checkIn, check_out: checkOut,
    booked_at: optionalDate(source?.bookedAt ?? booking.bookedAt),
    room_rate: cents / 100,
    source_order_total_cents: orderTotalCents,
    payment_status: paymentStatus, reservation_status: 'confirmed',
    notes: null, payments: [], audit_log: [], extra_guest_count: 0,
    extra_bed_count: 0, pet_count: 0, baby_supplies: [], service_note: null,
    source_read_only: true, snapshot_only: snapshotOnly,
    channel_sync_state: ['not_required', 'action_required', 'pending', 'verified',
      'review_required'].includes(String(booking.channelSyncState))
      ? booking.channelSyncState as CalendarBooking['channel_sync_state'] : undefined,
    channel_pending_nights: Array.isArray(booking.lineChannelPending)
      ? booking.lineChannelPending.length : 0,
    requirements_known: false, payment_unconfirmed: true,
    payment_review_status: paymentStatus !== 'unknown' ? paymentStatus : undefined,
    source_payment_flag: paymentSource === 'sheet_flag' ? 'done' : 'unknown',
    source_payment_label: paymentSource === 'sheet_flag'
      ? '原始訂房表標記客人已付清；這不是實際收款或 OTA 入帳紀錄'
      : paymentSource === 'payment_events'
        ? '依已核對收款紀錄顯示；實際入帳仍需對帳'
        : '付款資料尚未核對，請勿視為未付款',
    price_hidden: !priced };
}

function blockedBooking(roomNumber: string, night: string,
  snapshotOnly = false): CalendarBooking {
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

export type IronGatePaymentOrder = {
  bookingId: string;
  paymentOrderId: string;
  version: number;
  totalCents: number;
  rooms: string[];
  nights: number;
  sourcePaid: boolean;
  legacyImported: boolean;
};

/** Confirm that a calendar order still exists and is active before recording manual contact. */
export async function readSweetfunIronGateNotificationOrder(bookingId: string,
  principal: Principal, config: IronGateCalendarConfig,
  send: typeof fetch = fetch): Promise<string> {
  if (!UUID.test(bookingId) ||
    !(principal.allProperties || principal.propertyIds.includes('sweetfun')))
    throw Error('IRON_GATE_CALENDAR_FORBIDDEN');
  const url = new URL(`/v1/properties/${config.grant.propertyId}/bookings/${bookingId}`,
    `${baseUrl(config.baseUrl)}/`);
  const raw = await getJson(url.toString(), config, principal, send, 64 * 1024, 8000);
  if (!object(raw) || raw.id !== bookingId ||
    raw.propertyId !== config.grant.propertyId || raw.workspaceId !== config.grant.workspaceId ||
    raw.status !== 'confirmed' || !Number.isSafeInteger(raw.version) || Number(raw.version) < 1 ||
    !Array.isArray(raw.stays) || raw.stays.length < 1 || raw.stays.length > 32)
    throw Error('IRON_GATE_NOTIFICATION_SOURCE_INVALID');
  const knownRooms = new Set(Object.values(config.roomIds));
  for (const stay of raw.stays) {
    if (!object(stay) || typeof stay.checkIn !== 'string' ||
      typeof stay.checkOut !== 'string' || !Array.isArray(stay.roomIds) ||
      stay.roomIds.length < 1 || stay.roomIds.length > ROOMS.length ||
      stay.roomIds.some(id => !knownRooms.has(String(id))))
      throw Error('IRON_GATE_NOTIFICATION_SOURCE_INVALID');
    try {
      if (day(stay.checkOut) <= day(stay.checkIn))
        throw Error('IRON_GATE_NOTIFICATION_SOURCE_INVALID');
    } catch { throw Error('IRON_GATE_NOTIFICATION_SOURCE_INVALID'); }
  }
  const source = object(raw.sourceCalendar) ? raw.sourceCalendar : null;
  return paymentOrderId(bookingId, source?.sourceOrderRef, true);
}

/** Re-read the exact Iron Gate booking before any OS receipt is recorded. */
export async function readSweetfunIronGatePaymentOrder(bookingId: string,
  principal: Principal, config: IronGateCalendarConfig,
  send: typeof fetch = fetch): Promise<IronGatePaymentOrder> {
  if (!UUID.test(bookingId) || !principal.viewPrices)
    throw Error('IRON_GATE_PAYMENT_FORBIDDEN');
  const url = new URL(`/v1/properties/${config.grant.propertyId}/bookings/${bookingId}`,
    `${baseUrl(config.baseUrl)}/`);
  const raw = await getJson(url.toString(), config, principal, send, 64 * 1024, 8000);
  if (!object(raw) || raw.id !== bookingId ||
    raw.propertyId !== config.grant.propertyId || raw.workspaceId !== config.grant.workspaceId ||
    raw.status !== 'confirmed' || !Number.isSafeInteger(raw.version) || Number(raw.version) < 1 ||
    raw.currency !== 'TWD' || !Number.isSafeInteger(raw.totalCents) ||
    Number(raw.totalCents) < 0 || Number(raw.totalCents) > 1_000_000_000_000 ||
    !Array.isArray(raw.stays) || raw.stays.length < 1 || raw.stays.length > 32)
    throw Error('IRON_GATE_PAYMENT_SOURCE_INVALID');
  const roomById = new Map(Object.entries(config.roomIds).map(([room, id]) => [id, room]));
  const rooms = new Set<string>(), occupied = new Set<string>();
  for (const stay of raw.stays) {
    if (!object(stay) || typeof stay.checkIn !== 'string' ||
      typeof stay.checkOut !== 'string' || !Array.isArray(stay.roomIds) ||
      stay.roomIds.length < 1 || stay.roomIds.length > ROOMS.length)
      throw Error('IRON_GATE_PAYMENT_SOURCE_INVALID');
    const from = day(stay.checkIn), to = day(stay.checkOut);
    if (to <= from || to - from > 366) throw Error('IRON_GATE_PAYMENT_SOURCE_INVALID');
    for (const rawId of stay.roomIds) {
      const room = roomById.get(String(rawId));
      if (!room) throw Error('IRON_GATE_PAYMENT_SOURCE_INVALID');
      rooms.add(room);
      for (let n = from; n < to; n++) {
        const slot = `${room}:${n}`;
        if (occupied.has(slot)) throw Error('IRON_GATE_PAYMENT_SOURCE_INVALID');
        occupied.add(slot);
      }
    }
  }
  const review = object(raw.paymentReview) ? raw.paymentReview : null;
  if (review && (!['paid', 'deposit', 'unknown'].includes(String(review.status)) ||
    !['sheet_flag', 'payment_events', 'unknown'].includes(String(review.source))))
    throw Error('IRON_GATE_PAYMENT_SOURCE_INVALID');
  const source = object(raw.sourceCalendar) ? raw.sourceCalendar : null;
  const ref = source?.sourceOrderRef;
  const paymentId = paymentOrderId(bookingId, ref, true);
  if (ref !== undefined && raw.version !== 1) throw Error('SOURCE_CHANGED');
  if (ref !== undefined && paymentId === `IG-${bookingId}`)
    throw Error('IRON_GATE_PAYMENT_SOURCE_INVALID');
  return { bookingId, paymentOrderId: paymentId, version: Number(raw.version),
    totalCents: Number(raw.totalCents), rooms: [...rooms].sort(), nights: occupied.size,
    sourcePaid: review?.status === 'paid', legacyImported: paymentId.startsWith('SF-') };
}

/** A single Iron Gate state read supplies both bookings and sparse occupancy. */
export async function readSweetfunIronGateCalendarSnapshot(start: string, end: string,
  principal: Principal, config: IronGateCalendarConfig,
  send: typeof fetch = fetch): Promise<{ bookings: CalendarBooking[];
    inventoryVersion: number; authorityEpoch: number; soldRoomNights: number;
    blockedRoomNights: number; observedAt: string }> {
  if (config.mode !== 'authority') throw Error('IRON_GATE_CALENDAR_CONFIG_INVALID');
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
            rawStay.checkIn, rawStay.checkOut, principal.viewPrices));
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
    blockedRoomNights: number; mode: IronGateCalendarConfig['mode'];
    snapshotCapturedAt: string | null;
    observedAt: string }> {
  const first = day(start), last = day(end);
  if (last <= first || last - first > 1500) throw Error('IRON_GATE_CALENDAR_INVALID_DATE');
  if (!(principal.allProperties || principal.propertyIds.includes('sweetfun')))
    throw Error('IRON_GATE_CALENDAR_FORBIDDEN');
  const origin = baseUrl(config.baseUrl);
  const queryFrom = date(config.mode === 'snapshot_preview' ? first : first - 1);
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
  let snapshotCapturedAt: string | null = null;
  const seenCursors = new Set<string>();
  const seenBookings = new Set<string>();
  const bookings: CalendarBooking[] = [];
  const sold = new Set<string>();
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
              stayIndex, rawStay.checkIn, rawStay.checkOut, principal.viewPrices,
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
  if (!validPage(head, config) || head.inventoryVersion !== version ||
    config.mode === 'snapshot_preview' && head.snapshot!.capturedAt !== snapshotCapturedAt)
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
