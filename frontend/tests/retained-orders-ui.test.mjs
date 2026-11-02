import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { JSDOM } from 'jsdom';
import { mount } from './helpers/customer-dom.mjs';
import { readPendingRetainedOrder, savePendingRetainedOrder, clearPendingRetainedOrder } from '../src/components/calendar/retained-order-pending.ts';

const bootstrap = new JSDOM('<body></body>');
globalThis.window = bootstrap.window;
globalThis.document = bootstrap.window.document;
const { RetainedBookingDialog } = await import('../src/components/calendar/retained-booking-dialog.tsx');
const { RetainedOrdersControl } = await import('../src/components/calendar/retained-orders-control.tsx');
const bookingId = '11111111-1111-4111-8111-111111111111';
const originalStays = [{ checkIn: '2026-10-02', checkOut: '2026-10-04', roomNumbers: ['包棟'] },
  { checkIn: '2026-10-10', checkOut: '2026-10-11', roomNumbers: ['包棟'] }];
const detail = { bookingId, version: 3, status: 'confirmed', guestName: 'Synthetic Retained Guest',
  contact: 'synthetic@example.test', externalOrderNo: 'SYNTH-1001', sourceOrderRef: null,
  totalCents: 900000, originalTotalCents: 900000, stays: originalStays, originalStays,
  netReceivedCents: 200000, retainedAmountReviewRequired: false, priceHidden: false,
  channelSyncState: 'action_required', externalRoomActionRequired: true, sourceReviewRequired: false,
  retentionEligible: true, rescheduleEligible: false, retention: null, retainedAt: null, reason: null };
const preview = { bookingId, bookingVersion: 3, inventoryVersion: 80, authorityEpoch: 1,
  status: 'confirmed', previousStays: originalStays, proposedStays: [],
  channelSyncState: 'action_required', externalRoomActionRequired: true, netReceivedCents: 200000,
  retainedAmountReviewRequired: false, remainingCents: null, creditCents: null };
const props = { bookingId, action: 'retain', storageScope: 'test-owner', canWrite: true,
  viewPrices: true, onClose: () => {}, onVerified: () => {} };
const command = { reason: '旅客改期，新日期未定', expectedBookingVersion: 3, expectedInventoryVersion: 80 };
const applied = (key, status = 'retained') => ({ outcome: 'applied', requestKey: key, bookingId,
  bookingVersion: 4, currentBookingVersion: 4, currentStatus: status, channelSyncState: 'action_required',
  inventoryVersion: 81, readbackVerified: true });
const pause = ms => act(() => new Promise(resolve => setTimeout(resolve, ms)));
const byLabel = label => document.querySelector(`[aria-label="${label}"]`);
const retainedDetail = { ...detail, status: 'retained', totalCents: null, stays: [],
  retentionEligible: false, rescheduleEligible: true, retainedAt: '2026-10-29T01:00:00Z', reason: 'Synthetic change' };

test('retain previews every original stay and preserves money by submitting only intent and checked versions', async t => {
  const writes = [];
  let verified = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (!options.method) return Response.json(detail);
    if (String(url).endsWith('/retain-preview')) return Response.json(preview);
    writes.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json(applied(options.headers['Idempotency-Key']));
  });
  const ui = await mount(t, RetainedBookingDialog, { ...props, onVerified: () => verified++ });
  assert.match(document.body.textContent, /2026-10-02.*2026-10-04/);
  assert.match(document.body.textContent, /2026-10-10.*2026-10-11/);
  assert.match(document.body.textContent, /已確認保留款：NT\$ 2,000/);
  assert.equal(writes.length, 0);
  await ui.click(ui.button('預覽保留訂單'));
  assert.match(document.body.textContent, /外部平台尚未確認開放/);
  assert.equal(writes.length, 0);
  await ui.click(ui.button('確認轉為保留訂單'));
  assert.deepEqual(writes, [{ url: `/api/v1/bookings/retained/${bookingId}/retain`, body: {
    reason: '旅客改期，新日期未定', expectedBookingVersion: 3, expectedInventoryVersion: 80 } }]);
  assert.equal(verified, 1);
  assert.equal(readPendingRetainedOrder(window.localStorage, props.storageScope), null);
  assert.match(document.body.textContent, /原 OS 房晚已釋放/);
  assert.match(document.body.textContent, /外部房況：待人工處理/);
});

