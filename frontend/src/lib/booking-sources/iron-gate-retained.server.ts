import { createHash } from 'node:crypto';
import { callIronGate, type Grant, type ManualConfig } from './iron-gate-manual.server.ts';
import { offlandIronGateCalendarConfig } from './iron-gate-calendar.server.ts';
import type { Principal } from '../workspace-auth/types';
import type { RetainedBookingDetail, RetainedBookingPreview, RetainedBookingRequestResult,
  RetainedBookingsResponse, RetainedStay, RetainedNightPrice, RetentionHistory } from './retained-booking-contract';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OFFLAND_IMPORT_REF = /^(?:Q:[A-Za-z0-9-]{8,128}|J:[A-Za-z0-9_-]{8,100})$/;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const fail = (code = 'MANUAL_READBACK_MISMATCH'): never => { throw Error(code); };
function integer(v: unknown, min = 0): number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min ? v : fail();
}
function amount(v: unknown): number | null { return v == null ? null : integer(v); }
function text(v: unknown, max = 500): string | null {
  return v == null ? null : typeof v === 'string' && v.length <= max ? v : fail();
}
function day(v: unknown): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    !Number.isFinite(Date.parse(`${v}T00:00:00Z`)) ||
    new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) return fail();
  return v;
}
function timestamp(v: unknown): string {
  if (typeof v !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(v) ||
    !Number.isFinite(Date.parse(v))) return fail();
  return v;
}

/** Separate booking grant: enabling this feature never enables lodging payments. */
export function offlandRetainedConfig(env: NodeJS.ProcessEnv = process.env): ManualConfig {
  try {
    if (env.IRON_GATE_OFFLAND_RETAINED_ENABLED !== 'true' ||
      env.CALENDAR_SOURCE !== 'sheet_snapshot') throw Error();
    const calendar = offlandIronGateCalendarConfig(env);
    if (calendar.mode !== 'authority' || calendar.expectedAuthorityEpoch < 1) throw Error();
    const grant = JSON.parse(env.IRON_GATE_OFFLAND_RETAINED_GRANT ?? 'null') as unknown;
    if (!object(grant) || Object.keys(grant).sort().join(',') !==
      'clientId,credentialId,propertyId,token,workspaceId' ||
      !UUID.test(String(grant.credentialId)) || !UUID.test(String(grant.clientId)) ||
      grant.workspaceId !== calendar.grant.workspaceId || grant.propertyId !== calendar.grant.propertyId ||
      !/^[A-Za-z0-9_-]{43}$/.test(String(grant.token))) throw Error();
    return { calendar, grant: grant as Grant };
  } catch { throw Error('MANUAL_CONFIG_UNAVAILABLE'); }
}

