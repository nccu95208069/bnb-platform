import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { NextRequest } from 'next/server';
import { createOsMemberProofVerifier } from '../../iron-gate/src/os-member-proof.mjs';
import { ironGateCalendarConfig, readIronGateAvailabilitySnapshot } from
  '../src/lib/booking-sources/iron-gate-calendar.server.ts';
import { liveAvailability } from '../src/lib/live-availability.ts';
import { GET } from '../src/app/api/v1/availability/route.ts';
import { createMemberSession, MEMBER_COOKIE } from '../src/lib/workspace-auth/session.ts';
import { PRICING_KEY } from '../src/lib/pricing-snapshot.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const propertyId = '22222222-2222-4222-8222-222222222222';
const roomIds = Object.fromEntries(['101', '102', '201', '202', '301', '302'].map((room, i) =>
  [room, `55555555-5555-4555-8555-55555555555${i}`]));
const secret = 'synthetic-private-proof-32-bytes-long';
const grant = { credentialId: '33333333-3333-4333-8333-333333333333',
  clientId: '44444444-4444-4444-8444-444444444444', workspaceId, propertyId,
  token: 'a'.repeat(43) };
const principal = { id: 'synthetic-owner', role: 'owner', propertyIds: ['sweetfun'],
  allProperties: false, viewPrices: true };
const from = '2026-11-02', to = '2026-11-03';
const now = new Date('2026-10-30T09:00:00.000Z');
const query = { start: from, end: to, rooms: [], channel: 'booking', demo_cycle: 1 };

function environment() {
  return { IRON_GATE_SWEETFUN_CALENDAR_ENABLED: 'true',
    IRON_GATE_SWEETFUN_CALENDAR_GRANT: JSON.stringify(grant),
    IRON_GATE_SWEETFUN_ROOM_IDS: JSON.stringify(roomIds),
    IRON_GATE_SWEETFUN_OS_PROOF_SECRET: secret,
    IRON_GATE_SWEETFUN_BASE_URL: 'https://iron-gate.example/',
    IRON_GATE_SWEETFUN_AUTHORITY_EPOCH: '1' };
}
function snapshot() {
  return { inventorySchemaVersion: 1, propertyId, workspaceId, from, to,
    inventoryVersion: 137, authorityEpoch: 1, readOnly: false,
    bookings: ['confirmed', 'held'].map((status, i) => ({
      id: `66666666-6666-4666-8666-66666666666${i}`, propertyId, workspaceId, status,
      guestName: 'PRIVATE_SYNTHETIC_GUEST', totalCents: 999900,
      stays: [{ checkIn: from, checkOut: to, roomIds: [roomIds[i ? '102' : '101']] }],
    })),
    cells: [
      { roomId: roomIds['101'], date: from, state: 'sold', protectionReasons: ['source_review'] },
      { roomId: roomIds['102'], date: from, state: 'held', protectionReasons: [] },
      { roomId: roomIds['201'], date: from, state: 'blocked', protectionReasons: ['manual_block'] },
      { roomId: roomIds['202'], date: from, state: 'blocked', protectionReasons: ['channel_review'] },
    ] };
}
function prices() {
  return { schema: 1, property_id: 'sweetfun', version: 'a'.repeat(20),
    source_commit: 'b'.repeat(40), observed_at: now.toISOString(),
    cells: Object.keys(roomIds).map(room => ({ date: from, room,
      channels: { booking: 2000, agoda: 1800 }, rack_price: 2400, daytype: '平日',
      baseline_version: 'synthetic', stock: { count: room === '301' ? 0 : 1, is_lock: false } })) };
}
async function read(raw = snapshot(), acting = principal) {
  const config = ironGateCalendarConfig(environment());
  let calls = 0;
  const verify = createOsMemberProofVerifier(secret);
  const result = await readIronGateAvailabilitySnapshot(from, to, acting, config,
    async (url, init) => {
      calls++;
      assert.equal(url, `https://iron-gate.example/v1/properties/${propertyId}/calendar-snapshot?from=${from}&to=${to}`);
      assert.equal(init.cache, 'no-store');
      const proof = await verify(new Request(url, init), { ...grant, origin: 'os' });
      assert.deepEqual(proof?.actions, ['booking:read']);
      assert.deepEqual(proof?.fields, []);
      assert.equal(proof?.subjectId, acting.id);
      return Response.json(raw);
    });
  assert.equal(calls, 1);
  return result;
}

