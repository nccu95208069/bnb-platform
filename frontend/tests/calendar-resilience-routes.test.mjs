import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { NextRequest } from 'next/server';
import { GET } from '../src/app/api/v1/bookings/calendar/route.ts';
import { createMemberSession, MEMBER_COOKIE } from '../src/lib/workspace-auth/session.ts';
import { SWEETFUN_SOURCE, OFFLAND_SOURCE } from '../src/lib/booking-sources/config.ts';
import { HEADERS, initialState } from '../src/lib/sheet-monitor/reconcile.ts';
import { adaptSheetBookings } from '../src/lib/booking-sources/sweetfun-sheet.ts';

const values = source => [HEADERS, [source.property.rooms[0].number, 'SYNTHETIC_GUEST', 'Agoda', '2026-10-07', '2026-10-08', '2026-09-01', '2500', 'done', 'OK', 'synthetic-row', 'SYNTHETIC_NOTE', 'parent']];

test('authenticated production route returns private no-store fallback, scopes properties and prices, and fails closed after revocation', async t => {
  const old = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]; Object.assign(process.env, old); });
  Object.assign(process.env, { CALENDAR_SOURCE: 'sheet_snapshot', SHEET_MONITOR_ENABLED: 'true', BOOKING_SHEET_SOURCES: 'sweetfun,offland', CALENDAR_OWNER_CODE_HASH: 'a'.repeat(64), CALENDAR_OWNER_SESSION_SECRET: 'b'.repeat(64), KV_REST_API_URL: 'https://fixture.invalid', KV_REST_API_TOKEN: 'synthetic' });
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const credential = JSON.stringify({ client_email: 'fixture@example.test', private_key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
  for (const source of [SWEETFUN_SOURCE, OFFLAND_SOURCE]) process.env[source.credentialEnv] = credential;
  const member = { id: 'c'.repeat(32), displayName: 'Synthetic viewer', role: 'viewer', status: 'active', allProperties: false, propertyIds: ['sweetfun'], credential: { schema: 1, kind: 'password', revision: 'd'.repeat(64), salt: 'e'.repeat(32), hash: 'f'.repeat(128) } };
  const commands = [], logs = [];
  let googleFails = true, snapshotFails = false, financeFails = false;
  t.mock.method(console, 'info', line => logs.push(line)); t.mock.method(console, 'error', line => logs.push(line));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://oauth2.googleapis.com/token') return googleFails ? new Response('', { status: 429 }) : Response.json({ access_token: 'synthetic' });
    if (String(url).startsWith('https://sheets.googleapis.com/')) {
      const source = String(url).includes(SWEETFUN_SOURCE.spreadsheetId) ? SWEETFUN_SOURCE : OFFLAND_SOURCE;
      if (String(url).includes('/values/')) return Response.json({ majorDimension: 'ROWS', values: values(source) });
      return Response.json({ properties: { timeZone: 'Asia/Taipei' }, sheets: [{ properties: { sheetId: source.sheetId, title: source.sheetTitle, gridProperties: { rowCount: 2, columnCount: 20 } } }] });
    }
    assert.equal(url, 'https://fixture.invalid'); const c = JSON.parse(options.body); commands.push(c);
    if (c[0] === 'EVAL') return Response.json({ result: '[]' });
    if (c[1].endsWith(':members')) return Response.json({ result: JSON.stringify({ version: 1, members: [member] }) });
    if (c[1].includes(':sheet-monitor:')) {
      if (snapshotFails) return new Response('', { status: 503 });
      const source = c[1].startsWith('sweetfun:') ? SWEETFUN_SOURCE : OFFLAND_SOURCE;
      const snapshot = adaptSheetBookings(values(source), source.sourceId, new Date().toISOString(), [], undefined, source.property);
      const state = { ...initialState(snapshot), checkedAt: new Date().toISOString(), lastSuccessfulAt: new Date().toISOString() };
      return Response.json({ result: `gz1:${gzipSync(JSON.stringify(state)).toString('base64')}` });
    }
    if (c[0] === 'MGET') return Response.json({ result: financeFails ? [] : c.slice(1).map(() => null) });
    return Response.json({ result: null });
  });
  const request = (cookie = true) => new NextRequest('https://fixture.invalid/api/v1/bookings/calendar?start=2026-10-01&end=2026-11-01', { headers: cookie ? { cookie: `${MEMBER_COOKIE}=${createMemberSession(member)}` } : {} });
  const unauth = await GET(request(false)); assert.equal(unauth.status, 401); assert.equal(commands.length, 0);
  let response = await GET(request()); let data = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'private, no-store'); assert.equal(response.headers.get('Vary'), 'Cookie'); assert.equal(response.headers.get('X-Request-ID'), data.request_id);
  assert.deepEqual(data.properties.map(p => p.id), ['sweetfun']); assert.equal(data.bookings.length, 1); assert.equal(data.bookings[0].guest_name_kind, 'missing'); assert.equal(data.source_warnings[0].phase, 'guest_details');
  assert.ok(commands.filter(c => c[1].includes(':sheet-monitor:')).every(c => c[1].startsWith('sweetfun:')));
  assert.ok(logs.some(line => line.includes('429'))); assert.ok(logs.every(line => !line.includes('SYNTHETIC_GUEST')));
  googleFails = false; financeFails = true;
  data = await (await GET(request())).json(); assert.equal(data.bookings[0].guest_name, 'SYNTHETIC_GUEST'); assert.equal(data.bookings[0].payment_status, 'unknown'); assert.equal(data.bookings[0].payment_unconfirmed, true);
  member.role = 'viewer_no_price'; commands.length = 0;
  data = await (await GET(request())).json(); assert.equal(data.bookings[0].room_rate, 0); assert.equal(data.bookings[0].source_notes, undefined); assert.equal(data.total_amount, 0); assert.ok(!commands.some(c => c[0] === 'MGET'));
  snapshotFails = true; response = await GET(request()); assert.equal(response.status, 503); assert.equal(response.headers.get('Cache-Control'), 'private, no-store'); assert.equal((await response.json()).bookings, undefined);
  const revokedRequest = request(); member.status = 'disabled'; commands.length = 0;
  response = await GET(revokedRequest); assert.equal(response.status, 401); assert.ok(commands.every(c => c[1].endsWith(':members')));
});
