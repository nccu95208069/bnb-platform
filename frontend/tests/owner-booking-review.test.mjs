import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { websiteFixture, memoryStore } from './helpers/website-booking-fixture.mjs';
import { localRedis } from './helpers/redis-command.mjs';
import { RedisCustomerStore } from '../src/lib/customer-workspaces/store.ts';
import { accountKey, sessionFor } from '../src/lib/customer-workspaces/auth.ts';
import { newPasswordlessCredential } from '../src/lib/customer-workspaces/identity.ts';
import { financeSummary } from '../src/lib/customer-workspaces/domain.ts';
import { customerCalendarProjection } from '../src/lib/customer-workspaces/calendar-parity.ts';

// CI runs every scenario with real Redis/Lua as well as the isolated memory
// store. A local run without a Redis port is explicitly labelled memory-only.
const namespace = 'synthetic:owner-review:' + randomUUID();
process.env.CUSTOMER_WORKSPACE_NAMESPACE = namespace;
process.env.UPSTASH_REDIS_REST_URL = 'https://owner-review-redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic-owner-review-token';
const Operations = await import('../src/app/api/customer-workspaces/[slug]/operations/route.ts');
const origin = 'https://owner-review.example.invalid';
const modes = process.env.CALENDAR_TEST_REDIS_PORT ? ['memory', 'redis'] : ['memory'];

async function fixture(t, mode) {
  const store = mode === 'redis' ? new RedisCustomerStore() : memoryStore();
  if (mode === 'memory') {
    for (const method of ['read', 'commit', 'limit'])
      t.mock.method(RedisCustomerStore.prototype, method, (...args) => store[method](...args));
    t.mock.method(globalThis, 'fetch', async () => { throw Error('External network prohibited'); });
  } else {
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      assert.equal(String(url), 'https://owner-review-redis.invalid');
      return Response.json({ result: await localRedis(JSON.parse(init.body)) });
    });
    t.after(async () => {
      const keys = await localRedis(['KEYS', namespace + ':*']);
      if (keys.length) await localRedis(['DEL', ...keys]);
    });
  }
  const f = await websiteFixture({ store });
  const reservation = await f.reserve();
  const orderId = reservation.result.orderId;
  const path = '/api/customer-workspaces/' + f.binding.slug + '/operations';
  const context = { params: Promise.resolve({ slug: f.binding.slug }) };
  const cookie = 'bnb_customer_session=' + sessionFor(f.account);
  const command = async fields => {
    const w = await f.workspace(), b = w.bookings.find(b => b.id === orderId);
    return { bookingId: b.id, bookingVersion: b.version, version: w.version, requestKey: randomUUID(), ...fields };
  };
  const post = (input, options = {}) => Operations.POST(new NextRequest(origin + path, {
    method: 'POST', headers: { origin, 'content-type': 'application/json', cookie, ...options.headers },
    body: JSON.stringify(input),
  }), context);
  const get = (query, memberCookie = cookie) => Operations.GET(new NextRequest(origin + path + query, {
    headers: { cookie: memberCookie },
  }), context);
  const mutate = async edit => {
    const key = 'workspace:' + f.binding.workspaceId, snapshot = await store.read(key);
    edit(snapshot.value); snapshot.value.version++;
    await store.commit([{ key, before: snapshot.raw, after: snapshot.value }]);
  };
  const member = async (role, propertyIds = [f.binding.propertyId], active = true) => {
    const account = { id: randomUUID(), email: randomUUID() + '@example.invalid', credential: newPasswordlessCredential(), workspaces: [] };
    await store.commit([{ key: accountKey(account.email), before: null, after: account }]);
    await mutate(w => w.members.push({ accountId: account.id, role, allProperties: false, propertyIds, active }));
    return { account, cookie: 'bnb_customer_session=' + sessionFor(account) };
  };
  const payment = { amount: 500, method: 'cash', receivedAt: new Date(Date.now() - 1000).toISOString(), confirmedReceipt: true, confirmPlatformOnly: true };
  const available = async () => (await f.call('availability', f.stay)).options.find(o => o.roomTypeId === f.stay.roomTypeId).availableUnits;
  return { ...f, orderId, reservation, command, post, get, mutate, member, payment, available };
}