test('one signed authority snapshot preserves sold, held and protections without returning private booking data', async () => {
  const result = await read();
  assert.equal(result.inventoryVersion, 137);
  assert.equal(result.cells.length, 6);
  assert.deepEqual(result.cells.map(cell => cell.state), ['sold', 'held', 'blocked', 'blocked', 'unsold', 'unsold']);
  assert.deepEqual(result.cells[0].protectionReasons, ['source_review']);
  assert.deepEqual(result.cells[3].protectionReasons, ['channel_review']);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SYNTHETIC_GUEST'), false);
  assert.equal(JSON.stringify(result).includes('999900'), false);
  assert.equal(JSON.stringify(result).includes('66666666-6666-4666-8666'), false);
});

test('authority schema, scope, exact room-night coverage and booking occupancy fail closed', async t => {
  const cases = [
    ['old backend schema', raw => delete raw.inventorySchemaVersion],
    ['wrong property', raw => { raw.propertyId = workspaceId; }],
    ['wrong workspace', raw => { raw.workspaceId = propertyId; }],
    ['wrong authority', raw => { raw.authorityEpoch = 2; }],
    ['read-only preview', raw => { raw.readOnly = true; }],
    ['wrong window', raw => { raw.from = '2026-11-01'; }],
    ['missing occupied cell', raw => raw.cells.shift()],
    ['duplicate cell', raw => raw.cells.push(raw.cells[0])],
    ['unknown room', raw => { raw.cells[0].roomId = propertyId; }],
    ['outside window', raw => { raw.cells[2].date = to; }],
    ['missing protection list', raw => { delete raw.cells[2].protectionReasons; }],
    ['unexplained block', raw => { raw.cells[2].protectionReasons = []; }],
    ['unknown protection', raw => { raw.cells[2].protectionReasons = ['new_unknown_reason']; }],
    ['duplicate protection', raw => { raw.cells[2].protectionReasons.push('manual_block'); }],
    ['sold-held mismatch', raw => { raw.cells[1].state = 'sold'; }],
    ['unlinked occupied cell', raw => raw.bookings.shift()],
    ['duplicate booking', raw => raw.bookings.push(raw.bookings[0])],
    ['wrong booking property', raw => { raw.bookings[0].propertyId = workspaceId; }],
    ['retained booking cannot occupy', raw => { raw.bookings[0].status = 'retained'; }],
    ['duplicate room in stay', raw => raw.bookings[0].stays[0].roomIds.push(roomIds['101'])],
  ];
  for (const [label, change] of cases) await t.test(label, async () => {
    const raw = snapshot(); change(raw); await assert.rejects(read(raw), /IRON_GATE_CALENDAR_/);
  });
  await assert.rejects(read(snapshot(), { ...principal, propertyIds: ['offland'] }), /FORBIDDEN/);
});

test('current bookings win over channel observations; manual closure and review protection stay distinct', async () => {
  const current = await read();
  const result = liveAvailability(query, current, prices(), now);
  assert.deepEqual(result.cells.map(cell => cell.state), ['sold', 'held', 'blocked', 'unknown', 'unknown', 'available']);
  assert.deepEqual(result.counts, { available: 1, sold: 1, held: 1, blocked: 1,
    maintenance: 0, unknown: 2, conflict: 0, past: 0 });
  assert.equal(result.mode, 'iron_gate_pricing_snapshot');
  assert.equal(result.inventory_source.inventory_version, 137);
  assert.match(result.cells[2].reason, /人工關房/);
  assert.match(result.cells[3].reason, /來源待核或房況同步保護/);
  assert.match(result.cells[4].reason, /OwlNest/);
  assert.match(result.cells[5].reason, /目前訂單未占房/);
  assert.equal(result.cells[5].sellable_units, null);
  assert.equal(result.cells[5].pricing.eligible, false);
  const agoda = liveAvailability({ ...query, channel: 'agoda' }, current, prices(), now);
  assert.deepEqual(agoda.counts, result.counts);
  assert.equal(agoda.cells[5].pricing.current_price, 1800);
  assert.equal(result.cells[5].pricing.current_price, 2000);
  const oneRoom = liveAvailability({ ...query, rooms: ['302'] }, current, prices(), now);
  assert.equal(oneRoom.cells.length, 1);
  assert.equal(oneRoom.counts.available, 1);
  assert.throws(() => liveAvailability({ ...query, start: '2026-11-01' }, current, prices(), now), /SCOPE_MISMATCH/);
});

test('current cancellation and rescheduling release old nights; remaining review fences still prevent availability', async () => {
  const raw = snapshot();
  raw.bookings = [];
  raw.cells = [{ roomId: roomIds['101'], date: from, state: 'blocked', protectionReasons: ['line_action_required'] }];
  const result = liveAvailability(query, await read(raw), null, now);
  assert.equal(result.cells[0].state, 'unknown');
  assert.equal(result.cells[1].state, 'available');
  assert.equal(result.counts.sold, 0);
  assert.equal(result.counts.held, 0);
  assert.equal(result.counts.available, 5);
});

