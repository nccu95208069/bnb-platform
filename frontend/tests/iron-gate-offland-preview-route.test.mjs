import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NextRequest } from 'next/server';
import { GET } from '../src/app/api/v1/bookings/calendar/route.ts';
import { OFFLAND_PREVIEW_OWNER_COOKIE,
  createOfflandPreviewOwnerSession } from '../src/lib/iron-gate-preview-owner.ts';

test('Offland fixed snapshot preview reads Iron Gate without querying Sheet', async t => {
  const before = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  });
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const propertyId = '22222222-2222-4222-8222-222222222222';
  const roomId = '33333333-3333-4333-8333-333333333333';
  const grant = { credentialId: '44444444-4444-4444-8444-444444444444',
    clientId: '55555555-5555-4555-8555-555555555555',
    workspaceId, propertyId, token: 'a'.repeat(43) };
  Object.assign(process.env, {
    NODE_ENV: 'production', VERCEL_ENV: 'preview',
    CALENDAR_SOURCE: 'sheet_snapshot', BOOKING_SHEET_SOURCES: 'sweetfun,offland',
    IRON_GATE_PREVIEW_OWNER_ONLY: 'true',
    IRON_GATE_OFFLAND_PREVIEW_OWNER_CODE_HASH: 'b'.repeat(64),
    IRON_GATE_OFFLAND_PREVIEW_OWNER_SESSION_SECRET: 'c'.repeat(64),
    IRON_GATE_OFFLAND_CALENDAR_PREVIEW_ENABLED: 'true',
    IRON_GATE_OFFLAND_CALENDAR_GRANT: JSON.stringify(grant),
    IRON_GATE_OFFLAND_ROOM_IDS: JSON.stringify({ '包棟': roomId }),
    IRON_GATE_SWEETFUN_OS_PROOF_SECRET: 'private-test-proof-secret-32-bytes-long',
    IRON_GATE_OFFLAND_BASE_URL: 'https://iron-gate.example',
    IRON_GATE_OFFLAND_SNAPSHOT_VERSION: '1',
    IRON_GATE_OFFLAND_SNAPSHOT_HASH: 'f'.repeat(64),
  });
  let availabilityCalls = 0, bookingCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = String(url);
    assert.ok(target.startsWith(`https://iron-gate.example/v1/properties/${propertyId}/`));
    assert.equal(options.headers.authorization, `Bearer ${grant.token}`);
    if (target.includes('/availability?')) {
      availabilityCalls++;
      return Response.json({ propertyId, authorityEpoch: 0, inventoryVersion: 1,
        cells: [{ roomId, date: '2026-10-25', state: 'sold' }] });
    }
    assert.ok(target.includes('/bookings?'));
    bookingCalls++;
    return Response.json({ propertyId, inventoryVersion: 1, authorityEpoch: 0,
      readOnly: true, snapshot: { capturedAt: '2026-10-24T17:57:16.530Z',
        sourceHash: 'f'.repeat(64) }, nextCursor: null,
      bookings: [{ id: '66666666-6666-4666-8666-666666666666',
        workspaceId, propertyId, status: 'confirmed', version: 1,
        guestName: 'Synthetic guest', channelSyncState: 'not_required',
        stays: [{ checkIn: '2026-10-25', checkOut: '2026-10-26',
          roomIds: [roomId] }] }] });
  });
  const cookie = createOfflandPreviewOwnerSession();
  const request = new NextRequest('https://preview.example/api/v1/bookings/calendar?start=2026-10-25&end=2026-10-26&properties=offland',
    { headers: { cookie: `${OFFLAND_PREVIEW_OWNER_COOKIE}=${cookie}` } });
  const response = await GET(request);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.data_mode, 'iron_gate_booking_only');
  assert.equal(data.price_hidden, true);
  assert.deepEqual(data.bookings.map(booking => booking.property_id), ['offland']);
  assert.equal(data.bookings[0].snapshot_only, true);
  assert.equal(data.source.private_snapshot_version, '1');
  assert.equal(availabilityCalls, 1);
  assert.equal(bookingCalls, 2);
});
