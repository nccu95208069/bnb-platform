import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOsMemberProofVerifier } from '../../iron-gate/src/os-member-proof.mjs';
import { SWEETFUN_HEADERS } from '../../iron-gate/src/sweetfun-sheet-audit.mjs';
import { prepareSweetfunGroups } from '../../iron-gate/src/sweetfun-sheet-candidate.mjs';
import { prepareSweetfunShadow } from '../../iron-gate/src/sweetfun-shadow.mjs';
import { IronGateService } from '../../iron-gate/src/service.ts';
import { MemoryPropertyRepository } from '../../iron-gate/src/memory-repository.ts';
import { ironGateCalendarConfig, readSweetfunIronGateCalendar } from
  '../src/lib/booking-sources/iron-gate-calendar.server.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const propertyId = '22222222-2222-4222-8222-222222222222';
const credentialId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const roomIds = Object.fromEntries(['101', '102', '201', '202', '301', '302']
  .map((room, i) => [room, `55555555-5555-4555-8555-55555555555${i}`]));
const secret = 'private-test-proof-secret-32-bytes-long';
const snapshotHash = 'f'.repeat(64);
const snapshotCapturedAt = '2026-10-21T09:52:08.770Z';
const grant = { credentialId, clientId, workspaceId, propertyId,
  token: 'a'.repeat(43) };
const principal = { id: 'current-os-member', role: 'owner', allProperties: true,
  propertyIds: ['sweetfun'], viewPrices: true };

function config(preview = false) {
  return ironGateCalendarConfig({
    [preview ? 'IRON_GATE_SWEETFUN_CALENDAR_PREVIEW_ENABLED' :
      'IRON_GATE_SWEETFUN_CALENDAR_ENABLED']: 'true',
    IRON_GATE_SWEETFUN_CALENDAR_GRANT: JSON.stringify(grant),
    IRON_GATE_SWEETFUN_ROOM_IDS: JSON.stringify(roomIds),
    IRON_GATE_SWEETFUN_OS_PROOF_SECRET: secret,
    IRON_GATE_SWEETFUN_BASE_URL: 'https://iron-gate.example/',
    IRON_GATE_SWEETFUN_AUTHORITY_EPOCH: preview ? undefined : '1',
    IRON_GATE_SWEETFUN_SNAPSHOT_VERSION: preview ? '7' : undefined,
    IRON_GATE_SWEETFUN_SNAPSHOT_HASH: preview ? snapshotHash : undefined,
  });
}

function fixture({ version = 7, sold = true, blocked = true, preview = false } = {}) {
  const booking = { id: '66666666-6666-4666-8666-666666666666',
    workspaceId, propertyId, version: 1, status: 'confirmed',
    channelSyncState: 'not_required',
    stays: [{ checkIn: '2026-10-25', checkOut: '2026-10-26', roomIds: [roomIds['101']] }],
    guestName: 'Sample Guest' };
  const page = { propertyId, inventoryVersion: version, authorityEpoch: preview ? 0 : 1,
    readOnly: preview, snapshot: preview ?
      { capturedAt: snapshotCapturedAt, sourceHash: snapshotHash } : null,
    bookings: [booking], nextCursor: null };
  const cells = Object.entries(roomIds).map(([room, roomId]) => ({ roomId,
    date: '2026-10-25', state: room === '101' && sold ? 'sold' :
      room === '102' && blocked ? 'blocked' : 'unsold', saleReady: false }));
  const availability = { propertyId, inventoryVersion: version,
    authorityEpoch: preview ? 0 : 1, cells };
  return { page, availability };
}

function sender(data, configValue, mutate = () => {}) {
  const verify = createOsMemberProofVerifier(configValue.proofSecret);
  let calls = 0;
  return async (url, init) => {
    const request = new Request(url, init);
    const proof = await verify(request, { ...configValue.grant, origin: 'os' });
    assert.equal(proof?.subjectId, principal.id);
    assert.deepEqual(proof?.actions, ['booking:read']);
    assert.deepEqual(proof?.fields, ['guest_name']);
    assert.equal(request.headers.get('authorization'), `Bearer ${grant.token}`);
    calls++;
    const value = url.includes('/availability?') ?
      structuredClone(data.availability) : structuredClone(data.page);
    mutate(value, calls);
    return Response.json(value);
  };
}