test('past channel closures stay observations and combined protections never release a manual block', async () => {
  const raw = snapshot();
  raw.cells[2].protectionReasons.push('channel_review');
  const oldPrices = prices();
  oldPrices.observed_at = '2026-10-29T09:00:00.000Z';
  const current = await read(raw);
  const result = liveAvailability(query, current, oldPrices, now);
  assert.equal(result.cells[2].state, 'blocked');
  assert.equal(result.cells[3].state, 'unknown');
  assert.equal(result.cells[4].state, 'available');
  assert.equal(result.cells[4].channel_inventory.checked_today, false);
  assert.equal(result.cells[4].channel_inventory.count, 0);
  const inventory = { schema: 1, property_id: 'sweetfun', version: 'e'.repeat(20),
    observed_at: now.toISOString(), cells: [{ date: from, room: '301', count: 0,
      is_lock: false, observed_at: now.toISOString(), source_version: 'synthetic-stock' }] };
  const refreshed = liveAvailability(query, current, oldPrices, now, 'sweetfun', inventory);
  assert.equal(refreshed.cells[4].state, 'unknown');
  assert.equal(refreshed.cells[4].pricing.observed_at, oldPrices.observed_at);
});

test('Sweetfun route reads authority only and never falls back to Sheet after source or schema failure', async t => {
  const original = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  });
  Object.assign(process.env, environment(), {
    CALENDAR_SOURCE: 'sheet_snapshot', BOOKING_SHEET_SOURCES: 'sweetfun,offland',
    SHEET_MONITOR_ENABLED: 'true', CALENDAR_OWNER_CODE_HASH: 'a'.repeat(64),
    CALENDAR_OWNER_SESSION_SECRET: 'b'.repeat(64), KV_REST_API_URL: 'https://fixture.invalid',
    KV_REST_API_TOKEN: 'synthetic', UPSTASH_REDIS_REST_URL: '', UPSTASH_REDIS_REST_TOKEN: '',
  });
  const member = { id: 'c'.repeat(32), displayName: 'Synthetic viewer', role: 'viewer',
    status: 'active', allProperties: false, propertyIds: ['sweetfun'],
    credential: { schema: 1, kind: 'password', revision: 'd'.repeat(64), salt: 'e'.repeat(32), hash: 'f'.repeat(128) } };
  const noPrice = { ...member, id: 'b'.repeat(32), role: 'viewer_no_price' };
  let mode = 'valid', igReads = 0, sheetReads = 0;
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url) === 'https://fixture.invalid') {
      const command = JSON.parse(init.body);
      if (command[1]?.endsWith(':members')) return Response.json({ result: JSON.stringify({ version: 1, members: [member, noPrice] }) });
      if (command[1]?.includes(':sheet-monitor:')) { sheetReads++; throw Error('OLD_SHEET_MUST_NOT_BE_READ'); }
      if (command[1] === PRICING_KEY) return Response.json({ result: 'gz1:' + gzipSync(JSON.stringify(prices())).toString('base64') });
      return Response.json({ result: null });
    }
    assert.ok(String(url).startsWith('https://iron-gate.example/'));
    igReads++;
    if (mode === 'failed') return Response.json({ error: 'UNAVAILABLE' }, { status: 503 });
    const raw = snapshot(); if (mode === 'old-schema') delete raw.inventorySchemaVersion;
    return Response.json(raw);
  });
  const request = (acting = member, extra = '') => new NextRequest(
    `https://fixture.invalid/api/v1/availability?property=sweetfun&start=${from}&end=${to}&channel=booking${extra}`,
    { headers: acting ? { cookie: `${MEMBER_COOKIE}=${createMemberSession(acting)}` } : {} });
  assert.equal((await GET(request(null))).status, 401);
  assert.equal((await GET(request(noPrice))).status, 403);
  assert.equal((await GET(request(member, '&rooms=999'))).status, 400);
  assert.equal(igReads, 0);
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const data = await response.json();
  assert.equal(data.mode, 'iron_gate_pricing_snapshot');
  assert.equal(data.counts.sold, 1);
  assert.equal(data.counts.held, 1);
  assert.equal(data.counts.blocked, 1);
  assert.equal(JSON.stringify(data).includes('PRIVATE_SYNTHETIC_GUEST'), false);
  for (mode of ['failed', 'old-schema']) {
    const failed = await GET(request()); assert.equal(failed.status, 503);
    assert.equal((await failed.json()).cells, undefined);
  }
  process.env.IRON_GATE_SWEETFUN_CALENDAR_ENABLED = 'false';
  assert.equal((await GET(request())).status, 503);
  assert.equal(sheetReads, 0);
});
