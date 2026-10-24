import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import { GET } from '../src/app/api/v1/bookings/calendar/route.ts';
import { createMemberSession, MEMBER_COOKIE } from '../src/lib/workspace-auth/session.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const propertyId = '22222222-2222-4222-8222-222222222222';
const roomIds = Object.fromEntries(['101', '102', '201', '202', '301', '302']
  .map((room, i) => [room, `55555555-5555-4555-8555-55555555555${i}`]));
const grant = { credentialId: '33333333-3333-4333-8333-333333333333',
  clientId: '44444444-4444-4444-8444-444444444444',
  workspaceId, propertyId, token: 'a'.repeat(43) };

test('authenticated OS calendar uses Iron Gate and refuses a stale inventory without Sheet fallback', async t => {
  const original = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  });
  Object.assign(process.env, {
    CALENDAR_SOURCE: 'sheet_snapshot', BOOKING_SHEET_SOURCES: 'sweetfun,offland',
    CALENDAR_OWNER_CODE_HASH: 'a'.repeat(64),
    CALENDAR_OWNER_SESSION_SECRET: 'b'.repeat(64),
    KV_REST_API_URL: 'https://fixture.invalid', KV_REST_API_TOKEN: 'synthetic',
    IRON_GATE_SWEETFUN_CALENDAR_ENABLED: 'true',
    IRON_GATE_SWEETFUN_CALENDAR_GRANT: JSON.stringify(grant),
    IRON_GATE_SWEETFUN_ROOM_IDS: JSON.stringify(roomIds),
    IRON_GATE_SWEETFUN_OS_PROOF_SECRET: 'private-test-proof-secret-32-bytes-long',
    IRON_GATE_SWEETFUN_BASE_URL: 'https://iron-gate.example/',
    IRON_GATE_SWEETFUN_AUTHORITY_EPOCH: '1',
  });
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const member = { id: 'c'.repeat(32), displayName: 'Synthetic viewer',
    role: 'viewer', status: 'active', allProperties: false,
    propertyIds: ['sweetfun', 'offland'], credential: { schema: 1, kind: 'password',
      revision: 'd'.repeat(64), salt: 'e'.repeat(32), hash: 'f'.repeat(128) } };
  const noPriceMember = { ...member, id: 'b'.repeat(32), role: 'viewer_no_price' };
  let inventoryMatches = true;
  let sheetCalls = 0;
  let igCalls = 0;
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = String(url);
    if (target === 'https://fixture.invalid') {
      const command = JSON.parse(options.body);
      if (command[1]?.endsWith(':members'))
        return Response.json({ result: JSON.stringify({ version: 1, members: [member, noPriceMember] }) });
      if (command[0] === 'MGET')
        return Response.json({ result: command.slice(1).map(() => null) });
      if (command[0] === 'SCAN')
        return Response.json({ result: ['0', []] });
      return Response.json({ result: null });
    }
    if (target.startsWith('https://sheets.googleapis.com/')) {
      sheetCalls++;
      throw Error('Sheet must not be queried after Iron Gate is selected');
    }
    assert.ok(target.startsWith('https://iron-gate.example/v1/properties/'));
    assert.equal(options.headers.authorization, `Bearer ${grant.token}`);
    assert.ok(options.headers['x-iron-gate-os-proof']);
    igCalls++;
    assert.ok(target.includes('/calendar-snapshot?'));
    const cells = inventoryMatches ? [{ roomId: roomIds['101'],
      date: '2026-10-25', state: 'sold' }] : [];
    return Response.json({ propertyId, workspaceId, from: '2026-10-25',
      to: '2026-10-26', inventoryVersion: 7,
      authorityEpoch: 1, readOnly: false, cells,
      bookings: [{ id: '66666666-6666-4666-8666-666666666666',
        workspaceId, propertyId, status: 'confirmed', channelSyncState: 'not_required',
        guestName: 'Sample Guest',
        version: 1, currency: 'TWD', totalCents: 179000, stayAmountsCents: [179000],
        paymentReview: { status: 'paid', source: 'sheet_flag' },
        stays: [{ checkIn: '2026-10-25', checkOut: '2026-10-26',
          roomIds: [roomIds['101']] }] }] });
  });
  const request = new NextRequest('https://fixture.invalid/api/v1/bookings/calendar?start=2026-10-25&end=2026-10-26&properties=sweetfun', {
    headers: { cookie: `${MEMBER_COOKIE}=${createMemberSession(member)}` },
  });
  const first = await GET(request);
  const data = await first.json();
  assert.equal(first.status, 200);
  assert.equal(data.data_mode, 'iron_gate_booking_only');
  assert.equal(data.bookings.length, 1);
  assert.equal(data.bookings[0].guest_name, 'Sample Guest');
  assert.equal(data.properties.length, 2);
  assert.equal(data.rooms.length, 6);
  assert.equal(data.price_hidden, false);
  assert.equal(data.bookings[0].price_hidden, false);
  assert.equal(data.bookings[0].room_rate, 1790);
  assert.equal(data.bookings[0].payment_status, 'paid');
  assert.equal(data.bookings[0].payment_review_status, 'paid');
  assert.equal(data.source.availability_authoritative, false);
  assert.equal(sheetCalls, 0);
  assert.equal(igCalls, 1);

  const noPriceRequest = new NextRequest('https://fixture.invalid/api/v1/bookings/calendar?start=2026-10-25&end=2026-10-26&properties=sweetfun', {
    headers: { cookie: `${MEMBER_COOKIE}=${createMemberSession(noPriceMember)}` },
  });
  const noPriceResponse = await GET(noPriceRequest);
  const noPriceData = await noPriceResponse.json();
  assert.equal(noPriceResponse.status, 200);
  assert.equal(noPriceData.price_hidden, true);
  assert.equal(noPriceData.bookings[0].price_hidden, true);
  assert.equal(noPriceData.bookings[0].room_rate, 0);

  inventoryMatches = false;
  const failed = await GET(request);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).bookings, undefined);
  assert.equal(sheetCalls, 0);
});