test('unknown receipt stays unknown in retain confirmation and is never rendered as zero', async t => {
  t.mock.method(globalThis, 'fetch', async (url) => Response.json(String(url).endsWith('/retain-preview')
    ? { ...preview, netReceivedCents: null, retainedAmountReviewRequired: true }
    : { ...detail, netReceivedCents: null, retainedAmountReviewRequired: true }));
  const ui = await mount(t, RetainedBookingDialog, props);
  await ui.click(ui.button('預覽保留訂單'));
  assert.match(document.body.textContent, /原款項紀錄保留，金額待核對/);
  assert.doesNotMatch(document.body.textContent, /NT\$ 0|已確認保留款/);
});

test('reschedule starts without dates, previews exact nights and invalidates preview when prices change', async t => {
  const checks = [], writes = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (!options.method) return Response.json(retainedDetail);
    const body = JSON.parse(options.body);
    if (String(url).endsWith('/reschedule-preview')) {
      checks.push(body); return Response.json({ ...preview, proposedStays: body.stays, remainingCents: 0, creditCents: 50000 });
    }
    writes.push(body); return Response.json(applied(options.headers['Idempotency-Key'], 'confirmed'));
  });
  const ui = await mount(t, RetainedBookingDialog, { ...props, action: 'reschedule' });
  assert.equal(byLabel('第 1 段入住日期').value, '');
  await ui.fill(byLabel('第 1 段入住日期'), '2026-12-01');
  await ui.fill(byLabel('第 1 段退房日期'), '2026-12-03');
  await ui.fill(byLabel('2026-12-01 房費'), '700');
  await ui.fill(byLabel('2026-12-02 房費'), '800');
  await ui.click(ui.button('檢查房況與差額'));
  assert.match(document.body.textContent, /差額待處理；本次不會退款/);
  await ui.fill(byLabel('2026-12-02 房費'), '900');
  assert.equal(ui.button('確認安排入住'), undefined);
  await ui.click(ui.button('檢查房況與差額'));
  await ui.click(ui.button('確認安排入住'));
  assert.equal(checks.length, 2); assert.equal(writes.length, 1);
  assert.equal(writes[0].totalCents, 160000);
  assert.deepEqual(writes[0].stays, [{ checkIn: '2026-12-01', checkOut: '2026-12-03', roomNumbers: ['包棟'] }]);
  assert.deepEqual(writes[0].roomNightPrices, [{ roomNumber: '包棟', date: '2026-12-01', amountCents: 70000 },
    { roomNumber: '包棟', date: '2026-12-02', amountCents: 90000 }]);
  assert.equal(writes[0].expectedBookingVersion, 3);
  assert.match(document.body.textContent, /目前已確認安排入住/);
});

test('conflicting reschedule leaves retained order intact and requires another check', async t => {
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (!options.method) return Response.json(retainedDetail);
    if (String(url).endsWith('/reschedule-preview')) return Response.json({ code: 'ROOM_CONFLICT' }, { status: 409 });
    writes++; throw Error('unexpected write');
  });
  const ui = await mount(t, RetainedBookingDialog, { ...props, action: 'reschedule' });
  await ui.fill(byLabel('第 1 段入住日期'), '2026-12-01');
  await ui.fill(byLabel('第 1 段退房日期'), '2026-12-02');
  await ui.fill(byLabel('2026-12-01 房費'), '700');
  await ui.click(ui.button('檢查房況與差額'));
  assert.equal(writes, 0);
  assert.match(document.body.textContent, /保留訂單尚未變動/);
  assert.equal(ui.button('確認安排入住'), undefined);
});

test('an uncertain write recovers the exact command automatically without a second write', async t => {
  let writes = 0, reads = 0, key, verified = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).includes('/requests/')) { reads++; assert.ok(String(url).endsWith(key)); return Response.json(applied(key)); }
    if (!options.method) return Response.json(detail);
    if (String(url).endsWith('/retain-preview')) return Response.json(preview);
    writes++; key = options.headers['Idempotency-Key'];
    return Response.json({ outcome: 'unknown', request_key: key }, { status: 202 });
  });
  const ui = await mount(t, RetainedBookingDialog, { ...props, onVerified: () => verified++ });
  await ui.click(ui.button('預覽保留訂單')); await ui.click(ui.button('確認轉為保留訂單'));
  await pause(40);
  assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(verified, 1);
  assert.equal(readPendingRetainedOrder(window.localStorage, props.storageScope), null);
  assert.match(document.body.textContent, /已轉為保留訂單/);
});

