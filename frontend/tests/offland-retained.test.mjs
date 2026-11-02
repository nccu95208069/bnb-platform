import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { MemoryPropertyRepository } from '../../iron-gate/src/memory-repository.ts';
import { IronGateService } from '../../iron-gate/src/service.ts';
import { createHandler } from '../../iron-gate/src/http.ts';
import { createOsMemberProofVerifier } from '../../iron-gate/src/os-member-proof.mjs';
import { OFFLAND_HEADERS, auditOfflandSnapshot } from '../../iron-gate/src/offland-sheet-audit.mjs';
import { prepareOfflandShadow } from '../../iron-gate/src/offland-shadow.mjs';
import { offlandRetainedConfig, listRetainedBookings,
  readRetainedBooking, previewRetainedBooking, commitRetainedBooking,
  retainedRequestResult, abandonRetainedRequest } from '../src/lib/booking-sources/iron-gate-retained.server.ts';
import { ssotBookingOrder } from '../src/lib/booking-sources/iron-gate-ssot-bookings.server.ts';
import { retainedContext, retainedError } from '../src/lib/booking-sources/iron-gate-retained-route.server.ts';
import { createMemberSession, MEMBER_COOKIE } from '../src/lib/workspace-auth/session.ts';
import { GET as LIST } from '../src/app/api/v1/bookings/retained/route.ts';
import { POST as RETAIN } from '../src/app/api/v1/bookings/retained/[bookingId]/retain/route.ts';

const uuid = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const workspaceId = uuid(1), propertyId = uuid(2), roomId = uuid(3), bookingId = uuid(4);
const grant = { credentialId: uuid(5), clientId: uuid(6), workspaceId, propertyId, token: 'x'.repeat(43) };
const proofSecret = 'synthetic-offland-retention-proof-secret-32-bytes';
const owner = { id: 'synthetic-owner', role: 'owner', allProperties: false,
  propertyIds: ['offland'], viewPrices: true };
const env = { CALENDAR_SOURCE: 'sheet_snapshot', IRON_GATE_OFFLAND_RETAINED_ENABLED: 'true',
  IRON_GATE_OFFLAND_CALENDAR_ENABLED: 'true', IRON_GATE_OFFLAND_BASE_URL: 'https://offland-fixture.invalid',
  IRON_GATE_OFFLAND_CALENDAR_GRANT: JSON.stringify(grant),
  IRON_GATE_OFFLAND_RETAINED_GRANT: JSON.stringify(grant),
  IRON_GATE_OFFLAND_ROOM_IDS: JSON.stringify({ 包棟: roomId }),
  IRON_GATE_OFFLAND_OS_PROOF_SECRET: proofSecret, IRON_GATE_OFFLAND_AUTHORITY_EPOCH: '1' };
const config = () => offlandRetainedConfig(env);
const reason = '旅客改期，新日期未定';
const proposed = { reason: '確認新住宿', stays: [{ checkIn: '2027-01-04', checkOut: '2027-01-06',
  roomNumbers: ['包棟'] }], totalCents: 1200000,
  roomNightPrices: [{ roomNumber: '包棟', date: '2027-01-04', amountCents: 500000 },
    { roomNumber: '包棟', date: '2027-01-05', amountCents: 700000 }] };