export function canWriteRetained(principal: Principal): boolean {
  return !!principal.id && principal.viewPrices && ['owner', 'admin', 'god'].includes(principal.role) &&
    (principal.allProperties || principal.propertyIds.includes('offland'));
}
function scope(config: ManualConfig, actor: Principal, write = false) {
  if (config.calendar.propertyKey !== 'offland' || config.calendar.mode !== 'authority' ||
    config.grant.propertyId !== config.calendar.grant.propertyId ||
    config.grant.workspaceId !== config.calendar.grant.workspaceId) fail('MANUAL_CONFIG_UNAVAILABLE');
  if (!actor.id || !(actor.allProperties || actor.propertyIds.includes('offland')) ||
    write && !canWriteRetained(actor)) fail('MANUAL_FORBIDDEN');
}
function path(config: ManualConfig, id?: string) {
  if (id && !UUID.test(id)) fail('MANUAL_INVALID_INPUT');
  return `/v1/properties/${config.grant.propertyId}/bookings${id ? `/${id}` : ''}`;
}
async function call(config: ManualConfig, actor: Principal, route: string,
  body: unknown, key: string | null, send: typeof fetch) {
  const write = body !== null;
  scope(config, actor, write);
  const writer = canWriteRetained(actor);
  return callIronGate(config, actor, write ? 'POST' : 'GET', route, body, key, send,
    writer ? ['booking:read', 'booking:amend'] : ['booking:read'],
    actor.viewPrices ? ['guest_name', 'contact', 'notes', 'money', 'payment_status'] : ['guest_name'],
    2_100_000, writer ? 'write' : 'read');
}
function projectedStays(value: unknown, config: ManualConfig): RetainedStay[] {
  if (!Array.isArray(value) || value.length > 32) return fail();
  const names = new Map(Object.entries(config.calendar.roomIds).map(([name, id]) => [id, name]));
  const cells = new Set<string>();
  return value.map(item => {
    if (!object(item) || !Array.isArray(item.roomIds) || !item.roomIds.length) return fail();
    const checkIn = day(item.checkIn), checkOut = day(item.checkOut);
    const nights = (Date.parse(checkOut) - Date.parse(checkIn)) / 86_400_000;
    if (nights < 1 || nights > 366) return fail();
    const roomNumbers = item.roomIds.map(id => {
      if (typeof id !== 'string' || !names.has(id)) return fail();
      for (let n = Date.parse(checkIn); n < Date.parse(checkOut); n += 86_400_000) {
        const key = `${id}:${n}`;
        if (cells.has(key) || cells.size >= 4096) return fail();
        cells.add(key);
      }
      return names.get(id)!;
    });
    return { checkIn, checkOut, roomNumbers };
  });
}
function projectedPrices(value: unknown, config: ManualConfig): RetainedNightPrice[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 4096) return fail();
  const names = new Map(Object.entries(config.calendar.roomIds).map(([name, id]) => [id, name]));
  return value.map(item => {
    if (!object(item) || typeof item.roomId !== 'string' || !names.has(item.roomId)) return fail();
    return { roomNumber: names.get(item.roomId)!, date: day(item.date), amountCents: integer(item.amountCents) };
  });
}