test('Iron Gate calendar needs explicit authority epoch and separate closed switch', () => {
  assert.throws(() => ironGateCalendarConfig({}), /IRON_GATE_CALENDAR_CONFIG_INVALID/);
  assert.throws(() => ironGateCalendarConfig({
    IRON_GATE_SWEETFUN_CALENDAR_ENABLED: 'true',
    IRON_GATE_SWEETFUN_CALENDAR_GRANT: JSON.stringify(grant),
    IRON_GATE_SWEETFUN_ROOM_IDS: JSON.stringify(roomIds),
    IRON_GATE_SWEETFUN_OS_PROOF_SECRET: secret,
    IRON_GATE_SWEETFUN_BASE_URL: 'https://iron-gate.example/',
    IRON_GATE_SWEETFUN_AUTHORITY_EPOCH: '0',
  }), /IRON_GATE_CALENDAR_CONFIG_INVALID/);
});

test('calendar reads signed booking plus inventory, preserving blocked room nights', async () => {
  const c = config();
  const data = fixture();
  const result = await readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(data, c));
  assert.equal(result.inventoryVersion, 7);
  assert.equal(result.authorityEpoch, 1);
  assert.equal(result.blockedRoomNights, 1);
  assert.equal(result.soldRoomNights, 1);
  assert.equal(result.bookings.length, 2);
  assert.equal(result.bookings[0].room_number, '101');
  assert.equal(result.bookings[0].guest_name, 'Sample Guest');
  assert.equal(result.bookings[0].price_hidden, true);
  assert.equal(result.bookings[0].payment_status, 'unknown');
  assert.equal(result.bookings[0].channel_sync_state, 'not_required');
  assert.equal(result.bookings[1].room_number, '102');
  assert.equal(result.bookings[1].source_conflict, true);
});

test('calendar preserves occupancy when an older booking omits channel metadata', async () => {
  const c = config();
  const data = fixture();
  delete data.page.bookings[0].channelSyncState;
  const result = await readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(data, c));
  assert.equal(result.soldRoomNights, 1);
  assert.equal(result.bookings[0].channel_sync_state, undefined);
  data.page.bookings[0].channelSyncState = 'unrecognized';
  const unknown = await readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(data, c));
  assert.equal(unknown.soldRoomNights, 1);
  assert.equal(unknown.bookings[0].channel_sync_state, undefined);
});

test('calendar rejects inventory that omits a confirmed sold night', async () => {
  const c = config();
  await assert.rejects(readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(fixture({ sold: false }), c)),
  /IRON_GATE_CALENDAR_INVENTORY_DRIFT/);
});

test('a room that checked out at the range start is not shown or counted', async () => {
  const c = config();
  const data = fixture({ sold: false, blocked: false });
  data.page.bookings[0].stays[0] = { checkIn: '2026-10-24',
    checkOut: '2026-10-25', roomIds: [roomIds['101']] };
  const result = await readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(data, c));
  assert.equal(result.bookings.length, 0);
  assert.equal(result.soldRoomNights, 0);
});

test('calendar rejects a version change before the final readback', async () => {
  const c = config();
  await assert.rejects(readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(fixture(), c, (value, calls) => {
      if (calls === 3) value.inventoryVersion++;
    })), /IRON_GATE_CALENDAR_VERSION_DRIFT/);
});

test('calendar refuses a still read-only shadow even when it has bookings', async () => {
  const c = config();
  const data = fixture();
  data.page.readOnly = true;
  await assert.rejects(readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(data, c)), /IRON_GATE_CALENDAR_VERSION_DRIFT/);
});

test('fixed snapshot preview reads a pinned shadow and marks every segment non-operational', async () => {
  const c = config(true);
  const result = await readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(fixture({ preview: true }), c));
  assert.equal(result.mode, 'snapshot_preview');
  assert.equal(result.authorityEpoch, 0);
  assert.equal(result.snapshotCapturedAt, snapshotCapturedAt);
  assert.equal(result.soldRoomNights, 1);
  assert.ok(result.bookings.every(booking => booking.snapshot_only));
});

test('protected Preview forwards a short-lived Vercel identity only to Iron Gate', async () => {
  const c = config(true);
  c.baseUrl = 'https://iron-gate-q15584007-sweetfuns-projects.vercel.app';
  c.trustedSourceToken = 'synthetic-oidc-token';
  const send = sender(fixture({ preview: true }), c);
  const result = await readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, async (url, init) => {
      assert.equal(init.headers['x-vercel-trusted-oidc-idp-token'], 'synthetic-oidc-token');
      return send(url, init);
    });
  assert.equal(result.soldRoomNights, 1);
  c.baseUrl = 'https://other.example';
  await assert.rejects(readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, async () => { throw Error('must not send identity token'); }),
  /IRON_GATE_CALENDAR_UNAVAILABLE/);
});

