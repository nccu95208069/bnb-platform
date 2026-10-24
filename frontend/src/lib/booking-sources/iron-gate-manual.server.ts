import { createHash, createHmac } from 'node:crypto';
import { ironGateCalendarConfig, type IronGateCalendarConfig } from './iron-gate-calendar.server.ts';
import type { Principal } from '../workspace-auth/types';

export type Grant = { credentialId: string; clientId: string; workspaceId: string;
  propertyId: string; token: string };
export type ManualConfig = { calendar: IronGateCalendarConfig; grant: Grant;
  trustedSourceToken?: string };
type Stay = { checkIn: string; checkOut: string; roomIds: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ROOM_NUMBERS = new Set(['101', '102', '201', '202', '301', '302']);
const MAX_BODY = 16 * 1024;

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw Error('MANUAL_INVALID_INPUT');
}
function date(value: unknown): string {
  if (typeof value !== 'string' || !DATE.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
    throw Error('MANUAL_INVALID_DATE');
  return value;
}
function version(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < min)
    throw Error('MANUAL_INVALID_VERSION');
  return Number(value);
}
function nullable(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
    throw Error('MANUAL_INVALID_INPUT');
  return value;
}
function reason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(value)) throw Error('MANUAL_REASON_REQUIRED');
  return value.trim();
}
function money(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw Error('MANUAL_INVALID_AMOUNT');
  return Number(value);
}
function stays(value: unknown, config: ManualConfig): Stay[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32)
    throw Error('MANUAL_INVALID_STAY');
  const used = new Set<string>();
  return value.map(raw => {
    if (!object(raw)) throw Error('MANUAL_INVALID_STAY');
    exact(raw, ['checkIn', 'checkOut', 'roomNumbers']);
    const checkIn = date(raw.checkIn), checkOut = date(raw.checkOut);
    const length = (Date.parse(`${checkOut}T00:00:00Z`) -
      Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000;
    if (length < 1 || length > 366 || !Array.isArray(raw.roomNumbers) ||
      raw.roomNumbers.length < 1 || raw.roomNumbers.length > 6)
      throw Error('MANUAL_INVALID_STAY');
    const roomIds = raw.roomNumbers.map(number => {
      if (typeof number !== 'string' || !ROOM_NUMBERS.has(number))
        throw Error('MANUAL_INVALID_STAY');
      return config.calendar.roomIds[number];
    });
    for (const roomId of roomIds) for (let n = 0; n < length; n++) {
      const night = new Date(Date.parse(`${checkIn}T00:00:00Z`) + n * 86_400_000)
        .toISOString().slice(0, 10);
      const key = `${roomId}:${night}`;
      if (used.has(key) || used.size >= 4096) throw Error('MANUAL_INVALID_STAY');
      used.add(key);
    }
    return { checkIn, checkOut, roomIds };
  });
}

export function ironGateManualConfig(env: NodeJS.ProcessEnv = process.env): ManualConfig {
  try {
    if (env.IRON_GATE_SWEETFUN_MANUAL_ENABLED !== 'true' ||
      env.CALENDAR_SOURCE !== 'sheet_snapshot') throw Error();
    const calendar = ironGateCalendarConfig(env);
    if (calendar.expectedAuthorityEpoch < 1) throw Error();
    const grant = JSON.parse(env.IRON_GATE_SWEETFUN_MANUAL_GRANT ?? 'null') as unknown;
    if (!object(grant) || Object.keys(grant).sort().join(',') !==
      'clientId,credentialId,propertyId,token,workspaceId' ||
      !UUID.test(String(grant.credentialId)) || !UUID.test(String(grant.clientId)) ||
      grant.workspaceId !== calendar.grant.workspaceId ||
      grant.propertyId !== calendar.grant.propertyId ||
      !TOKEN.test(String(grant.token))) throw Error();
    return { calendar, grant: grant as Grant };
  } catch { throw Error('MANUAL_CONFIG_UNAVAILABLE'); }
}

function member(principal: Principal): void {
  if (!principal.id || !['owner', 'admin', 'god'].includes(principal.role) ||
    !(principal.allProperties || principal.propertyIds.includes('sweetfun')) ||
    !principal.viewPrices) throw Error('MANUAL_FORBIDDEN');
}