/** Whitelist public fields again, even if an upstream response was overbroad. */
export function retainedBookingDetail(raw: unknown, config: ManualConfig,
  actor: Principal): RetainedBookingDetail {
  scope(config, actor);
  if (!object(raw) || !UUID.test(String(raw.id)) || raw.propertyId !== config.grant.propertyId ||
    raw.workspaceId !== config.grant.workspaceId ||
    !['confirmed', 'retained', 'cancelled'].includes(String(raw.status))) return fail();
  const status = raw.status as RetainedBookingDetail['status'];
  const stays = projectedStays(raw.stays, config);
  if (status === 'retained' ? stays.length !== 0 : stays.length === 0) return fail();
  let retention: RetainedBookingDetail['retention'] = null;
  if (raw.retention != null) {
    const r = raw.retention;
    if (!object(r) || r.schema !== 1 || !Array.isArray(r.history) || !r.history.length ||
      r.history.length > 500 || r.activeRetentionId !== null && !UUID.test(String(r.activeRetentionId))) return fail();
    const history: RetentionHistory[] = r.history.map(item => {
      if (!object(item) || !UUID.test(String(item.id))) return fail();
      const previousStays = projectedStays(item.previousStays, config);
      if (!previousStays.length) return fail();
      return { id: String(item.id), retainedAt: timestamp(item.retainedAt),
        reason: text(item.reason) ?? '', expiresOn: item.expiresOn == null ? null : day(item.expiresOn),
        previousStays, previousTotalCents: actor.viewPrices ? amount(item.previousTotalCents) : null,
        ...(actor.viewPrices && item.previousRoomNightPrices ?
          { previousRoomNightPrices: projectedPrices(item.previousRoomNightPrices, config) } : {}),
        ...(item.rescheduledAt ? { rescheduledAt: timestamp(item.rescheduledAt),
          rescheduledBookingVersion: integer(item.rescheduledBookingVersion, 1) } : {}) };
    });
    retention = { schema: 1, lifecycleRevision: integer(r.lifecycleRevision, 1),
      activeRetentionId: r.activeRetentionId as string | null, history };
    if (status === 'retained' && (retention.activeRetentionId !== history.at(-1)!.id ||
      history.at(-1)!.rescheduledAt)) return fail();
  }
  if (status === 'retained' && !retention) return fail();
  const latest = retention?.history.at(-1);
  const source = object(raw.sourceCalendar) ? raw.sourceCalendar : null;
  const supportedSource = typeof source?.sourceOrderRef === 'string' &&
    OFFLAND_IMPORT_REF.test(source.sourceOrderRef);
  const aliases = actor.viewPrices ? source?.retainedSourceAliases : undefined;
  if (aliases !== undefined && (!supportedSource || !Array.isArray(aliases) || aliases.length > 4097 ||
    aliases.some(alias => typeof alias !== 'string' || !OFFLAND_IMPORT_REF.test(alias)) ||
    new Set(aliases).size !== aliases.length || !aliases.includes(source!.sourceOrderRef))) return fail();
  const review = !actor.viewPrices || raw.retainedAmountReviewRequired !== false;
  return { bookingId: String(raw.id), version: integer(raw.version, 1), status,
    guestName: text(raw.guestName, 200) ?? '未填旅客姓名',
    contact: actor.viewPrices ? text(raw.contact, 256) : null,
    externalOrderNo: actor.viewPrices ? text(source?.externalOrderNo) : null,
    sourceOrderRef: actor.viewPrices ? text(source?.sourceOrderRef) : null,
    ...(aliases === undefined ? {} : { sourceOrderAliases: aliases as string[] }),
    totalCents: actor.viewPrices ? amount(raw.totalCents) : null,
    originalTotalCents: latest?.previousTotalCents ?? (actor.viewPrices ? amount(raw.totalCents) : null),
    stays, originalStays: latest?.previousStays ?? stays,
    ...(actor.viewPrices ? { roomNightPrices: projectedPrices(raw.roomNightPrices, config) } : {}),
    retention, retainedAt: latest?.retainedAt ?? null, reason: latest?.reason ?? null,
    netReceivedCents: review ? null : amount(raw.retainedAmountCents), retainedAmountReviewRequired: review,
    channelSyncState: text(raw.channelSyncState, 80) ?? 'review_required',
    externalRoomStatus: text(raw.externalRoomStatus, 80) ?? 'review_required',
    externalRoomActionRequired: raw.externalRoomActionRequired !== false,
    sourceReviewRequired: raw.sourceReviewRequired === true,
    retentionEligible: supportedSource && canWriteRetained(actor) && raw.retentionEligible === true,
    rescheduleEligible: supportedSource && canWriteRetained(actor) && raw.rescheduleEligible === true,
    priceHidden: !actor.viewPrices };
}

export async function readRetainedBooking(actor: Principal, config: ManualConfig,
  id: string, send: typeof fetch = fetch): Promise<RetainedBookingDetail> {
  const raw = await call(config, actor, path(config, id), null, null, send);
  if (raw.id !== id) return fail();
  return retainedBookingDetail(raw, config, actor);
}

async function lifecycleBookings(actor: Principal, config: ManualConfig,
  status: 'retained' | null, send: typeof fetch) {
  scope(config, actor);
  const prefix = `${path(config)}?limit=100${status ? '&status=retained' : ''}`;
  const scan = async () => {
    const bookings: RetainedBookingDetail[] = [], ids = new Set<string>(), cursors = new Set<string>();
    let cursor: string | null = null, inventoryVersion: number | null = null;
    for (let page = 0; page < 100; page++) {
      const raw = await call(config, actor, prefix + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
        null, null, send);
      if (raw.propertyId !== config.grant.propertyId || raw.readOnly !== false || raw.snapshot !== null ||
        raw.authorityEpoch !== config.calendar.expectedAuthorityEpoch ||
        !Array.isArray(raw.bookings) || raw.bookings.length > 100) return fail();
      const current = integer(raw.inventoryVersion);
      if (inventoryVersion !== null && current !== inventoryVersion) return fail('MANUAL_VERSION_CONFLICT');
      inventoryVersion = current;
      for (const item of raw.bookings) {
        if (!object(item) || !UUID.test(String(item.id)) || item.propertyId !== config.grant.propertyId ||
          item.workspaceId !== config.grant.workspaceId || ids.has(String(item.id))) return fail();
        ids.add(String(item.id));
        if (status === null && !item.retention) continue;
        const row = retainedBookingDetail(item, config, actor);
        if (status === 'retained' && row.status !== 'retained') return fail();
        bookings.push(row);
      }
      if (raw.nextCursor === null) return { bookings, inventoryVersion };
      if (typeof raw.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(raw.nextCursor) ||
        !raw.bookings.length || cursors.has(raw.nextCursor)) return fail();
      cursor = raw.nextCursor; cursors.add(cursor);
    }
    return fail();
  };
  const first = await scan(), second = await scan();
  if (JSON.stringify(first) !== JSON.stringify(second)) return fail('MANUAL_VERSION_CONFLICT');
  return { ...second, revision: createHash('sha256').update(JSON.stringify(second)).digest('hex') };
}

