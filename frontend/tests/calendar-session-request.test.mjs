import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { GET } from '../src/app/api/calendar-session/route.ts';
import { calendarSessionFor, createMemberSession, MEMBER_COOKIE,
  principalFor, sessionMember } from '../src/lib/workspace-auth/session.ts';
import { createOwnerSession, OWNER_COOKIE } from '../src/lib/calendar-owner-session.ts';
import { calendarServerTiming } from '../src/lib/calendar-server-timing.ts';
import { readCalendarSources } from '../src/lib/booking-sources/calendar-reader.ts';
import { SWEETFUN_SOURCE } from '../src/lib/booking-sources/config.ts';
import { adaptSheetBookings } from '../src/lib/booking-sources/sweetfun-sheet.ts';
import { HEADERS } from '../src/lib/sheet-monitor/reconcile.ts';

const credential = { schema: 1, kind: 'password', revision: 'd'.repeat(64),
  salt: 'e'.repeat(32), hash: 'f'.repeat(128) };
const memberFixture = () => ({ id: 'c'.repeat(32), displayName: 'Synthetic viewer',
  email: 'viewer@example.test', phone: null, role: 'viewer', status: 'active',
  allProperties: false, propertyIds: ['sweetfun', 'offland'], credential,
  mustResetPassword: false, invitation: null, version: 1 });
function configure(t) {
  const original = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
  });
  for (const key of Object.keys(process.env))
    if (key.startsWith('IRON_GATE_') || key.startsWith('UPSTASH_') ||
      ['CUSTOMER_ISOLATED_ACCEPTANCE', 'WORKSPACE_AUTH_NAMESPACE', 'CALENDAR_OWNER_AUTH_NAMESPACE'].includes(key))
      delete process.env[key];
  Object.assign(process.env, { CALENDAR_OWNER_CODE_HASH: 'a'.repeat(64),
    CALENDAR_OWNER_SESSION_SECRET: 'b'.repeat(64),
    KV_REST_API_URL: 'https://auth.fixture.invalid', KV_REST_API_TOKEN: 'synthetic' });
}
const requestFor = (cookie) => new NextRequest('https://calendar.test/api/calendar-session',
  { headers: cookie ? { cookie } : {} });
function metrics(response) {
  const header = response.headers.get('Server-Timing');
  assert.match(header, /^auth;dur=\d+\.\d, source;dur=\d+\.\d, payment;dur=\d+\.\d, total;dur=\d+\.\d$/);
  return Object.fromEntries(header.split(', ').map(metric => {
    const [name, duration] = metric.split(';dur=');
    return [name, Number(duration)];
  }));
}

test('concurrent session consumers share one member read and the next request sees scope changes and revocation', async t => {
  configure(t);
  const member = memberFixture();
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const command = JSON.parse(options.body);
    assert.deepEqual(command, ['GET', 'sweetfun-os:workspace-auth:v1:members']);
    reads++;
    await Promise.resolve();
    return Response.json({ result: JSON.stringify({ version: 1, members: [member] }) });
  });
  const cookie = `${MEMBER_COOKIE}=${createMemberSession(member)}`;
  const request = requestFor(cookie);
  const [principal, limited, bootstrap, apiResponse] = await Promise.all([
    principalFor(request), sessionMember(request), calendarSessionFor(request), GET(request),
  ]);
  assert.equal(reads, 1);
  assert.equal(principal.role, 'viewer');
  assert.equal(limited.id, member.id);
  assert.deepEqual(await apiResponse.json(), bootstrap);
  assert.equal(apiResponse.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(apiResponse.headers.get('Vary'), 'Cookie');
  metrics(apiResponse);
  assert.doesNotMatch(JSON.stringify(bootstrap), /credential|revision|salt|hash/);

  member.role = 'viewer_no_price'; member.propertyIds = ['offland'];
  const restricted = await calendarSessionFor(requestFor(cookie));
  assert.equal(reads, 2);
  assert.equal(restricted.membership.viewPrices, false);
  assert.deepEqual(restricted.membership.propertyIds, ['offland']);
  member.status = 'suspended';
  const revoked = await GET(requestFor(cookie));
  assert.equal(reads, 3);
  assert.equal((await revoked.json()).authenticated, false);
  metrics(revoked);
});

test('owner credential read also supplies password kind, while rotation invalidates the next request', async t => {
  configure(t);
  let current = credential;
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), ['GET', 'sweetfun-os:owner-auth:v1:credential']);
    reads++;
    return Response.json({ result: JSON.stringify(current) });
  });
  const cookie = `${OWNER_COOKIE}=${createOwnerSession(Date.now(), credential.revision)}`;
  const request = requestFor(cookie);
  const [principal, response] = await Promise.all([principalFor(request), GET(request)]);
  assert.equal(reads, 1);
  assert.equal(principal.role, 'owner');
  const data = await response.json();
  assert.equal(data.has_custom_password, true);
  assert.doesNotMatch(JSON.stringify(data), /credential|revision|salt|hash/);
  current = { ...credential, revision: '9'.repeat(64) };
  assert.equal((await calendarSessionFor(requestFor(cookie))).authenticated, false);
  assert.equal(reads, 2);
});

