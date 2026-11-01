import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { NextRequest } from 'next/server';
import { createOsMemberProofVerifier } from '../../iron-gate/src/os-member-proof.mjs';
import { offlandIronGateCalendarConfig, readIronGateAvailabilitySnapshot } from
  '../src/lib/booking-sources/iron-gate-calendar.server.ts';
import { liveAvailability } from '../src/lib/live-availability.ts';
import { attachOfflandReference, OFFLAND_REFERENCE_KEY } from '../src/lib/offland-reference.ts';
import { GET } from '../src/app/api/v1/availability/route.ts';
import { createMemberSession, MEMBER_COOKIE } from '../src/lib/workspace-auth/session.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const propertyId = '22222222-2222-4222-8222-222222222222';
const roomId = '55555555-5555-4555-8555-555555555555';
const secret = 'synthetic-offland-proof-32-bytes-long';
const grant = { credentialId: '33333333-3333-4333-8333-333333333333',
  clientId: '44444444-4444-4444-8444-444444444444', workspaceId, propertyId,
  token: 'o'.repeat(43) };
const principal = { id: 'synthetic-offland-owner', role: 'owner', propertyIds: ['offland'],
  allProperties: false, viewPrices: true };
const now = new Date();
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const day = offset => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86400000)
  .toISOString().slice(0, 10);
const from = day(1), to = day(8);
const query = { start: from, end: to, rooms: [], channel: 'direct', demo_cycle: 1 };

function environment() {
  return { IRON_GATE_OFFLAND_CALENDAR_ENABLED: 'true',
    IRON_GATE_OFFLAND_CALENDAR_PREVIEW_ENABLED: 'false',
    IRON_GATE_OFFLAND_CALENDAR_GRANT: JSON.stringify(grant),
    IRON_GATE_OFFLAND_ROOM_IDS: JSON.stringify({ 包棟: roomId }),
    IRON_GATE_OFFLAND_OS_PROOF_SECRET: secret,
    IRON_GATE_OFFLAND_BASE_URL: 'https://offland-iron-gate.example/',
    IRON_GATE_OFFLAND_AUTHORITY_EPOCH: '4' };
}
function snapshot() {
  return { inventorySchemaVersion: 1, propertyId, workspaceId, from, to,
    inventoryVersion: 9, authorityEpoch: 4, readOnly: false,
    bookings: ['confirmed', 'held'].map((status, i) => ({
      id: `66666666-6666-4666-8666-66666666666${i}`, propertyId, workspaceId, status,
      guestName: 'PRIVATE_OFFLAND_GUEST', totalCents: 999999,
      stays: [{ checkIn: day(i + 1), checkOut: day(i + 2), roomIds: [roomId] }],
    })),
    cells: [
      { roomId, date: day(1), state: 'sold', protectionReasons: ['source_review'] },
      { roomId, date: day(2), state: 'held', protectionReasons: [] },
      { roomId, date: day(3), state: 'blocked', protectionReasons: ['manual_block', 'channel_review'] },
      { roomId, date: day(4), state: 'blocked', protectionReasons: ['source_review'] },
    ] };
}
function prices() {
  return { schema: 1, property_id: 'offland', version: 'a'.repeat(20),
    source_commit: 'b'.repeat(40), observed_at: now.toISOString(),
    cells: Array.from({ length: 7 }, (_, i) => ({ date: day(i + 1), room: '包棟',
      channels: { direct: 18000, direct_four: 15000, booking: 20000 }, rack_price: 22000,
      daytype: '平日', baseline_version: 'synthetic-offland',
      stock: { count: i === 4 ? 0 : 1, is_lock: false } })) };
}
function research() {
  return { schema: 1, property_id: 'offland', version: 'c'.repeat(20), asof: today,
    model: 'offland-pooled-retained-v1', publication_enabled: false,
    cells: Array.from({ length: 7 }, (_, i) => ({ date: day(i + 1), probability: 0.5,
      direct: { current: i === 6 ? 17000 : 18000, suggested: 16000 },
      direct_four: { current: 15000, suggested: 13000 } })) };
}
async function read(raw = snapshot(), acting = principal) {
  const config = offlandIronGateCalendarConfig(environment());
  const verify = createOsMemberProofVerifier(secret);
  let reads = 0;
  const result = await readIronGateAvailabilitySnapshot(from, to, acting, config,
    async (url, init) => {
      reads++;
      assert.equal(url, `https://offland-iron-gate.example/v1/properties/${propertyId}/calendar-snapshot?from=${from}&to=${to}`);
      assert.equal(init.headers.authorization, `Bearer ${grant.token}`);
      const proof = await verify(new Request(url, init), { ...grant, origin: 'os' });
      assert.deepEqual(proof?.propertyIds, [propertyId]);
      assert.equal(proof?.subjectId, acting.id);
      assert.deepEqual(proof?.actions, ['booking:read']);
      assert.deepEqual(proof?.fields, []);
      return Response.json(raw);
    });
  assert.equal(reads, 1);
  return result;
}