/** All owner-managed lifecycles, including re-arranged stays, for legacy report overlays. */
export async function readOfflandLifecycleBookings(actor: Principal, config: ManualConfig,
  send: typeof fetch = fetch) {
  return lifecycleBookings(actor, config, null, send);
}

export async function listRetainedBookings(actor: Principal, config: ManualConfig,
  send: typeof fetch = fetch): Promise<RetainedBookingsResponse> {
  const { bookings, inventoryVersion } = await lifecycleBookings(actor, config, 'retained', send);
  return { bookings, inventoryVersion, canWrite: canWriteRetained(actor), priceHidden: !actor.viewPrices,
    verifiedAt: new Date().toISOString() };
}

function inputPayload(value: unknown, mode: 'retain' | 'reschedule', commit: boolean,
  config: ManualConfig): Record<string, unknown> {
  const invalid = () => fail('MANUAL_INVALID_INPUT');
  if (!object(value)) return invalid();
  const allowed = ['reason', ...(mode === 'reschedule' ? ['stays', 'totalCents', 'roomNightPrices'] : []),
    ...(commit ? ['expectedBookingVersion', 'expectedInventoryVersion'] : [])];
  if (Object.keys(value).some(key => !allowed.includes(key)) || typeof value.reason !== 'string' ||
    !value.reason.trim() || value.reason.length > 500 || /[\u0000-\u001f\u007f]/.test(value.reason)) return invalid();
  const payload: Record<string, unknown> = { reason: value.reason.trim() };
  if (commit) {
    if (!Number.isSafeInteger(value.expectedBookingVersion) || Number(value.expectedBookingVersion) < 1 ||
      !Number.isSafeInteger(value.expectedInventoryVersion) || Number(value.expectedInventoryVersion) < 0) return invalid();
    payload.expectedBookingVersion = value.expectedBookingVersion;
    payload.expectedInventoryVersion = value.expectedInventoryVersion;
  }
  if (mode === 'reschedule') {
    if (!Array.isArray(value.stays) || !value.stays.length || value.stays.length > 32 ||
      !Number.isSafeInteger(value.totalCents) || Number(value.totalCents) < 0) return invalid();
    const mapped = value.stays.map(stay => {
      if (!object(stay) || Object.keys(stay).some(k => !['checkIn', 'checkOut', 'roomNumbers'].includes(k)) ||
        !Array.isArray(stay.roomNumbers) || !stay.roomNumbers.length ||
        stay.roomNumbers.some(room => typeof room !== 'string' || !config.calendar.roomIds[room])) return invalid();
      return { checkIn: stay.checkIn, checkOut: stay.checkOut,
        roomIds: stay.roomNumbers.map(room => config.calendar.roomIds[String(room)]) };
    });
    try { projectedStays(mapped, config); } catch { return invalid(); }
    payload.stays = mapped; payload.totalCents = value.totalCents;
    if (value.roomNightPrices !== undefined) {
      if (!Array.isArray(value.roomNightPrices) || value.roomNightPrices.length > 4096) return invalid();
      const cells = new Set<string>();
      for (const stay of mapped) for (const roomId of stay.roomIds)
        for (let d = Date.parse(String(stay.checkIn)); d < Date.parse(String(stay.checkOut)); d += 86_400_000)
          cells.add(`${roomId}:${new Date(d).toISOString().slice(0, 10)}`);
      let total = BigInt(0);
      payload.roomNightPrices = value.roomNightPrices.map(price => {
        if (!object(price) || Object.keys(price).some(k => !['roomNumber', 'date', 'amountCents'].includes(k)) ||
          typeof price.roomNumber !== 'string' || !config.calendar.roomIds[price.roomNumber] ||
          !Number.isSafeInteger(price.amountCents) || Number(price.amountCents) < 0 ||
          !cells.delete(`${config.calendar.roomIds[price.roomNumber]}:${price.date}`)) return invalid();
        total += BigInt(Number(price.amountCents));
        return { roomId: config.calendar.roomIds[price.roomNumber], date: price.date, amountCents: price.amountCents };
      });
      if (cells.size || total !== BigInt(Number(value.totalCents))) return invalid();
    }
  }
  return payload;
}