test('password reset and an unavailable auth store remain fail-closed without caching the next request', async t => {
  configure(t);
  const member = { ...memberFixture(), mustResetPassword: true };
  let failed = false;
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    reads++;
    return failed ? new Response('', { status: 503 }) :
      Response.json({ result: JSON.stringify({ version: 1, members: [member] }) });
  });
  const cookie = `${MEMBER_COOKIE}=${createMemberSession(member)}`;
  const limited = await GET(requestFor(cookie));
  assert.deepEqual(await limited.json(), { available: true, authenticated: true,
    requires_password_reset: true, membership: null });
  assert.equal(reads, 1);
  failed = true;
  const failure = await GET(requestFor(cookie));
  assert.equal(failure.status, 503);
  assert.equal(reads, 2);
  metrics(failure);
  failed = false;
  assert.equal((await GET(requestFor(cookie))).status, 200);
  assert.equal(reads, 3);
});

test('an explicitly injected store cannot reuse another store authorization on the same object', async t => {
  configure(t);
  const member = memberFixture();
  const request = requestFor(`${MEMBER_COOKIE}=${createMemberSession(member)}`);
  let allowedReads = 0, deniedReads = 0;
  const allowed = { read: async () => { allowedReads++; return { value: { members: [member] } }; } };
  const denied = { read: async () => { deniedReads++; return { value: { members: [] } }; } };
  const values = await Promise.all([principalFor(request, allowed), sessionMember(request, allowed),
    principalFor(request, denied)]);
  assert.equal(values[0].id, member.id);
  assert.equal(values[1].id, member.id);
  assert.equal(values[2], null);
  assert.equal(allowedReads, 1); assert.equal(deniedReads, 1);
});

test('timing includes failed stages and total completion using only fixed metric names', async () => {
  let now = 100;
  const timing = calendarServerTiming(() => now);
  await timing.measure('auth', async () => { now += 25; });
  await assert.rejects(timing.measure('source', async () => { now += 80; throw Error('private fixture'); }));
  await timing.measure('payment', async () => { now += 15; });
  now += 5;
  const headers = new Headers(); timing.apply(headers);
  assert.equal(headers.get('Server-Timing'), 'auth;dur=25.0, source;dur=80.0, payment;dur=15.0, total;dur=125.0');
  assert.doesNotMatch(headers.get('Server-Timing'), /private fixture/);
});

test('a bounded Sheet payment timeout is measured before response, with no late double counting', async () => {
  const values = [HEADERS, ['301', 'SYNTHETIC_NAME', 'Agoda', '2026-10-01',
    '2026-10-02', '2026-09-01', '2500', 'done', 'OK', 'timing-row', 'SYNTHETIC_NOTE', 'parent']];
  const snapshot = adaptSheetBookings(values, SWEETFUN_SOURCE.sourceId,
    '2026-10-01T00:00:00Z', [], undefined, SWEETFUN_SOURCE.property);
  snapshot.source.sync = { status: 'healthy', last_successful_check_at: '2026-10-01T00:00:00Z' };
  const timing = calendarServerTiming();
  const events = [];
  let finish;
  const result = await timing.measure('source', () => readCalendarSources(
    [SWEETFUN_SOURCE], '2026-10-01', '2026-11-01', true, {
      timeoutMs: 20,
      snapshot: async () => snapshot,
      details: async () => values,
      payments: () => new Promise(resolve => { finish = resolve; }),
      report: event => { timing.recordReadEvent(event); events.push(event); },
    }));
  assert.deepEqual(result.warnings.map(warning => warning.phase), ['payments']);
  assert.equal(result.bookings[0].payment_status, 'unknown');
  const expired = events.find(event => event.phase === 'payments');
  assert.equal(expired.status, 'error');
  assert.equal(expired.code, 'CALENDAR_READ_TIMEOUT');
  assert.ok(expired.duration_ms > 0);
  const response = new Response(); timing.apply(response.headers);
  const before = metrics(response);
  assert.equal(before.payment, expired.duration_ms);
  assert.ok(before.source > 0);
  finish(snapshot.bookings);
  await new Promise(resolve => setTimeout(resolve, 0));
  timing.apply(response.headers);
  assert.equal(metrics(response).payment, before.payment);
  assert.equal(result.bookings[0].payment_status, 'unknown');
});