test('reopening checks a stored operation and keeps its identity when readback is unavailable', async t => {
  let reads = 0;
  const pending = { schema: 1, requestKey: '22222222-2222-4222-8222-222222222222', bookingId, action: 'retain', createdAt: 1, payload: command };
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    assert.ok(!options.method);
    if (String(url).includes('/requests/')) { reads++; return Response.json({ code: 'UNAVAILABLE' }, { status: 503 }); }
    if (String(url).includes('?')) return Response.json({ bookings: [], canWrite: true, priceHidden: false, verifiedAt: '2026-10-29T01:00:00Z', inventoryVersion: 80 });
    return Response.json(detail);
  });
  const ui = await mount(t, () => null);
  savePendingRetainedOrder(window.localStorage, props.storageScope, pending);
  await pause(10);
  await act(() => ui.root.render(createElement(RetainedOrdersControl, { canWrite: true, viewPrices: true,
    storageScope: props.storageScope, reload: 0, target: null, onTargetHandled() {}, onChanged() {} })));
  await pause(40);
  assert.equal(reads, 1);
  assert.deepEqual(readPendingRetainedOrder(window.localStorage, props.storageScope), pending);
  assert.match(document.body.textContent, /正在確認這次操作/);
  assert.equal(ui.button('預覽保留訂單'), undefined);
});

test('a failed browser persistence check prevents a write after preview', async t => {
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (!options.method) return Response.json(detail);
    if (String(url).endsWith('/retain-preview')) return Response.json(preview);
    writes++; return Response.json({});
  });
  const ui = await mount(t, RetainedBookingDialog, props);
  t.mock.method(ui.dom.window.Storage.prototype, 'setItem', () => { throw Error('storage blocked'); });
  await ui.click(ui.button('預覽保留訂單')); await ui.click(ui.button('確認轉為保留訂單'));
  assert.equal(writes, 0);
  assert.match(document.body.textContent, /無法安全保存這次操作/);
});

test('server price hiding removes amounts and all reschedule inputs even when local permissions are stale', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...retainedDetail, priceHidden: true }));
  const ui = await mount(t, RetainedBookingDialog, { ...props, action: 'reschedule' });
  assert.match(document.body.textContent, /款項金額已隱藏/);
  assert.doesNotMatch(document.body.textContent, /NT\$|2,000/);
  assert.equal(byLabel('第 1 段入住日期'), null);
  assert.equal(ui.button('檢查房況與差額'), undefined);
});

test('cross-month retained list has no date query and searches the order identity', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(String(url));
    return Response.json({ bookings: [retainedDetail, { ...retainedDetail,
      bookingId: '33333333-3333-4333-8333-333333333333', guestName: 'Another Synthetic Guest', externalOrderNo: 'SYNTH-2002',
      originalStays: [{ checkIn: '2027-05-01', checkOut: '2027-05-02', roomNumbers: ['包棟'] }] }],
      canWrite: false, priceHidden: false, verifiedAt: '2026-10-29T01:00:00Z', inventoryVersion: 80 });
  });
  const ui = await mount(t, RetainedOrdersControl, { canWrite: true, viewPrices: true, storageScope: props.storageScope,
    reload: 0, target: null, onTargetHandled() {}, onChanged() {} });
  await ui.click(ui.button('遺忘無際待改期 · 2'));
  assert.match(document.body.textContent, /2026-10-02/);
  assert.match(document.body.textContent, /2027-05-01/);
  assert.equal(ui.button('安排入住'), undefined);
  await ui.fill(byLabel('搜尋保留訂單'), 'SYNTH-2002');
  assert.doesNotMatch(document.body.textContent, /Synthetic Retained Guest/);
  assert.match(document.body.textContent, /Another Synthetic Guest/);
  assert.ok(urls.every(url => url === '/api/v1/bookings/retained?property=offland'));
});

test('pending identity is scoped and another command cannot replace or clear it', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const request = { schema: 1, requestKey: '22222222-2222-4222-8222-222222222222', bookingId, action: 'retain', createdAt: 1, payload: command };
  savePendingRetainedOrder(storage, 'owner-one', request);
  assert.equal(readPendingRetainedOrder(storage, 'owner-two'), null);
  assert.throws(() => savePendingRetainedOrder(storage, 'owner-one', { ...request, requestKey: bookingId }), /PENDING_REQUEST_EXISTS/);
  clearPendingRetainedOrder(storage, 'owner-one', bookingId);
  assert.deepEqual(readPendingRetainedOrder(storage, 'owner-one'), request);
});