function setup() {
  const row = (n, date, j, q) => ({ rowNumber: n,
    values: ['OFFLAND', 'Synthetic Guest', 'LINE', date,
      new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10),
      '2026-10-01', 'NT$6,000', '', 'OK', j, '', '2', '', '', '', '', q],
    entered: Array(17).fill(''), notes: Array(17).fill(null) });
  const snapshot = { headers: [...OFFLAND_HEADERS], rows: [
    row(2, '2026-10-31', 'synthetic-night-a', 'synthetic-parent'),
    row(3, '2026-11-01', 'synthetic-night-b', 'synthetic-parent'),
    row(4, '2027-02-01', 'synthetic-night-c', '')] };
  const { state } = prepareOfflandShadow(snapshot, { workspaceId, propertyId, roomId,
    inventoryVersion: 1, authorityEpoch: 0, expectedSourceHash: auditOfflandSnapshot(snapshot).sourceHash,
    sourceId: 'synthetic-sheet', sourceCopyId: 'synthetic-copy',
    capturedAt: '2026-10-28T00:00:00.000Z', sourceCopyCreatedAt: '2026-10-28T00:00:00.000Z',
    bookingIds: { 'Q:synthetic-parent': bookingId, 'J:synthetic-night-c': uuid(7) } });
  state.readOnly = false; state.authorityEpoch = 1;
  const repository = new MemoryPropertyRepository(); repository.seed(state);
  const service = new IronGateService(repository), verifier = createOsMemberProofVerifier(proofSecret);
  const handle = createHandler(service, async request => {
    const claims = await verifier(request, { ...grant, origin: 'os' });
    return claims && { clientId: grant.clientId, subjectId: claims.subjectId, origin: 'os',
      workspaceId, propertyIds: claims.propertyIds, authorityEpoch: 1,
      actions: claims.actions, fields: claims.fields };
  });
  const send = async (url, options) => handle(new Request(url, options));
  return { repository, service, send, state };
}
async function retain(fixture, key = crypto.randomUUID()) {
  const preview = await previewRetainedBooking(owner, config(), bookingId, 'retain', { reason }, fixture.send);
  const input = { reason, expectedBookingVersion: preview.bookingVersion,
    expectedInventoryVersion: preview.inventoryVersion };
  return { input, key, preview, result: await commitRetainedBooking(owner, config(), bookingId,
    'retain', input, key, fixture.send) };
}

test('Offland rollout refuses native bookings without the legacy Q/J ledger identity before mutation', async () => {
  const fixture = setup(), state = await fixture.repository.read(propertyId);
  const booking = state.bookings.find(item => item.id === bookingId);
  booking.source = 'os'; delete booking.offlandSnapshot; delete booking.sourceCalendar;
  state.sourceLinks = state.sourceLinks.filter(link => link.bookingId !== bookingId);
  await fixture.repository.transact(propertyId, current => { Object.assign(current, state); });
  let writes = 0;
  const send = async (url, options) => { if (options.method === 'POST') writes++; return fixture.send(url, options); };
  const detail = await readRetainedBooking(owner, config(), bookingId, send);
  assert.equal(detail.retentionEligible, false);
  await assert.rejects(() => previewRetainedBooking(owner, config(), bookingId, 'retain', { reason }, send),
    /RETENTION_SOURCE_REQUIRES_REVIEW/);
  await assert.rejects(() => commitRetainedBooking(owner, config(), bookingId, 'retain', {
    reason, expectedBookingVersion: booking.version, expectedInventoryVersion: state.version,
  }, crypto.randomUUID(), send), /RETENTION_SOURCE_REQUIRES_REVIEW/);
  assert.equal(writes, 0);
  assert.equal((await fixture.repository.read(propertyId)).bookings.find(item => item.id === bookingId).status, 'confirmed');
});