export async function callIronGate(config: ManualConfig, principal: Principal,
  method: 'GET' | 'POST' | 'PATCH', path: string, body: unknown,
  requestKey: string | null, send: typeof fetch,
  actions: string[] = ['booking:read', 'booking:create', 'booking:amend', 'booking:cancel'],
  fields: string[] = ['guest_name', 'contact', 'notes', 'money', 'payment_status']
): Promise<Record<string, unknown>> {
  member(principal);
  const url = `${config.calendar.baseUrl}${path}`;
  const payload = body === null ? '' : JSON.stringify(body);
  if (Buffer.byteLength(payload, 'utf8') > MAX_BODY) throw Error('MANUAL_INVALID_INPUT');
  const now = Date.now();
  const claims = { v: 1, aud: 'iron-gate-v1', credentialId: config.grant.credentialId,
    clientId: config.grant.clientId, workspaceId: config.grant.workspaceId,
    propertyId: config.grant.propertyId, subjectId: principal.id,
    actions,
    fields,
    issuedAtMs: now, expiresAtMs: now + 5000, method,
    pathAndQuery: path, idempotencyKey: requestKey,
    bodySha256: createHash('sha256').update(payload).digest('hex') };
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const proof = `${encoded}.${createHmac('sha256', config.calendar.proofSecret)
    .update(encoded).digest('base64url')}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.grant.token}`,
    'x-iron-gate-os-proof': proof,
  };
  if (body !== null) headers['content-type'] = 'application/json';
  if (requestKey) headers['idempotency-key'] = requestKey;
  if (config.trustedSourceToken) {
    const target = new URL(url);
    if (target.protocol !== 'https:' ||
      !/^iron-gate-[a-z0-9]+-sweetfuns-projects\.vercel\.app$/.test(target.hostname))
      throw Error('MANUAL_CONFIG_UNAVAILABLE');
    headers['x-vercel-trusted-oidc-idp-token'] = config.trustedSourceToken;
  }
  let response: Response;
  try {
    response = await send(url, { method, headers, body: body === null ? undefined : payload,
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
  } catch { throw Error(method === 'GET' ? 'MANUAL_READ_UNAVAILABLE' : 'MANUAL_RESULT_UNKNOWN'); }
  let raw: unknown;
  try {
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 512 * 1024)) throw Error();
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 512 * 1024) throw Error();
    raw = JSON.parse(text);
  } catch { throw Error(method === 'GET' ? 'MANUAL_READ_UNAVAILABLE' : 'MANUAL_RESULT_UNKNOWN'); }
  if (!object(raw)) throw Error(method === 'GET' ?
    'MANUAL_READ_UNAVAILABLE' : 'MANUAL_RESULT_UNKNOWN');
  if (method !== 'GET' && response.status >= 500) throw Error('MANUAL_RESULT_UNKNOWN');
  if (!response.ok) {
    const candidate = object(raw.error) ? raw.error.code : null;
    const error = typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(candidate) ?
      candidate : 'MANUAL_WRITE_REJECTED';
    throw Error(error);
  }
  return raw;
}