test('a request that never reached the server survives reload and resends the exact command with its original key', async t => {
  const attempts = [];
  let accepted = false;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).includes('/requests/')) return accepted ? Response.json(applied(attempts[0].key)) : Response.json({ code: 'REQUEST_NOT_FOUND' }, { status: 404 });
    if (String(url).includes('?')) return Response.json({ bookings: [], canWrite: true, priceHidden: false, verifiedAt: '2026-10-29T01:00:00Z', inventoryVersion: 80 });
    if (!options.method) return Response.json(detail);
    if (String(url).endsWith('/retain-preview')) return Response.json(preview);
    attempts.push({ key: options.headers['Idempotency-Key'], payload: JSON.parse(options.body) });
    if (attempts.length === 1) throw Error('request did not reach server');
    accepted = true; return Response.json(applied(attempts[0].key));
  });
  const ui = await mount(t, RetainedBookingDialog, props);
  await ui.click(ui.button('預覽保留訂單')); await ui.click(ui.button('確認轉為保留訂單'));
  const stored = readPendingRetainedOrder(window.localStorage, props.storageScope);
  assert.deepEqual(stored.payload, command);
  await act(() => ui.root.render(null));
  await pause(10);
  await act(() => ui.root.render(createElement(RetainedOrdersControl, { canWrite: true, viewPrices: true,
    storageScope: props.storageScope, reload: 0, target: null, onTargetHandled() {}, onChanged() {} })));
  await pause(30); await pause(1300); await pause(2500);
  assert.deepEqual(readPendingRetainedOrder(window.localStorage, props.storageScope), stored);
  await ui.click(ui.button('重送原操作並確認'));
  await pause(10);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(readPendingRetainedOrder(window.localStorage, props.storageScope), null);
  assert.match(document.body.textContent, /已轉為保留訂單/);
});

test('an unintegrated external provider never appears as no synchronization needed', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...detail, channelSyncState: 'not_required', externalRoomStatus: 'not_integrated' }));
  await mount(t, RetainedBookingDialog, props);
  assert.match(document.body.textContent, /外部房況：尚未串接，請另行確認/);
  assert.doesNotMatch(document.body.textContent, /外部房況：無需同步/);
});

test('an authoritative non-application receipt unlocks a new preview without pretending the booking changed', async t => {
  const pending = { schema: 1, requestKey: '22222222-2222-4222-8222-222222222222', bookingId, action: 'retain', createdAt: 1, payload: command };
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    assert.ok(!options.method);
    return Response.json(String(url).includes('/requests/') ? { ...applied(pending.requestKey, 'confirmed'), outcome: 'not_applied' } : detail);
  });
  const ui = await mount(t, () => null);
  savePendingRetainedOrder(window.localStorage, props.storageScope, pending);
  await act(() => ui.root.render(createElement(RetainedBookingDialog, { ...props, pendingRequest: pending })));
  await pause(40);
  assert.equal(readPendingRetainedOrder(window.localStorage, props.storageScope), null);
  assert.match(document.body.textContent, /已確認原操作未套用/);
  assert.doesNotMatch(document.body.textContent, /原 OS 房晚已釋放/);
  assert.ok(ui.button('預覽保留訂單'));
});

test('abandon sends the original identity and only a matching durable receipt unlocks the form', async t => {
  const pending = { schema: 1, requestKey: '22222222-2222-4222-8222-222222222222', bookingId, action: 'retain', createdAt: 1, payload: command };
  const abandons = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).endsWith('/abandon')) {
      abandons.push({ key: options.headers['Idempotency-Key'], body: JSON.parse(options.body) });
      return Response.json({ ...applied(pending.requestKey, 'confirmed'), outcome: 'not_applied' });
    }
    assert.ok(!options.method);
    return String(url).includes('/requests/') ? Response.json({ code: 'REQUEST_NOT_FOUND' }, { status: 404 }) : Response.json(detail);
  });
  const ui = await mount(t, () => null);
  savePendingRetainedOrder(window.localStorage, props.storageScope, pending);
  await act(() => ui.root.render(createElement(RetainedBookingDialog, { ...props, pendingRequest: pending })));
  await pause(30); await pause(1300); await pause(2500);
  assert.deepEqual(readPendingRetainedOrder(window.localStorage, props.storageScope), pending);
  await ui.click(ui.button('放棄未完成操作，重新預覽'));
  assert.deepEqual(abandons, [{ key: pending.requestKey, body: { action: 'retain', input: command } }]);
  assert.equal(readPendingRetainedOrder(window.localStorage, props.storageScope), null);
  assert.ok(ui.button('預覽保留訂單'));
});

test('oversized reschedules are explained before generating price fields or calling preview', async t => {
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options = {}) => {
    if (options.method) writes++;
    return Response.json(retainedDetail);
  });
  const ui = await mount(t, RetainedBookingDialog, { ...props, action: 'reschedule' });
  await ui.fill(byLabel('第 1 段入住日期'), '2027-01-01');
  await ui.fill(byLabel('第 1 段退房日期'), '2027-06-01');
  assert.match(document.body.textContent, /最多安排 120 個房晚/);
  assert.equal(byLabel('2027-01-01 房費'), null);
  await ui.click(ui.button('檢查房況與差額'));
  assert.equal(writes, 0);
  assert.equal(document.getElementById('retained-reason').maxLength, 500);
});