test('Offland HTTP workflow preserves one imported order, releases cross-month nights and reschedules atomically', async () => {
  const fixture = setup(), before = await fixture.repository.read(propertyId);
  const { result, key } = await retain(fixture);
  assert.equal(result.readbackVerified, true); assert.equal(result.currentStatus, 'retained');
  const list = await listRetainedBookings(owner, config(), fixture.send);
  assert.equal(list.bookings.length, 1); assert.equal(list.bookings[0].bookingId, bookingId);
  assert.equal(list.bookings[0].stays.length, 0);
  assert.deepEqual(list.bookings[0].originalStays.map(s => s.checkIn), ['2026-10-31', '2026-11-01']);
  assert.equal(list.bookings[0].totalCents, null);
  assert.equal(list.bookings[0].originalTotalCents, 1200000);
  assert.equal(list.bookings[0].netReceivedCents, null);
  assert.equal(list.bookings[0].retainedAmountReviewRequired, true);
  assert.equal(list.bookings[0].sourceOrderRef, 'Q:synthetic-parent');
  assert.deepEqual(list.bookings[0].sourceOrderAliases,
    ['J:synthetic-night-a', 'J:synthetic-night-b', 'Q:synthetic-parent']);
  assert.equal(list.bookings[0].reason, reason);
  assert.equal(list.bookings[0].rescheduleEligible, true);
  assert.equal(list.bookings[0].externalRoomStatus, 'not_integrated');
  const after = await fixture.repository.read(propertyId);
  assert.deepEqual(after.bookings.find(b => b.id === bookingId).paymentEvents,
    before.bookings.find(b => b.id === bookingId).paymentEvents);
  assert.equal(after.bookings.length, before.bookings.length);
  assert.equal(after.bookings.find(b => b.id === uuid(7)).version, 1);
  assert.deepEqual(after.bookings.find(b => b.id === bookingId).stays, []);

  const next = await previewRetainedBooking(owner, config(), bookingId, 'reschedule', proposed, fixture.send);
  assert.equal(next.remainingCents, null); assert.equal(next.creditCents, null);
  const applied = await commitRetainedBooking(owner, config(), bookingId, 'reschedule', {
    ...proposed, expectedBookingVersion: next.bookingVersion, expectedInventoryVersion: next.inventoryVersion,
  }, crypto.randomUUID(), fixture.send);
  assert.equal(applied.currentStatus, 'confirmed');
  const detail = await readRetainedBooking(owner, config(), bookingId, fixture.send);
  assert.deepEqual(detail.stays, proposed.stays); assert.equal(detail.totalCents, proposed.totalCents);
  assert.equal(detail.sourceOrderRef, 'Q:synthetic-parent');
  assert.equal(detail.retention.history.length, 1);
  assert.ok(detail.retention.history[0].rescheduledAt);
  assert.equal((await listRetainedBookings(owner, config(), fixture.send)).bookings.length, 0);
  // An old receipt stays recoverable after a subsequent valid lifecycle operation.
  assert.equal((await retainedRequestResult(owner, config(), key, fixture.send)).currentStatus, 'confirmed');
  const final = await fixture.repository.read(propertyId);
  assert.deepEqual(final.bookings.find(b => b.id === bookingId).paymentEvents,
    before.bookings.find(b => b.id === bookingId).paymentEvents);
});

test('lost commit response is recovered by the same operation key without a second conversion', async () => {
  const fixture = setup(), key = crypto.randomUUID();
  const preview = await previewRetainedBooking(owner, config(), bookingId, 'retain', { reason }, fixture.send);
  const input = { reason, expectedBookingVersion: preview.bookingVersion, expectedInventoryVersion: preview.inventoryVersion };
  const dropped = async (url, options) => {
    const result = await fixture.send(url, options);
    if (options.method === 'POST' && String(url).endsWith('/retain')) throw Error('connection lost');
    return result;
  };
  await assert.rejects(() => commitRetainedBooking(owner, config(), bookingId, 'retain', input, key, dropped),
    /MANUAL_RESULT_UNKNOWN/);
  const recovered = await retainedRequestResult(owner, config(), key, fixture.send);
  assert.equal(recovered.readbackVerified, true);
  assert.equal(recovered.currentStatus, 'retained');
  const retry = await commitRetainedBooking(owner, config(), bookingId, 'retain', input, key, fixture.send);
  assert.equal(retry.bookingVersion, recovered.bookingVersion);
  const state = await fixture.repository.read(propertyId);
  assert.equal(state.bookings.find(b => b.id === bookingId).retention.history.length, 1);
});

test('abandoning an unaccepted request prevents a delayed POST, while an accepted request recovers normally', async () => {
  const fixture = setup(), key = crypto.randomUUID();
  const preview = await previewRetainedBooking(owner, config(), bookingId, 'retain', { reason }, fixture.send);
  const input = { reason, expectedBookingVersion: preview.bookingVersion, expectedInventoryVersion: preview.inventoryVersion };
  const cancelled = await abandonRetainedRequest(owner, config(), bookingId, { action: 'retain', input }, key, fixture.send);
  assert.equal(cancelled.outcome, 'not_applied'); assert.equal(cancelled.readbackVerified, true);
  assert.equal(cancelled.currentStatus, 'confirmed');
  const late = await commitRetainedBooking(owner, config(), bookingId, 'retain', input, key, fixture.send);
  assert.equal(late.outcome, 'not_applied');
  assert.equal((await retainedRequestResult(owner, config(), key, fixture.send)).outcome, 'not_applied');
  assert.equal((await readRetainedBooking(owner, config(), bookingId, fixture.send)).version, 1);
  const accepted = await retain(fixture);
  const recovered = await abandonRetainedRequest(owner, config(), bookingId,
    { action: 'retain', input: accepted.input }, accepted.key, fixture.send);
  assert.equal(recovered.outcome, 'applied'); assert.equal(recovered.currentStatus, 'retained');
  await assert.rejects(() => abandonRetainedRequest(owner, config(), bookingId,
    { action: 'retain', input: { ...input, reason: 'different' } }, key, fixture.send), /IDEMPOTENCY_CONFLICT/);
});