async function success(response) {
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
async function rejected(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal((await response.json()).code, code);
}

for (const mode of modes) {
  test(`owner review (${mode}): current roles, property scope and revoked membership govern account creation and replay`, async t => {
    const f = await fixture(t, mode);
    const fields = { action: 'receipt-account', propertyId: f.binding.propertyId, name: 'Synthetic account', last4: '0000' };
    const members = [];
    for (const role of ['housekeeper', 'viewer', 'viewer_no_price']) members.push({ ...await f.member(role), role, status: 403, code: 'FORBIDDEN' });
    members.push({ ...await f.member('admin', []), status: 404, code: 'NOT_FOUND' });
    members.push({ ...await f.member('admin', [f.binding.propertyId], false), status: 404, code: 'NOT_FOUND' });
    const admin = await f.member('admin');
    const input = await f.command(fields), before = await f.workspace();
    await rejected(await f.post(input, { headers: { cookie: '' } }), 401, 'UNAUTHORIZED');
    await rejected(await f.post(input, { headers: { origin: 'https://other.example.invalid' } }), 403, 'FORBIDDEN');
    for (const m of members) {
      for (const fields of [input, { ...input, action: 'hold-convert', ...f.payment }, { ...input, action: 'hold-release', confirmPlatformOnly: true }])
        await rejected(await f.post(fields, { headers: { cookie: m.cookie } }), m.status, m.code);
    }
    assert.deepEqual(await f.workspace(), before);
    const saved = await success(await f.post(input, { headers: { cookie: admin.cookie } }));
    assert.equal(saved.workspace.properties[0].receiptAccounts.length, 1);
    const hidden = await success(await f.get('?view=calendar&property=' + f.binding.propertyId + '&month=' + f.stay.checkIn.slice(0, 7), members.find(m => m.role === 'viewer_no_price').cookie));
    assert.equal(hidden.properties[0].receiptAccounts, undefined);
    assert.equal(hidden.bookings[0].total, null);
    assert.deepEqual(hidden.bookings[0].payments, []);
    const hiddenCalendar = customerCalendarProjection(hidden, hidden.properties[0]);
    assert.ok(hiddenCalendar.bookings.every(b => b.price_hidden && b.payment_status === 'unknown'));
    await f.mutate(w => { w.members.find(m => m.accountId === admin.account.id).propertyIds = []; });
    await rejected(await f.post(input, { headers: { cookie: admin.cookie } }), 404, 'NOT_FOUND');
    await f.mutate(w => { const m = w.members.find(m => m.accountId === admin.account.id); m.propertyIds = [f.binding.propertyId]; m.role = 'viewer'; });
    await rejected(await f.post(input, { headers: { cookie: admin.cookie } }), 403, 'FORBIDDEN');
    await f.mutate(w => { const m = w.members.find(m => m.accountId === admin.account.id); m.role = 'admin'; m.active = false; });
    await rejected(await f.post(input, { headers: { cookie: admin.cookie } }), 404, 'NOT_FOUND');
    const final = await f.workspace();
    assert.equal(final.properties[0].receiptAccounts.length, 1);
    assert.equal(final.bookings[0].payments.length, 0);
    assert.equal(final.bookings[0].status, 'held');
  });

  test(`owner review (${mode}): concurrent account creation and bank deposit retries produce one account and one receipt`, async t => {
    const f = await fixture(t, mode);
    const input = await f.command({ action: 'receipt-account', propertyId: f.binding.propertyId, name: 'Synthetic account', last4: '0000' });
    const results = await Promise.all([f.post(input), f.post(input)]);
    assert.ok(results.some(r => r.status === 200));
    assert.ok(results.every(r => [200, 409].includes(r.status)));
    const account = await success(await f.post(input));
    assert.equal(account.workspace.properties[0].receiptAccounts.length, 1);
    assert.equal(account.workspace.bookings[0].status, 'held');
    assert.equal(account.workspace.bookings[0].payments.length, 0);
    await rejected(await f.post({ ...input, last4: '0001' }), 409, 'IDEMPOTENCY_CONFLICT');
    await rejected(await f.post(await f.command({ ...input, requestKey: randomUUID(), version: (await f.workspace()).version })), 409, 'ACCOUNT_DUPLICATE');
    const converted = await f.command({ action: 'hold-convert', ...f.payment, method: 'bank', receiptAccountId: account.targetId });
    await rejected(await f.post({ ...converted, receiptAccountId: 'outside-property-account' }), 404, 'NOT_FOUND');
    const conversions = await Promise.all([f.post(converted), f.post(converted)]);
    assert.ok(conversions.some(r => r.status === 200));
    assert.ok(conversions.every(r => [200, 409].includes(r.status)));
    await success(await f.post(converted));
    await rejected(await f.post({ ...converted, requestKey: randomUUID() }), 409, 'VERSION_CONFLICT');
    await rejected(await f.post(await f.command({ action: 'hold-convert', ...f.payment })), 409, 'HOLD_STATE_CONFLICT');
    const w = await f.workspace(), b = w.bookings[0];
    assert.equal(w.bookings.length, 1); assert.equal(b.id, f.orderId); assert.equal(b.status, 'confirmed');
    assert.equal(b.payments.length, 1); assert.equal(b.payments[0].receiptAccount.id, account.targetId);
    assert.equal(financeSummary(b).received, 500); assert.equal(await f.available(), 0);
  });

  test(`owner review (${mode}): parallel balance/refund writes, retry and restricted finance roles preserve the ledger`, async t => {
    const f = await fixture(t, mode);
    await success(await f.post(await f.command({ action: 'hold-convert', ...f.payment })));
    const cleaner = await f.member('housekeeper'), viewer = await f.member('viewer');
    const refund = await f.command({ action: 'payment', kind: 'refund', amount: 500, receivedAt: f.payment.receivedAt });
    await rejected(await f.post(refund, { headers: { cookie: cleaner.cookie } }), 403, 'FORBIDDEN');
    await rejected(await f.post(refund, { headers: { cookie: viewer.cookie } }), 403, 'FORBIDDEN');
    await rejected(await f.post(await f.command({ action: 'cancel', confirmed: true }), { headers: { cookie: cleaner.cookie } }), 403, 'FORBIDDEN');
    const balance = await f.command({ action: 'payment', kind: 'balance', amount: 500, receivedAt: f.payment.receivedAt });
    // Housekeepers may record ordinary receipts in their granted property.
    await success(await f.post(balance, { headers: { cookie: cleaner.cookie } }));
    await success(await f.post(balance, { headers: { cookie: cleaner.cookie } }));
    const parallel = await f.command({ action: 'payment', kind: 'balance', amount: 250, receivedAt: f.payment.receivedAt });
    const attempts = [parallel, { ...parallel, requestKey: randomUUID() }];
    const responses = await Promise.all(attempts.map(input => f.post(input)));
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    await success(await f.post(attempts[responses.findIndex(r => r.status === 200)]));
    await rejected(await f.post(attempts[responses.findIndex(r => r.status === 409)]), 409, 'VERSION_CONFLICT');
    assert.equal(financeSummary((await f.workspace()).bookings[0]).received, 1250);
    const fullRefund = await f.command({ action: 'payment', kind: 'refund', amount: 1250, receivedAt: f.payment.receivedAt });
    await rejected(await f.post({ ...fullRefund, amount: 1251 }), 400, 'REFUND_TOO_LARGE');
    const refunds = await Promise.all([f.post(fullRefund), f.post(fullRefund)]);
    assert.ok(refunds.some(r => r.status === 200));
    assert.ok(refunds.every(r => [200, 409].includes(r.status)));
    await success(await f.post(fullRefund));
    const b = (await f.workspace()).bookings[0];
    assert.deepEqual(b.payments.map(p => p.amount), [500, 500, 250, 1250]);
    assert.equal(financeSummary(b).received, 0); assert.equal(b.status, 'confirmed');
    assert.equal(await f.available(), 0);
  });

  test(`owner review (${mode}): settled cancellation releases only its order; old retries retain replacement holds and blocks`, async t => {
    const f = await fixture(t, mode);
    await success(await f.post(await f.command({ action: 'hold-convert', ...f.payment })));
    await rejected(await f.post(await f.command({ action: 'cancel', confirmed: true })), 409, 'CANCELLATION_REQUIRES_SETTLEMENT');
    assert.equal(await f.available(), 0);
    await success(await f.post(await f.command({ action: 'payment', kind: 'refund', amount: 500, receivedAt: f.payment.receivedAt })));
    await rejected(await f.post(await f.command({ action: 'cancel' })), 400, 'BOOKING_CANCELLATION_CONFIRMATION_REQUIRED');
    const cancel = await f.command({ action: 'cancel', confirmed: true });
    await success(await f.post(cancel)); await success(await f.post(cancel));
    assert.equal(await f.available(), 1);
    let calendar = await success(await f.get('?view=calendar&property=' + f.binding.propertyId + '&month=' + f.stay.checkIn.slice(0, 7)));
    assert.equal(calendar.bookings.find(b => b.id === f.orderId).status, 'cancelled');
    assert.equal(customerCalendarProjection(calendar, calendar.properties[0]).bookings.length, 0);
    const block = { id: randomUUID(), propertyId: f.binding.propertyId, roomIds: (await f.workspace()).bookings[0].roomIds,
      checkIn: f.stay.checkIn, checkOut: f.stay.checkOut, status: 'active', reason: 'Synthetic maintenance' };
    await f.mutate(w => { w.blocks = [block]; });
    await success(await f.post(cancel));
    assert.equal(await f.available(), 0); assert.deepEqual((await f.workspace()).blocks, [block]);
    await f.mutate(w => { w.blocks = [{ ...block, status: 'cancelled' }]; });
    const replacement = await f.reserve();
    await success(await f.post(cancel));
    assert.equal(await f.available(), 0);
    calendar = await success(await f.get('?view=calendar&property=' + f.binding.propertyId + '&month=' + f.stay.checkIn.slice(0, 7)));
    const projected = customerCalendarProjection(calendar, calendar.properties[0]).bookings;
    assert.equal(projected.length, 1);
    assert.ok(projected.every(b => b.order_id === replacement.result.orderId && b.reservation_status === 'held'));
    const historical = await success(await f.get('?view=orders&status=cancelled'));
    assert.deepEqual(historical.bookings.map(b => b.id), [f.orderId]);
    const lookup = await f.call('requests', { idempotencyKey: f.reservation.input.idempotencyKey });
    assert.equal(lookup.status, 'released'); assert.equal(lookup.payment.receivedCents, 0); assert.equal(lookup.payment.refundedCents, 50000);
  });

  test(`owner review (${mode}): simultaneous deposit and hold release cannot both collect and reopen inventory`, async t => {
    const f = await fixture(t, mode);
    const convert = await f.command({ action: 'hold-convert', ...f.payment });
    const release = { ...convert, action: 'hold-release', requestKey: randomUUID() };
    const responses = await Promise.all([f.post(convert), f.post(release)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    const b = (await f.workspace()).bookings[0];
    if (b.status === 'cancelled') {
      assert.equal(b.payments.length, 0); assert.equal(await f.available(), 1);
      await success(await f.post(release));
      const replacement = await f.reserve();
      await rejected(await f.post(convert), 409, 'VERSION_CONFLICT');
      assert.equal((await f.workspace()).bookings.find(b => b.id === replacement.result.orderId).status, 'held');
      assert.equal(await f.available(), 0);
      return;
    }
    assert.equal(b.status, 'confirmed'); assert.equal(b.payments.length, 1); assert.equal(await f.available(), 0);
    await success(await f.post(convert));
    assert.equal((await f.workspace()).bookings[0].payments.length, 1);
  });

  test(`owner review (${mode}): simultaneous payment and settled cancellation cannot both collect and reopen inventory`, async t => {
    const f = await fixture(t, mode);
    await success(await f.post(await f.command({ action: 'hold-convert', ...f.payment })));
    await success(await f.post(await f.command({ action: 'payment', kind: 'refund', amount: 500, receivedAt: f.payment.receivedAt })));
    const cancel = await f.command({ action: 'cancel', confirmed: true });
    const deposit = { ...cancel, action: 'payment', kind: 'deposit', amount: 500, receivedAt: f.payment.receivedAt, requestKey: randomUUID() };
    const settled = await Promise.all([f.post(cancel), f.post(deposit)]);
    assert.deepEqual(settled.map(r => r.status).sort(), [200, 409]);
    const b = (await f.workspace()).bookings[0];
    if (b.status === 'cancelled') {
      assert.equal(financeSummary(b).received, 0); assert.equal(b.payments.length, 2); assert.equal(await f.available(), 1);
    } else {
      assert.equal(financeSummary(b).received, 500); assert.equal(b.payments.length, 3); assert.equal(await f.available(), 0);
      await rejected(await f.post(await f.command({ action: 'cancel', confirmed: true })), 409, 'CANCELLATION_REQUIRES_SETTLEMENT');
    }
  });
}