test('Offland reads one scoped villa snapshot without guest or payment fields', async () => {
  const current = await read();
  assert.equal(current.property, 'offland');
  assert.equal(current.authorityEpoch, 4);
  assert.equal(current.inventoryVersion, 9);
  assert.equal(current.cells.length, 7);
  assert(current.cells.every(cell => cell.room === '包棟'));
  assert.deepEqual(current.cells.map(cell => cell.state),
    ['sold', 'held', 'blocked', 'blocked', 'unsold', 'unsold', 'unsold']);
  for (const privateText of ['PRIVATE_OFFLAND_GUEST', '999999', '66666666-6666-4666'])
    assert.equal(JSON.stringify(current).includes(privateText), false);
});

test('Offland scope, schema and occupied-night inconsistencies fail closed', async t => {
  const cases = [
    ['missing schema', raw => { delete raw.inventorySchemaVersion; }],
    ['wrong property', raw => { raw.propertyId = workspaceId; }],
    ['wrong workspace', raw => { raw.workspaceId = propertyId; }],
    ['wrong epoch', raw => { raw.authorityEpoch = 1; }],
    ['preview response', raw => { raw.readOnly = true; }],
    ['wrong dates', raw => { raw.to = day(9); }],
    ['foreign room', raw => { raw.cells[2].roomId = propertyId; }],
    ['foreign stay room', raw => { raw.bookings[0].stays[0].roomIds = [propertyId]; }],
    ['too many villa rooms', raw => { raw.bookings[0].stays[0].roomIds.push(roomId); }],
    ['missing occupied cell', raw => { raw.cells.shift(); }],
    ['duplicate cell', raw => { raw.cells.push(raw.cells[0]); }],
    ['held mismatch', raw => { raw.cells[1].state = 'sold'; }],
    ['retained cannot occupy', raw => { raw.bookings[0].status = 'retained'; }],
    ['cancelled cannot occupy', raw => { raw.bookings[0].status = 'cancelled'; }],
    ['unexplained block', raw => { raw.cells[2].protectionReasons = []; }],
    ['missing protection list', raw => { delete raw.cells[2].protectionReasons; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const raw = snapshot(); mutate(raw);
    await assert.rejects(read(raw), /IRON_GATE_CALENDAR_/);
  });
  let fetches = 0;
  await assert.rejects(readIronGateAvailabilitySnapshot(from, to,
    { ...principal, propertyIds: ['sweetfun'] }, offlandIronGateCalendarConfig(environment()),
    async () => { fetches++; return Response.json(snapshot()); }), /FORBIDDEN/);
  assert.equal(fetches, 0);
});

test('four and six guests share villa occupancy while prices and research stay plan-specific', async () => {
  const current = await read();
  const six = attachOfflandReference(liveAvailability(query, current, prices(), now, 'offland'), research());
  const four = attachOfflandReference(liveAvailability({ ...query, channel: 'direct_four', rooms: ['包棟'] },
    current, prices(), now, 'offland'), research());
  assert.deepEqual(six.cells.map(cell => cell.state),
    ['sold', 'held', 'blocked', 'unknown', 'unknown', 'available', 'available']);
  assert.deepEqual(four.counts, six.counts);
  assert.equal(six.cells.length, 7);
  assert.equal(six.counts.available, 2);
  assert.equal(six.cells[5].pricing.current_price, 18000);
  assert.equal(four.cells[5].pricing.current_price, 15000);
  assert.equal(six.cells[5].offland_reference.suggested_price, 16000);
  assert.equal(four.cells[5].offland_reference.suggested_price, 13000);
  assert.equal(six.cells[5].offland_reference.probability, four.cells[5].offland_reference.probability);
  assert.equal(six.cells[6].offland_reference.suggested_price, null);
  assert(six.cells.slice(0, 5).every(cell => cell.offland_reference === null));
  assert.throws(() => liveAvailability(query, current, null, now, 'sweetfun'), /SCOPE_MISMATCH/);
});

test('checkout and released villa nights become unoccupied while explicit review protections remain', async () => {
  const raw = snapshot();
  raw.bookings = [raw.bookings[0]];
  raw.cells = raw.cells.filter(cell => cell.state !== 'held');
  const current = await read(raw);
  assert.equal(current.cells[0].state, 'sold');
  assert.equal(current.cells[1].state, 'unsold');
  raw.bookings = [];
  raw.cells = raw.cells.filter(cell => cell.state !== 'sold');
  const released = liveAvailability(query, await read(raw), null, now, 'offland');
  assert.equal(released.cells[0].state, 'available');
  assert.equal(released.cells[1].state, 'available');
  assert.equal(released.cells[2].state, 'blocked');
  assert.equal(released.cells[3].state, 'unknown');
});

test('Offland route uses its grant and pricing, keeps optional research, and never reads legacy occupancy', async t => {
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
    IRON_GATE_SWEETFUN_CALENDAR_GRANT: 'invalid-wrong-property-grant',
  });
  const member = { id: 'c'.repeat(32), displayName: 'Synthetic viewer', role: 'viewer',
    status: 'active', allProperties: false, propertyIds: ['offland'],
    credential: { schema: 1, kind: 'password', revision: 'd'.repeat(64), salt: 'e'.repeat(32), hash: 'f'.repeat(128) } };
  const noPrice = { ...member, id: 'b'.repeat(32), role: 'viewer_no_price' };
  const sweetfunOnly = { ...member, id: 'a'.repeat(32), propertyIds: ['sweetfun'] };
  let mode = 'valid', researchMode = 'valid', igReads = 0, sheetReads = 0;
  const keys = [];
  const verify = createOsMemberProofVerifier(secret);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url) === 'https://fixture.invalid') {
      const command = JSON.parse(init.body), key = command[1]; keys.push(key);
      if (key?.endsWith(':members')) return Response.json({ result: JSON.stringify({ version: 1, members: [member, noPrice, sweetfunOnly] }) });
      if (key?.includes(':sheet-monitor:')) { sheetReads++; throw Error('OLD_SHEET_MUST_NOT_BE_READ'); }
      if (key === 'sweetfun-os:pricing:v1:offland') return Response.json({ result: 'gz1:' + gzipSync(JSON.stringify(prices())).toString('base64') });
      if (key === OFFLAND_REFERENCE_KEY) {
        if (researchMode === 'failed') throw Error('OPTIONAL_RESEARCH_UNAVAILABLE');
        return Response.json({ result: JSON.stringify(researchMode === 'invalid' ? {} : research()) });
      }
      return Response.json({ result: null });
    }
    assert.ok(String(url).startsWith('https://offland-iron-gate.example/'));
    assert.equal(init.headers.authorization, `Bearer ${grant.token}`);
    const proof = await verify(new Request(url, init), { ...grant, origin: 'os' });
    assert.deepEqual(proof?.fields, []);
    igReads++;
    if (mode === 'failed') return Response.json({ error: 'UNAVAILABLE' }, { status: 503 });
    const raw = snapshot();
    if (mode === 'old-schema') delete raw.inventorySchemaVersion;
    if (mode === 'wrong-property') raw.propertyId = workspaceId;
    if (mode === 'wrong-epoch') raw.authorityEpoch = 1;
    return Response.json(raw);
  });
  const request = (acting = member, extra = '') => new NextRequest(
    `https://fixture.invalid/api/v1/availability?property=offland&start=${from}&end=${to}&channel=direct${extra}`,
    { headers: acting ? { cookie: `${MEMBER_COOKIE}=${createMemberSession(acting)}` } : {} });
  assert.equal((await GET(request(null))).status, 401);
  assert.equal((await GET(request(noPrice))).status, 403);
  assert.equal((await GET(request(sweetfunOnly))).status, 403);
  assert.equal((await GET(request(member, '&rooms=101'))).status, 400);
  assert.equal(igReads, 0);
  assert(keys.every(key => !String(key).includes(':pricing:')));
  const response = await GET(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const data = await response.json();
  assert.equal(data.mode, 'iron_gate_pricing_snapshot');
  assert.deepEqual(data.rooms, ['包棟']);
  assert.equal(data.cells.length, 7);
  assert.equal(data.counts.sold, 1);
  assert.equal(data.counts.held, 1);
  assert.equal(data.counts.blocked, 1);
  assert.equal(data.cells[5].offland_reference.suggested_price, 16000);
  assert.equal(data.cells[5].pricing.current_price, 18000);
  assert(data.properties.every(property => property.id === 'offland'));
  for (const privateText of ['PRIVATE_OFFLAND_GUEST', '999999', '66666666-6666-4666'])
    assert.equal(JSON.stringify(data).includes(privateText), false);
  for (researchMode of ['failed', 'invalid']) {
    const degraded = await GET(request()); assert.equal(degraded.status, 200);
    const body = await degraded.json();
    assert.equal(body.cells[5].pricing.current_price, 18000);
    assert(body.cells.every(cell => cell.offland_reference === null));
  }
  for (mode of ['failed', 'old-schema', 'wrong-property', 'wrong-epoch']) {
    const failed = await GET(request()); assert.equal(failed.status, 503);
    assert.equal((await failed.json()).cells, undefined);
  }
  process.env.IRON_GATE_OFFLAND_CALENDAR_ENABLED = 'false';
  assert.equal((await GET(request())).status, 503);
  assert.equal(sheetReads, 0);
  assert(!keys.includes('sweetfun-os:pricing:v1:sweetfun'));
});
