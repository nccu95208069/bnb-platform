import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarDeviceCache, CALENDAR_DEVICE_CACHE_TTL } from '../src/lib/calendar-device-cache.ts';

const tick = 1_800_000_000_000;
const member = { id: 'synthetic-owner', tenantId: 'synthetic-workspace', role: 'owner', status: 'active',
  allProperties: true, propertyIds: ['sweetfun', 'offland'] };
const access = now => ({ initialized: true, membership: member, sessionVerifiedAt: now });
const options = { properties: [], viewPrices: true };
const validate = (data, start, end) => data?.period_start === start && data?.period_end === end && Array.isArray(data?.bookings);
const value = (start = '2026-10-01', end = '2026-11-01', bookings = [{ id: 'synthetic-stay', payment_status: 'unpaid' }]) =>
  ({ start, end, data: { period_start: start, period_end: end, bookings } });
function harness() {
  let time = tick;
  let rows = [];
  const store = { async read() { return structuredClone(rows); }, async update(change) { rows = structuredClone(change(rows)); } };
  const cache = createCalendarDeviceCache(store, () => time);
  return { cache, store, get rows() { return rows; }, set rows(value) { rows = value; },
    get now() { return time; }, advance(ms) { time += ms; },
    scope(overrides = {}, settings = {}) { return cache.scope({ ...access(time), ...overrides }, { ...options, ...settings }); } };
}

test('a fresh server-verified session restores a detached snapshot and its original saved time', async () => {
  const h = harness(); const scope = h.scope(); const input = value();
  await h.cache.save(scope, 'bookings', '', input, validate);
  input.data.bookings[0].payment_status = 'paid';
  const reopened = createCalendarDeviceCache(h.store, () => h.now);
  const newScope = reopened.scope(access(h.now), options);
  const rows = await reopened.load(newScope, 'bookings', '', validate);
  assert.equal(rows.length, 1); assert.equal(rows[0].savedAt, tick);
  assert.equal(rows[0].data.bookings[0].payment_status, 'unpaid');
  rows[0].data.bookings.length = 0;
  assert.equal((await reopened.load(newScope, 'bookings', '', validate))[0].data.bookings.length, 1);
});

test('anonymous, unverified, stale, suspended and resetting sessions cannot create a cache scope', () => {
  const h = harness();
  for (const change of [{ membership: null }, { initialized: false }, { sessionVerifiedAt: 0 },
    { sessionVerifiedAt: h.now - 30_000 }, { sessionVerifiedAt: h.now + 1 },
    { sessionLoading: true }, { requiresPasswordReset: true }, { membership: { ...member, status: 'suspended' } }])
    assert.equal(h.scope(change), null);
  assert.equal(h.scope({}, { properties: ['ungranted-property'] }), null);
});

test('account, tenant, role, effective role, price permission and property queries are exact boundaries', async () => {
  const h = harness();
  await h.cache.save(h.scope(), 'bookings', '', value(), validate);
  for (const changedMember of [{ ...member, id: 'another-member' }, { ...member, tenantId: 'another-tenant' },
    { ...member, role: 'viewer_no_price' }, { ...member, allProperties: false }, { ...member, allProperties: false, propertyIds: ['offland'] }])
    assert.deepEqual(await h.cache.load(h.scope({ membership: changedMember }), 'bookings', '', validate), []);
  for (const settings of [{ effectiveRole: 'viewer' }, { viewPrices: false }, { properties: ['offland'] }])
    assert.deepEqual(await h.cache.load(h.scope({}, settings), 'bookings', '', validate), []);
  assert.equal((await h.cache.load(h.scope({ membership: { ...member, propertyIds: ['offland', 'sweetfun'] } }), 'bookings', '', validate)).length, 1);
  assert.equal((await h.cache.load(h.scope({ membership: { ...member, propertyIds: [] } }), 'bookings', '', validate)).length, 1);
  assert.deepEqual(await h.cache.load(h.scope(), 'availability', '', validate), []);
  assert.deepEqual(await h.cache.load(h.scope(), 'bookings', 'other-filter', validate), []);
});