test('conflicts, stale previews and invalid nightly amounts cannot partially reschedule a retained order', async () => {
  const fixture = setup(); await retain(fixture);
  await assert.rejects(() => previewRetainedBooking(owner, config(), bookingId, 'reschedule', {
    ...proposed, roomNightPrices: undefined,
    stays: [{ checkIn: '2027-02-01', checkOut: '2027-02-02', roomNumbers: ['包棟'] }],
  }, fixture.send), /CONFLICT|UNAVAILABLE/);
  const preview = await previewRetainedBooking(owner, config(), bookingId, 'reschedule', proposed, fixture.send);
  await assert.rejects(() => commitRetainedBooking(owner, config(), bookingId, 'reschedule', {
    ...proposed, expectedBookingVersion: 1, expectedInventoryVersion: preview.inventoryVersion,
  }, crypto.randomUUID(), fixture.send), /VERSION/);
  const forbidden = async () => { throw Error('invalid input must not reach Iron Gate'); };
  await assert.rejects(() => previewRetainedBooking(owner, config(), bookingId, 'reschedule', {
    ...proposed, roomNightPrices: proposed.roomNightPrices.slice(0, 1),
  }, forbidden), /MANUAL_INVALID_INPUT/);
  await assert.rejects(() => previewRetainedBooking(owner, config(), bookingId, 'reschedule', {
    ...proposed, stays: [{ ...proposed.stays[0], roomNumbers: ['101'] }],
  }, forbidden), /MANUAL_INVALID_INPUT/);
  assert.equal((await readRetainedBooking(owner, config(), bookingId, fixture.send)).status, 'retained');
});

test('read-only and no-price members see a scoped redacted list and cannot mutate or recover writes', async () => {
  const fixture = setup(); await retain(fixture);
  const viewer = { ...owner, role: 'viewer_no_price', viewPrices: false };
  const list = await listRetainedBookings(viewer, config(), fixture.send);
  assert.equal(list.canWrite, false); assert.equal(list.priceHidden, true);
  const detail = list.bookings[0];
  assert.equal(detail.netReceivedCents, null); assert.equal(detail.originalTotalCents, null);
  assert.equal(detail.retention.history[0].previousTotalCents, null);
  assert.equal(detail.contact, null); assert.equal(detail.sourceOrderRef, null);
  assert.equal(detail.retentionEligible, false); assert.equal(detail.rescheduleEligible, false);
  await assert.rejects(() => previewRetainedBooking(viewer, config(), bookingId, 'reschedule', proposed, fixture.send),
    /MANUAL_FORBIDDEN/);
  await assert.rejects(() => retainedRequestResult(viewer, config(), crypto.randomUUID(), fixture.send), /MANUAL_FORBIDDEN/);
  await assert.rejects(() => listRetainedBookings({ ...owner, propertyIds: ['sweetfun'] }, config(), fixture.send),
    /MANUAL_FORBIDDEN/);
});

test('SSOT finance reader retains identity and historical amount without active dates or invented deposit', async () => {
  const fixture = setup(); await retain(fixture);
  const signed = async (url, options) => {
    const result = await fixture.send(url, options);
    const raw = await result.clone().json();
    const order = ssotBookingOrder(raw, config());
    assert.equal(order.id, `IG-${bookingId}`); assert.equal(order.status, 'retained');
    assert.equal(order.check_in, ''); assert.equal(order.check_out, '');
    assert.deepEqual(order.rooms, []); assert.equal(order.total, 1200000);
    assert.equal(order.retained_credit_cents, null); assert.equal(order.retained_credit_review_required, true);
    assert.equal(order.ssot_command_eligible, false); assert.equal(order.receivable, 0);
    return result;
  };
  await readRetainedBooking(owner, config(), bookingId, signed);
});