test('preview refuses a changed version or source hash before showing bookings', async () => {
  const c = config(true);
  for (const changed of [fixture({ preview: true, version: 8 }),
    fixture({ preview: true })]) {
    if (changed.page.inventoryVersion === 7) changed.page.snapshot.sourceHash = 'e'.repeat(64);
    await assert.rejects(readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
      principal, c, sender(changed, c)), /IRON_GATE_CALENDAR_VERSION_DRIFT/);
  }
});

test('a converted two-room Sheet order reaches the OS snapshot calendar through real Iron Gate reads', async () => {
  const sourceRows = ['101', '201'].map((room, index) => {
    const values = Array(19).fill('');
    Object.assign(values, { 0: room, 1: 'Synthetic guest', 2: 'Booking',
      3: '2026/10/25', 4: '2026/10/26', 5: '2026/10/01',
      6: '1000', 8: 'OK', 9: `synthetic-j-${index}`,
      11: 'synthetic-parent', 13: 'synthetic-ota-order' });
    return { rowNumber: index + 2, values, notes: Array(19).fill(null) };
  });
  const snapshot = { headers: [...SWEETFUN_HEADERS], rows: sourceRows };
  const groups = prepareSweetfunGroups(snapshot);
  assert.deepEqual(groups.candidates.map(group => ({ key: group.key, issues: group.issues })),
    [{ key: 'L:synthetic-parent', issues: [] }]);
  const sourceHash = groups.sourceHash;
  const { state } = prepareSweetfunShadow(snapshot, {
    workspaceId, propertyId, roomIds, sourceId: 'synthetic-sheet',
    capturedAt: snapshotCapturedAt, expectedSourceHash: sourceHash,
    inventoryVersion: 7, authorityEpoch: 0,
    bookingIds: { 'L:synthetic-parent': '77777777-7777-4777-8777-777777777777' },
  });
  const repository = new MemoryPropertyRepository();
  repository.seed(state);
  const service = new IronGateService(repository);
  const actor = { clientId, subjectId: principal.id, origin: 'os', workspaceId,
    propertyIds: [propertyId], authorityEpoch: 0,
    actions: ['booking:read'], fields: ['guest_name'] };
  const c = ironGateCalendarConfig({
    IRON_GATE_SWEETFUN_CALENDAR_PREVIEW_ENABLED: 'true',
    IRON_GATE_SWEETFUN_CALENDAR_GRANT: JSON.stringify(grant),
    IRON_GATE_SWEETFUN_ROOM_IDS: JSON.stringify(roomIds),
    IRON_GATE_SWEETFUN_OS_PROOF_SECRET: secret,
    IRON_GATE_SWEETFUN_BASE_URL: 'https://iron-gate.example/',
    IRON_GATE_SWEETFUN_SNAPSHOT_VERSION: '7',
    IRON_GATE_SWEETFUN_SNAPSHOT_HASH: sourceHash,
  });
  const verify = createOsMemberProofVerifier(secret);
  const send = async (url, init) => {
    const request = new Request(url, init);
    const claim = await verify(request, { ...grant, origin: 'os' });
    assert.equal(claim?.subjectId, principal.id);
    const parsed = new URL(url);
    const value = parsed.pathname.endsWith('/bookings') ?
      await service.listBookings(actor, propertyId, {
        limit: Number(parsed.searchParams.get('limit')),
        cursor: parsed.searchParams.get('cursor'), status: null,
        from: parsed.searchParams.get('from'), to: parsed.searchParams.get('to'),
      }) : await service.availability(actor, propertyId,
        parsed.searchParams.get('from'), parsed.searchParams.get('to'));
    return Response.json(value);
  };
  const result = await readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, send);
  assert.deepEqual(result.bookings.map(booking => booking.room_number).sort(), ['101', '201']);
  assert.equal(new Set(result.bookings.map(booking => booking.order_id)).size, 1);
  assert.equal(result.soldRoomNights, 2);
  assert.equal(result.snapshotCapturedAt, snapshotCapturedAt);
  assert.ok(result.bookings.every(booking => booking.platform === 'booking' &&
    booking.booked_at === '2026-10-01' &&
    booking.external_order_no === 'synthetic-ota-order'));
  assert.ok(result.bookings.every(booking => booking.snapshot_only && booking.price_hidden));
});