test('fresh read replaces changed names, payments, cancellations and deletions even without an inventory version change', async () => {
  const h = harness(); const scope = h.scope();
  const before = value(); before.data.version = 9;
  await h.cache.save(scope, 'bookings', '', before, validate);
  h.advance(500);
  const after = value('2026-10-01', '2026-11-01', [{ id: 'different-stay', guest_name: 'Synthetic', payment_status: 'paid', reservation_status: 'cancelled' }]);
  after.data.version = 9;
  await h.cache.save(scope, 'bookings', '', after, validate);
  const loaded = await h.cache.load(scope, 'bookings', '', validate);
  assert.equal(loaded.length, 1); assert.deepEqual(loaded[0].data, after.data);
  assert.equal(loaded[0].savedAt, h.now);
  await h.cache.save(scope, 'bookings', '', value('2026-10-01', '2026-11-01', []), validate);
  assert.deepEqual((await h.cache.load(scope, 'bookings', '', validate))[0].data.bookings, []);
});

test('expired, future, mismatched-schema, malformed and invalid payloads are never restored', async () => {
  const h = harness(); const scope = h.scope();
  await h.cache.save(scope, 'bookings', '', value(), validate);
  const original = structuredClone(h.rows[0]);
  for (const change of [{ savedAt: h.now - CALENDAR_DEVICE_CACHE_TTL }, { savedAt: h.now + 1 },
    { schema: 2 }, { start: '2026-02-30' }, { data: { bookings: 'invalid' } }, { id: 'wrong-key' }]) {
    h.rows = [{ ...original, ...change }];
    assert.deepEqual(await h.cache.load(scope, 'bookings', '', validate), []);
  }
  h.rows = [original]; h.advance(CALENDAR_DEVICE_CACHE_TTL);
  assert.deepEqual(await h.cache.load(h.scope(), 'bookings', '', validate), []);
});

test('cache retains at most seven windows and bounds multi-month coverage', async () => {
  const h = harness(); const scope = h.scope();
  for (let day = 1; day <= 10; day++) {
    const start = `2026-10-${String(day).padStart(2, '0')}`, end = `2026-10-${String(day + 1).padStart(2, '0')}`;
    await h.cache.save(scope, 'bookings', '', value(start, end), validate); h.advance(10);
  }
  assert.equal((await h.cache.load(scope, 'bookings', '', validate)).length, 7);
  await h.cache.save(scope, 'bookings', '', value('2027-09-01', '2027-11-01'), validate);
  const rows = await h.cache.load(scope, 'bookings', '', validate);
  assert.equal(rows.length, 1); assert.equal(rows[0].start, '2027-09-01');
});

test('logout rejects an in-flight restore and a queued save, then removes all existing rows', async () => {
  const h = harness(); const scope = h.scope();
  await h.cache.save(scope, 'bookings', '', value(), validate);
  const savedRead = h.store.read;
  let completeRead;
  h.store.read = () => new Promise(resolve => { completeRead = resolve; });
  const loading = h.cache.load(scope, 'bookings', '', validate);
  const savedUpdate = h.store.update;
  let releaseWrite;
  h.store.update = change => new Promise(resolve => { releaseWrite = async () => { await savedUpdate(change); resolve(); }; });
  const saving = h.cache.save(scope, 'bookings', '', value('2026-11-01', '2026-12-01'), validate);
  h.store.update = savedUpdate;
  const oldRows = structuredClone(h.rows);
  await h.cache.clear();
  completeRead(oldRows); await releaseWrite(); await saving;
  assert.deepEqual(await loading, []); assert.deepEqual(h.rows, []);
  h.store.read = savedRead;
  await h.cache.save(scope, 'bookings', '', value(), validate);
  assert.deepEqual(h.rows, []);
  h.advance(1);
  await h.cache.save(h.scope(), 'bookings', '', value(), validate);
  assert.equal(h.rows.length, 1);
});

test('storage rejection, quota errors, cyclic payloads and oversized data do not break the network calendar', async () => {
  const h = harness(); const scope = h.scope();
  h.store.read = async () => { throw Error('Synthetic unavailable storage'); };
  h.store.update = async () => { throw Error('Synthetic quota exceeded'); };
  assert.deepEqual(await h.cache.load(scope, 'bookings', '', validate), []);
  await assert.doesNotReject(h.cache.save(scope, 'bookings', '', value(), validate));
  const cycle = value(); cycle.data.cycle = cycle;
  await assert.doesNotReject(h.cache.save(scope, 'bookings', '', cycle, validate));
  const clean = harness(); const oversized = value(); oversized.data.padding = 'x'.repeat(2_000_000);
  await clean.cache.save(clean.scope(), 'bookings', '', oversized, validate);
  assert.deepEqual(clean.rows, []);
});