test('configuration requires a separate same-property grant and a live authority', () => {
  for (const override of [{ IRON_GATE_OFFLAND_RETAINED_ENABLED: 'false' },
    { IRON_GATE_OFFLAND_RETAINED_GRANT: '' },
    { IRON_GATE_OFFLAND_RETAINED_GRANT: JSON.stringify({ ...grant, propertyId: uuid(90) }) },
    { IRON_GATE_OFFLAND_CALENDAR_ENABLED: 'false', IRON_GATE_OFFLAND_CALENDAR_PREVIEW_ENABLED: 'true' }])
    assert.throws(() => offlandRetainedConfig({ ...env, ...override }), /MANUAL_CONFIG_UNAVAILABLE/);
});

test('list fails closed on same-version record drift and validates the upstream property', async () => {
  const fixture = setup(); await retain(fixture);
  let count = 0;
  const drift = async (url, options) => {
    const response = await fixture.send(url, options), raw = await response.json();
    if (++count === 2) raw.bookings[0].version++;
    return Response.json(raw);
  };
  await assert.rejects(() => listRetainedBookings(owner, config(), drift), /MANUAL_VERSION_CONFLICT/);
  const bad = async (url, options) => {
    const response = await fixture.send(url, options), raw = await response.json();
    raw.bookings[0].propertyId = uuid(90); return Response.json(raw);
  };
  await assert.rejects(() => listRetainedBookings(owner, config(), bad), /MANUAL_READBACK_MISMATCH/);
  const error = retainedError(Error('MANUAL_READBACK_MISMATCH'));
  assert.equal(error.status, 503); assert.equal((await error.json()).code, 'MANUAL_READ_UNAVAILABLE');
});

test('retained routes enforce session, property, CSRF, role and price access before forwarding', async t => {
  const previous = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous); });
  Object.assign(process.env, env, { CALENDAR_OWNER_CODE_HASH: 'a'.repeat(64),
    CALENDAR_OWNER_SESSION_SECRET: 'b'.repeat(64), KV_REST_API_URL: 'https://members-fixture.invalid',
    KV_REST_API_TOKEN: 'synthetic' });
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const fixture = setup(); await retain(fixture);
  const base = { displayName: 'Synthetic member', status: 'active', allProperties: false,
    credential: { schema: 1, kind: 'password', revision: 'd'.repeat(64), salt: 'e'.repeat(32), hash: 'f'.repeat(128) } };
  const admin = { ...base, id: 'c'.repeat(32), role: 'admin', propertyIds: ['offland'] };
  const noPrice = { ...admin, id: 'd'.repeat(32), role: 'viewer_no_price' };
  const otherProperty = { ...admin, id: 'e'.repeat(32), propertyIds: ['sweetfun'] };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url) === 'https://members-fixture.invalid') {
      const command = JSON.parse(options.body);
      return Response.json({ result: command[1]?.endsWith(':members') ?
        JSON.stringify({ version: 1, members: [admin, noPrice, otherProperty] }) : null });
    }
    calls++; return fixture.send(url, options);
  });
  const request = (member, method = 'GET', url = '/api/v1/bookings/retained', origin = 'https://os-fixture.invalid') =>
    new NextRequest(`https://os-fixture.invalid${url}`, { method, headers: {
      ...(member ? { cookie: `${MEMBER_COOKIE}=${createMemberSession(member)}` } : {}),
      ...(method === 'POST' ? { origin, 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify({ reason, expectedBookingVersion: 1, expectedInventoryVersion: 1 }) } : {}) });
  assert.equal((await LIST(request(null))).status, 401);
  assert.equal((await LIST(request(otherProperty))).status, 403);
  const params = { params: Promise.resolve({ bookingId }) };
  assert.equal((await RETAIN(request(admin, 'POST', undefined, 'https://attacker.invalid'), params)).status, 400);
  assert.equal((await RETAIN(request(noPrice, 'POST'), params)).status, 403);
  await assert.rejects(() => retainedContext(request(admin, 'GET', '/api/v1/bookings/retained?property=sweetfun')),
    /MANUAL_FORBIDDEN/);
  assert.equal(calls, 0);
  const response = await LIST(request(noPrice));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal((await response.json()).bookings[0].originalTotalCents, null);
});