export async function previewRetainedBooking(actor: Principal, config: ManualConfig, id: string,
  mode: 'retain' | 'reschedule', input: unknown, send: typeof fetch = fetch): Promise<RetainedBookingPreview> {
  scope(config, actor, true);
  const payload = inputPayload(input, mode, false, config);
  await requireSupportedImport(actor, config, id, send);
  const raw = await call(config, actor, `${path(config, id)}/${mode}-preview`, payload, null, send);
  if (raw.bookingId !== id || raw.authorityEpoch !== config.calendar.expectedAuthorityEpoch ||
    raw.status !== (mode === 'retain' ? 'confirmed' : 'retained')) return fail();
  const review = raw.retainedAmountReviewRequired !== false;
  const available = review ? null : amount(raw.retainedAmountCents);
  const total = mode === 'reschedule' ? Number(payload.totalCents) : null;
  return { bookingId: id, bookingVersion: integer(raw.bookingVersion, 1),
    inventoryVersion: integer(raw.inventoryVersion), authorityEpoch: integer(raw.authorityEpoch, 1),
    status: String(raw.status), previousStays: projectedStays(raw.previousStays, config),
    proposedStays: projectedStays(raw.proposedStays, config),
    channelSyncState: text(raw.channelSyncState, 80) ?? 'review_required',
    externalRoomStatus: text(raw.externalRoomStatus, 80) ?? 'review_required',
    externalRoomActionRequired: raw.externalRoomActionRequired !== false,
    netReceivedCents: available, retainedAmountReviewRequired: review,
    remainingCents: available === null || total === null ? null : Math.max(0, total - available),
    creditCents: available === null || total === null ? null : Math.max(0, available - total) };
}

/** This OS rollout covers the exact Q/J imports that its legacy money reader can join. */
async function requireSupportedImport(actor: Principal, config: ManualConfig, id: string, send: typeof fetch) {
  const booking = await readRetainedBooking(actor, config, id, send);
  if (!booking.sourceOrderRef || !OFFLAND_IMPORT_REF.test(booking.sourceOrderRef))
    fail('RETENTION_SOURCE_REQUIRES_REVIEW');
}

