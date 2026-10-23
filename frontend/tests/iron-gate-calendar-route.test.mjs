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
    CALENDAR_SOURCE: 'sheet_snapshot', BOOKING_SHEET_SOURCES: 'sweetfun',
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
    propertyIds: ['sweetfun'], credential: { schema: 1, kind: 'password',
      revision: 'd'.repeat(64), salt: 'e'.repeat(32), hash: 'f'.repeat(128) } };
  let inventoryMatches = true;
  let snapshotMatches = true;
  let sheetCalls = 0;
  let igCalls = 0;
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = String(url);
    if (target === 'https://fixture.invalid') {
      const command = JSON.parse(options.body);
      if (command[1]?.endsWith(':members'))
        return Response.json({ result: JSON.stringify({ version: 1, members: [member] }) });
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
    const preview = process.env.IRON_GATE_SWEETFUN_CALENDAR_PREVIEW_ENABLED === 'true';
    if (target.includes('/availability?')) {
      const cells = Object.entries(roomIds).map(([room, roomId]) => ({
        roomId, date: '2026-10-25',
        state: room === '101' && inventoryMatches ? 'sold' : 'unsold',
        saleReady: false,
      }));
      return Response.json({ propertyId, inventoryVersion: 7,
        authorityEpoch: preview ? 0 : 1, cells });
    }
    return Response.json({ propertyId, inventoryVersion: 7,
      authorityEpoch: preview ? 0 : 1, readOnly: preview,
      snapshot: preview ? { capturedAt: '2026-10-21T09:52:08.770Z',
        sourceHash: snapshotMatches ? 'f'.repeat(64) : 'e'.repeat(64) } : null,
      nextCursor: null,
      bookings: [{ id: '66666666-6666-4666-8666-666666666666',
        workspaceId, propertyId, status: 'confirmed', guestName: 'Sample Guest',
        stays: [{ checkIn: '2026-10-25', checkOut: '2026-10-26',
          roomIds: [roomIds['101']] }] }] });
  });
  const request = new NextRequest('https://fixture.invalid/api/v1/bookings/calendar?start=2026-10-25&end=2026-10-26', {
    headers: { cookie: `${MEMBER_COOKIE}=${createMemberSession(member)}` },
  });
  const first = await GET(request);
  const data = await first.json();
  assert.equal(first.status, 200);
  assert.equal(data.data_mode, 'iron_gate_booking_only');
  assert.equal(data.bookings.length, 1);
  assert.equal(data.bookings[0].guest_name, 'Sample Guest');
  assert.equal(data.price_hidden, true);
  assert.equal(data.source.availability_authoritative, false);
  assert.equal(sheetCalls, 0);
  assert.equal(igCalls, 3);

  inventoryMatches = false;
  const failed = await GET(request);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).bookings, undefined);
  assert.equal(sheetCalls, 0);

  inventoryMatches = true;
  delete process.env.IRON_GATE_SWEETFUN_CALENDAR_ENABLED;
  Object.assign(process.env, {
    IRON_GATE_SWEETFUN_CALENDAR_PREVIEW_ENABLED: 'true',
    IRON_GATE_SWEETFUN_SNAPSHOT_VERSION: '7',
    IRON_GATE_SWEETFUN_SNAPSHOT_HASH: 'f'.repeat(64),
  });
  const previewResponse = await GET(request);
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200);
  assert.equal(preview.data_mode, 'iron_gate_snapshot_preview');
  assert.equal(preview.source.private_snapshot_at, '2026-10-21T09:52:08.770Z');
  assert.equal(preview.source.automatic_sync, false);
  assert.equal(preview.bookings[0].snapshot_only, true);
  assert.equal(sheetCalls, 0);
  snapshotMatches = false;
  const drift = await GET(request);
  assert.equal(drift.status, 503);
  assert.equal((await drift.json()).bookings, undefined);
  assert.equal(sheetCalls, 0);
});