function bookingPath(config: ManualConfig, bookingId?: string): string {
  return `/v1/properties/${config.grant.propertyId}/bookings${bookingId ? `/${bookingId}` : ''}`;
}
function ensureBooking(raw: Record<string, unknown>, config: ManualConfig, id: string): void {
  if (raw.id !== id || raw.workspaceId !== config.grant.workspaceId ||
    raw.propertyId !== config.grant.propertyId ||
    !Number.isSafeInteger(raw.version) || Number(raw.version) < 1 ||
    !Array.isArray(raw.stays))
    throw Error('MANUAL_READBACK_MISMATCH');
}
function sameStays(a: unknown, b: Stay[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
async function readAfterWrite(config: ManualConfig, principal: Principal,
  bookingId: string, send: typeof fetch) {
  try {
    return await callIronGate(config, principal, 'GET', bookingPath(config, bookingId),
      null, null, send);
  } catch { throw Error('MANUAL_RESULT_UNKNOWN'); }
}

async function checkLocalNights(principal: Principal, config: ManualConfig,
  wanted: Stay[], expectedInventoryVersion: number, send: typeof fetch,
  own: Stay[] = []) {
  const from = wanted.map(stay => stay.checkIn).sort()[0];
  const to = wanted.map(stay => stay.checkOut).sort().at(-1)!;
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
    86_400_000;
  if (days > 410) throw Error('MANUAL_DATE_RANGE_TOO_WIDE');
  const snapshot = await callIronGate(config, principal, 'GET',
    `/v1/properties/${config.grant.propertyId}/calendar-snapshot?from=${from}&to=${to}`,
    null, null, send);
  if (snapshot.propertyId !== config.grant.propertyId ||
    snapshot.workspaceId !== config.grant.workspaceId || snapshot.readOnly !== false ||
    snapshot.authorityEpoch !== config.calendar.expectedAuthorityEpoch ||
    snapshot.inventoryVersion !== expectedInventoryVersion ||
    !Array.isArray(snapshot.cells)) throw Error('MANUAL_VERSION_CONFLICT');
  const ownNights = new Set<string>();
  for (const stay of own) for (const roomId of stay.roomIds)
    for (let n = Date.parse(`${stay.checkIn}T00:00:00Z`);
      n < Date.parse(`${stay.checkOut}T00:00:00Z`); n += 86_400_000)
      ownNights.add(`${roomId}:${new Date(n).toISOString().slice(0, 10)}`);
  const blocked = new Set(snapshot.cells.map(cell => object(cell) &&
    (cell.state !== 'sold' || !ownNights.has(`${cell.roomId}:${cell.date}`)) ?
    `${cell.roomId}:${cell.date}` : object(cell) ? '' : 'invalid'));
  if (blocked.has('invalid')) throw Error('MANUAL_READ_UNAVAILABLE');
  for (const stay of wanted) for (const roomId of stay.roomIds) {
    for (let n = Date.parse(`${stay.checkIn}T00:00:00Z`);
      n < Date.parse(`${stay.checkOut}T00:00:00Z`); n += 86_400_000) {
      if (blocked.has(`${roomId}:${new Date(n).toISOString().slice(0, 10)}`))
        throw Error('ROOM_CONFLICT');
    }
  }
  return { inventoryVersion: snapshot.inventoryVersion,
    authorityEpoch: snapshot.authorityEpoch, roomNights: wanted.reduce((sum, stay) =>
      sum + stay.roomIds.length * (Date.parse(`${stay.checkOut}T00:00:00Z`) -
        Date.parse(`${stay.checkIn}T00:00:00Z`)) / 86_400_000, 0) };
}

export async function previewManualBooking(principal: Principal, config: ManualConfig,
  input: unknown, send: typeof fetch = fetch) {
  if (!object(input)) throw Error('MANUAL_INVALID_INPUT');
  exact(input, ['expectedInventoryVersion', 'stays']);
  const expectedInventoryVersion = version(input.expectedInventoryVersion);
  const wanted = stays(input.stays, config);
  const checked = await checkLocalNights(principal, config, wanted,
    expectedInventoryVersion, send);
  return { ...checked, localRoomNightsAvailable: true,
    externalStockVerified: false, channelEffect: 'manual_sync_required' };
}

export async function previewManualAmend(principal: Principal, config: ManualConfig,
  bookingId: string, input: unknown, send: typeof fetch = fetch) {
  if (!UUID.test(bookingId) || !object(input)) throw Error('MANUAL_INVALID_INPUT');
  exact(input, ['expectedBookingVersion', 'expectedInventoryVersion', 'stays']);
  const before = await callIronGate(config, principal, 'GET', bookingPath(config, bookingId),
    null, null, send);
  ensureBooking(before, config, bookingId);
  if (before.source !== 'os' || before.status !== 'confirmed' ||
    before.version !== input.expectedBookingVersion) throw Error('MANUAL_VERSION_CONFLICT');
  if (before.sourceReviewRequired === true ||
    !['verified', 'not_required', 'awaiting_manual_sync'].includes(String(before.channelSyncState)))
    throw Error('CHANNEL_AMENDMENT_NOT_READY');
  const wanted = stays(input.stays, config);
  const checked = await checkLocalNights(principal, config, wanted,
    version(input.expectedInventoryVersion), send, before.stays as Stay[]);
  return { ...checked, bookingVersion: before.version,
    localRoomNightsAvailable: true, externalStockVerified: false,
    channelEffect: before.channelSyncState === 'awaiting_manual_sync' ?
      'manual_sync_required' : 'close_new_then_open_old_pending_readback' };
}

export async function createManualBooking(principal: Principal, config: ManualConfig,
  input: unknown, requestKey: string, send: typeof fetch = fetch) {
  if (!UUID.test(requestKey) || !object(input)) throw Error('MANUAL_INVALID_INPUT');
  exact(input, ['expectedInventoryVersion', 'stays', 'guestName', 'contact',
    'notes', 'totalCents', 'bookedAt']);
  const expectedInventoryVersion = version(input.expectedInventoryVersion);
  const wanted = stays(input.stays, config);
  const guestName = nullable(input.guestName, 200)?.trim();
  const totalCents = money(input.totalCents);
  if (!guestName) throw Error('MANUAL_GUEST_NAME_REQUIRED');
  if (totalCents === null) throw Error('MANUAL_PRICE_REQUIRED');
  const payload = { expectedInventoryVersion, stays: wanted,
    guestName, contact: nullable(input.contact, 256),
    notes: nullable(input.notes, 2048), totalCents,
    bookedAt: input.bookedAt == null ? null : date(input.bookedAt), source: 'os' };
  await checkLocalNights(principal, config, wanted, expectedInventoryVersion, send);
  const result = await callIronGate(config, principal, 'POST', bookingPath(config), payload,
    requestKey, send);
  if (!UUID.test(String(result.bookingId))) throw Error('MANUAL_READBACK_MISMATCH');
  const observed = await readAfterWrite(config, principal, String(result.bookingId), send);
  ensureBooking(observed, config, String(result.bookingId));
  if (observed.status !== 'confirmed' || !sameStays(observed.stays, wanted) ||
    observed.source !== 'os' || observed.version !== result.bookingVersion ||
    !['awaiting_manual_sync', 'local_only'].includes(String(result.operationState)) ||
    (result.operationState === 'awaiting_manual_sync' &&
      observed.channelSyncState !== 'awaiting_manual_sync') ||
    (result.operationState === 'local_only' &&
      observed.channelSyncState !== 'not_required') ||
    observed.guestName !== payload.guestName || observed.contact !== payload.contact ||
    observed.notes !== payload.notes || observed.totalCents !== payload.totalCents ||
    observed.bookedAt !== payload.bookedAt)
    throw Error('MANUAL_READBACK_MISMATCH');
  return { bookingId: result.bookingId, bookingVersion: observed.version,
    inventoryVersion: result.inventoryVersion, operationState: result.operationState,
    channelSyncState: observed.channelSyncState, requestKey };
}

export async function startManualRoomSync(principal: Principal, config: ManualConfig,
  bookingId: string, input: unknown, requestKey: string, send: typeof fetch = fetch) {
  if (!UUID.test(bookingId) || !UUID.test(requestKey) || !object(input))
    throw Error('MANUAL_INVALID_INPUT');
  exact(input, ['expectedBookingVersion', 'expectedInventoryVersion']);
  const expectedBookingVersion = version(input.expectedBookingVersion, 1);
  const expectedInventoryVersion = version(input.expectedInventoryVersion);
  const before = await callIronGate(config, principal, 'GET', bookingPath(config, bookingId),
    null, null, send);
  ensureBooking(before, config, bookingId);
  if (before.version !== expectedBookingVersion || before.source !== 'os' ||
    before.status !== 'confirmed' ||
    before.channelSyncState !== 'awaiting_manual_sync' ||
    before.sourceReviewRequired === true) throw Error('CHANNEL_SYNC_NOT_READY');
  const result = await callIronGate(config, principal, 'POST',
    `${bookingPath(config, bookingId)}/sync-room-status`,
    { expectedBookingVersion, expectedInventoryVersion }, requestKey, send);
  if (result.operationState !== 'sync_pending' ||
    result.bookingVersion !== before.version ||
    !UUID.test(String(result.operationKey)))
    throw Error('MANUAL_READBACK_MISMATCH');
  const after = await readAfterWrite(config, principal, bookingId, send);
  ensureBooking(after, config, bookingId);
  const pending = Number(after.version) >= Number(before.version) &&
    after.channelSyncState === 'pending';
  const verified = Number(after.version) > Number(before.version) &&
    after.channelSyncState === 'verified';
  const reviewRequired = Number(after.version) >= Number(before.version) &&
    after.channelSyncState === 'review_required';
  if (!(pending || verified || reviewRequired) || after.status !== 'confirmed' ||
    after.channelOperationKey !== result.operationKey ||
    !sameStays(after.stays, before.stays as Stay[]))
    throw Error('MANUAL_READBACK_MISMATCH');
  return { bookingId, bookingVersion: after.version,
    inventoryVersion: result.inventoryVersion,
    operationState: verified ? 'sync_verified' : reviewRequired ? 'review_required' : result.operationState,
    channelSyncState: after.channelSyncState, requestKey };
}

export async function amendManualBooking(principal: Principal, config: ManualConfig,
  bookingId: string, input: unknown, requestKey: string, send: typeof fetch = fetch) {
  if (!UUID.test(bookingId) || !UUID.test(requestKey) || !object(input))
    throw Error('MANUAL_INVALID_INPUT');
  exact(input, ['expectedBookingVersion', 'expectedInventoryVersion', 'changes', 'reason']);
  if (!object(input.changes)) throw Error('MANUAL_INVALID_INPUT');
  exact(input.changes, ['stays', 'guestName', 'contact', 'notes', 'totalCents']);
  const changes: Record<string, unknown> = {};
  if ('stays' in input.changes) changes.stays = stays(input.changes.stays, config);
  if ('guestName' in input.changes) changes.guestName = nullable(input.changes.guestName, 200);
  if ('contact' in input.changes) changes.contact = nullable(input.changes.contact, 256);
  if ('notes' in input.changes) changes.notes = nullable(input.changes.notes, 2048);
  if ('totalCents' in input.changes) changes.totalCents = money(input.changes.totalCents);
  if (!Object.keys(changes).length) throw Error('MANUAL_INVALID_INPUT');
  const before = await callIronGate(config, principal, 'GET', bookingPath(config, bookingId),
    null, null, send);
  ensureBooking(before, config, bookingId);
  const externalNameOnly = before.source === 'external';
  if (!['os', 'external'].includes(String(before.source)) || before.status !== 'confirmed' ||
    before.version !== input.expectedBookingVersion) throw Error('MANUAL_VERSION_CONFLICT');
  if (before.sourceReviewRequired === true ||
    !['verified', 'not_required', 'awaiting_manual_sync'].includes(String(before.channelSyncState)))
    throw Error('CHANNEL_AMENDMENT_NOT_READY');
  if (externalNameOnly) {
    if (Object.keys(changes).length !== 1 || typeof changes.guestName !== 'string' ||
      !changes.guestName.trim() || changes.guestName.trim() === before.guestName)
      throw Error('SOURCE_AMEND_REQUIRES_REVIEW');
    changes.guestName = changes.guestName.trim();
  }
  const payload = { expectedBookingVersion: version(input.expectedBookingVersion, 1),
    expectedInventoryVersion: version(input.expectedInventoryVersion),
    changes, reason: reason(input.reason) };
  const result = await callIronGate(config, principal, 'PATCH', bookingPath(config, bookingId),
    payload, requestKey, send);
  const after = await readAfterWrite(config, principal, bookingId, send);
  ensureBooking(after, config, bookingId);
  if (after.status !== 'confirmed' || after.version !== result.bookingVersion ||
    Object.entries(changes).some(([field, value]) => field === 'stays' ?
      !sameStays(after.stays, value as Stay[]) : after[field] !== value))
    throw Error('MANUAL_READBACK_MISMATCH');
  if (externalNameOnly && (after.source !== 'external' ||
    after.sourceReviewRequired !== true || after.channelSyncState !== before.channelSyncState ||
    !sameStays(after.stays, before.stays as Stay[]) ||
    after.contact !== before.contact || after.notes !== before.notes ||
    after.totalCents !== before.totalCents || after.bookedAt !== before.bookedAt))
    throw Error('MANUAL_READBACK_MISMATCH');
  return { bookingId, bookingVersion: after.version, inventoryVersion: result.inventoryVersion,
    operationState: result.operationState, channelSyncState: after.channelSyncState, requestKey };
}

export async function cancelManualBooking(principal: Principal, config: ManualConfig,
  bookingId: string, input: unknown, requestKey: string, send: typeof fetch = fetch) {
  if (!UUID.test(bookingId) || !UUID.test(requestKey) || !object(input))
    throw Error('MANUAL_INVALID_INPUT');
  exact(input, ['expectedBookingVersion', 'expectedInventoryVersion', 'reason']);
  const before = await callIronGate(config, principal, 'GET', bookingPath(config, bookingId),
    null, null, send);
  ensureBooking(before, config, bookingId);
  if (before.source !== 'os' || before.status !== 'confirmed' ||
    before.version !== input.expectedBookingVersion) throw Error('MANUAL_VERSION_CONFLICT');
  if (before.sourceReviewRequired === true ||
    !['verified', 'not_required', 'awaiting_manual_sync'].includes(String(before.channelSyncState)))
    throw Error('CHANNEL_CANCELLATION_NOT_READY');
  const payload = { expectedBookingVersion: version(input.expectedBookingVersion, 1),
    expectedInventoryVersion: version(input.expectedInventoryVersion), reason: reason(input.reason) };
  const result = await callIronGate(config, principal, 'POST',
    `${bookingPath(config, bookingId)}/cancel`, payload, requestKey, send);
  const after = await readAfterWrite(config, principal, bookingId, send);
  ensureBooking(after, config, bookingId);
  if (after.status !== 'cancelled' || after.version !== result.bookingVersion)
    throw Error('MANUAL_READBACK_MISMATCH');
  return { bookingId, bookingVersion: after.version, inventoryVersion: result.inventoryVersion,
    operationState: result.operationState, channelSyncState: after.channelSyncState, requestKey };
}

export async function manualRequestResult(principal: Principal, config: ManualConfig,
  requestKey: string, send: typeof fetch = fetch) {
  if (!UUID.test(requestKey)) throw Error('MANUAL_INVALID_INPUT');
  return callIronGate(config, principal, 'GET',
    `/v1/properties/${config.grant.propertyId}/requests/${requestKey}`, null, null, send);
}

export async function readManualBooking(principal: Principal, config: ManualConfig,
  bookingId: string, send: typeof fetch = fetch) {
  if (!UUID.test(bookingId)) throw Error('MANUAL_INVALID_INPUT');
  const booking = await callIronGate(config, principal, 'GET',
    bookingPath(config, bookingId), null, null, send);
  ensureBooking(booking, config, bookingId);
  const bookingStays = booking.stays as unknown[];
  const roomById = new Map(Object.entries(config.calendar.roomIds)
    .map(([number, id]) => [id, number]));
  if (!bookingStays.every(stay => object(stay) &&
    typeof stay.checkIn === 'string' && typeof stay.checkOut === 'string' &&
    Array.isArray(stay.roomIds) && stay.roomIds.every(id => roomById.has(String(id)))))
    throw Error('MANUAL_READBACK_MISMATCH');
  return { bookingId, version: booking.version, status: booking.status,
    source: booking.source, channelSyncState: booking.channelSyncState,
    sourceReviewRequired: booking.sourceReviewRequired === true,
    guestName: booking.guestName ?? null, contact: booking.contact ?? null,
    notes: booking.notes ?? null, totalCents: booking.totalCents ?? null,
    netReceivedCents: object(booking.paymentSummary) &&
      Number.isSafeInteger(booking.paymentSummary.netReceivedCents)
      ? booking.paymentSummary.netReceivedCents : null,
    bookedAt: booking.bookedAt ?? null,
    stays: bookingStays.map(stay => {
      const item = stay as { checkIn: string; checkOut: string; roomIds: string[] };
      return { checkIn: item.checkIn, checkOut: item.checkOut,
        roomNumbers: item.roomIds.map(id => roomById.get(id)!) };
    }) };
}