function sameStays(a: unknown, b: unknown): boolean {
  const normalize = (value: unknown) => Array.isArray(value) ? value.map(item => object(item) ?
    JSON.stringify([item.checkIn, item.checkOut, Array.isArray(item.roomIds) ? [...item.roomIds].sort() : null]) : '')
    .sort() : null;
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
async function verifiedResult(actor: Principal, config: ManualConfig, receipt: Record<string, unknown>,
  key: string, send: typeof fetch, expectedId?: string, expectedPayload?: Record<string, unknown>)
  : Promise<RetainedBookingRequestResult> {
  const notApplied = receipt.outcome === 'not_applied' && receipt.operationState === 'not_applied';
  if (!UUID.test(String(receipt.bookingId)) || expectedId && receipt.bookingId !== expectedId ||
    !['retained', 'confirmed', ...(notApplied ? ['cancelled'] : [])].includes(String(receipt.status))) return fail();
  const bookingId = String(receipt.bookingId), version = integer(receipt.bookingVersion, 1);
  const raw = await call(config, actor, path(config, bookingId), null, null, send);
  const observed = retainedBookingDetail(raw, config, actor);
  if (observed.version < version || !notApplied && !observed.retention) return fail();
  const history = object(raw.retention) && Array.isArray(raw.retention.history) ? raw.retention.history : [];
  const applied = history.some(item => object(item) &&
    (receipt.status === 'retained' ? item.id === key : item.rescheduledRequestKey === key &&
      item.rescheduledBookingVersion === version));
  if (!notApplied && !applied) return fail();
  if (!notApplied && observed.version === version) {
    if (observed.status !== receipt.status || receipt.status === 'retained' && observed.stays.length) return fail();
    if (expectedPayload?.stays && (!sameStays(raw.stays, expectedPayload.stays) ||
      raw.totalCents !== expectedPayload.totalCents)) return fail();
    if (Array.isArray(expectedPayload?.roomNightPrices)) {
      const normalize = (value: unknown) => Array.isArray(value) ? value.map(item => object(item) ?
        JSON.stringify([item.roomId, item.date, item.amountCents]) : '').sort() : null;
      if (JSON.stringify(normalize(raw.roomNightPrices)) !== JSON.stringify(normalize(expectedPayload.roomNightPrices))) return fail();
    }
  }
  return { outcome: notApplied ? 'not_applied' : 'applied', requestKey: key, bookingId, bookingVersion: version,
    currentBookingVersion: observed.version, currentStatus: observed.status,
    channelSyncState: observed.channelSyncState, externalRoomStatus: observed.externalRoomStatus,
    inventoryVersion: integer(receipt.inventoryVersion),
    readbackVerified: true };
}

export async function commitRetainedBooking(actor: Principal, config: ManualConfig, id: string,
  mode: 'retain' | 'reschedule', input: unknown, key: string, send: typeof fetch = fetch)
  : Promise<RetainedBookingRequestResult> {
  scope(config, actor, true);
  if (!UUID.test(key)) return fail('MANUAL_INVALID_INPUT');
  const payload = inputPayload(input, mode, true, config);
  await requireSupportedImport(actor, config, id, send);
  const receipt = await call(config, actor, `${path(config, id)}/${mode}`, payload, key, send);
  if (receipt.outcome !== 'not_applied' && receipt.status !== (mode === 'retain' ? 'retained' : 'confirmed')) return fail();
  try { return await verifiedResult(actor, config, receipt, key, send, id, payload); }
  catch { return fail('MANUAL_RESULT_UNKNOWN'); }
}

export async function retainedRequestResult(actor: Principal, config: ManualConfig, key: string,
  send: typeof fetch = fetch): Promise<RetainedBookingRequestResult> {
  scope(config, actor, true);
  if (!UUID.test(key)) return fail('MANUAL_INVALID_INPUT');
  const receipt = await call(config, actor,
    `/v1/properties/${config.grant.propertyId}/requests/${key}`, null, null, send);
  return verifiedResult(actor, config, receipt, key, send);
}

/** Atomically tombstone an unaccepted request, or recover its existing applied result. */
export async function abandonRetainedRequest(actor: Principal, config: ManualConfig, id: string,
  value: unknown, key: string, send: typeof fetch = fetch): Promise<RetainedBookingRequestResult> {
  scope(config, actor, true);
  if (!UUID.test(key) || !object(value) || Object.keys(value).some(k => !['action', 'input'].includes(k)) ||
    !['retain', 'reschedule'].includes(String(value.action))) return fail('MANUAL_INVALID_INPUT');
  const action = value.action as 'retain' | 'reschedule';
  const input = inputPayload(value.input, action, true, config);
  const receipt = await call(config, actor, `${path(config, id)}/retained-request-abandon`,
    { requestKey: key, action, input }, key, send);
  try { return await verifiedResult(actor, config, receipt, key, send, id); }
  catch { return fail('MANUAL_RESULT_UNKNOWN'); }
}
