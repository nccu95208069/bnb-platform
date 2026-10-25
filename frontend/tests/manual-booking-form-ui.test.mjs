import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement, useState } from 'react';
import { JSDOM } from 'jsdom';
import { mount } from './helpers/customer-dom.mjs';
import { todayInTaipei, stayNights } from '../src/lib/booking-sources/manual-booking-form.ts';
import { savePendingManualRequest, readPendingManualRequest } from '../src/lib/booking-sources/manual-request-identity.ts';

// Radix selects its browser layout effect when the module is initialized.
// Import the real dialog only after a DOM exists (no dialog/portal stubs).
const bootstrap = new JSDOM('<body></body>');
globalThis.window = bootstrap.window;
globalThis.document = bootstrap.window.document;
const { ManualBookingDialog } = await import('../src/components/calendar/manual-booking-dialog.tsx');
const { StayDateFields } = await import('../src/components/calendar/stay-date-fields.tsx');

const bookingId = '11111111-1111-4111-8111-111111111111';
const props = { open: true, mode: 'create', defaultDate: '2026-11-10', inventoryVersion: 80,
  onClose: () => {}, onDone: () => {} };
const byLabel = text => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === text);
const selectRoom = async (ui, room) => ui.click([...document.querySelectorAll('label')]
  .find(label => label.textContent.trim() === `${room} 房`)?.querySelector('input'));
const pause = ms => act(() => new Promise(resolve => setTimeout(resolve, ms)));

test('date selection advances to checkout and rejects a same-day checkout', async t => {
  function Picker() {
    const [dates, setDates] = useState(['2026-11-10', '2026-11-11']);
    return createElement(StayDateFields, { checkIn: dates[0], checkOut: dates[1],
      onChange: (start, end) => setDates([start, end]) });
  }
  const ui = await mount(t, Picker);
  await ui.click(byLabel('入住日期'));
  await ui.click(byLabel('2026-11-12'));
  assert.equal(byLabel('退房日期').getAttribute('aria-expanded'), 'true');
  assert.equal(byLabel('2026-11-12').disabled, true);
  assert.match(document.body.textContent, /接著選擇退房日/);
  await ui.click(byLabel('2026-11-15'));
  assert.equal(byLabel('退房日期').textContent, '2026/11/15');
  assert.equal(byLabel('退房日期').getAttribute('aria-expanded'), 'false');
});

test('two rooms expose individual dates/nightly prices and submit their exact total and Taipei booking date', async t => {
  const writes = [];
  let syncTarget = null;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).endsWith('/preview')) return Response.json({ inventoryVersion: 80, roomNights: 4,
      localRoomNightsAvailable: true, externalStockVerified: false });
    writes.push(JSON.parse(options.body));
    return Response.json({ bookingId, requestKey: options.headers['idempotency-key'],
      operationState: 'awaiting_manual_sync', inventoryVersion: 81 });
  });
  const ui = await mount(t, ManualBookingDialog, { ...props,
    onSyncCreated: (id, version) => { syncTarget = { id, version }; } });
  assert.equal(document.getElementById('manual-booked').value, todayInTaipei());
  await ui.fill(document.getElementById('manual-guest'), 'Synthetic Form Guest');
  await ui.click(byLabel('退房日期')); await ui.click(byLabel('2026-11-12'));
  await selectRoom(ui, '101'); await selectRoom(ui, '202');
  await ui.click(byLabel('202 房入住日期')); await ui.click(byLabel('2026-11-11'));
  await ui.click(byLabel('2026-11-13'));
  for (const [room, night, amount] of [['101', '10', '3900'], ['101', '11', '4100'],
    ['202', '11', '5000'], ['202', '12', '5200']])
    await ui.fill(document.getElementById(`manual-price-${room}-2026-11-${night}`), amount);
  assert.equal(document.querySelector('output').textContent, 'NT$ 18,200');
  await ui.click(ui.button('檢查房晚')); await ui.click(ui.button('確認提交'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].totalCents, 1820000);
  assert.equal(writes[0].bookedAt, todayInTaipei());
  assert.deepEqual(writes[0].stays, [
    { checkIn: '2026-11-10', checkOut: '2026-11-12', roomNumbers: ['101'] },
    { checkIn: '2026-11-11', checkOut: '2026-11-13', roomNumbers: ['202'] },
  ]);
  assert.deepEqual(writes[0].roomNightPrices.map(p => p.amountCents), [390000, 410000, 500000, 520000]);
  assert.equal(readPendingManualRequest(window.localStorage), null);
  assert.ok(ui.button('同步房況'));
  await ui.click(ui.button('同步房況'));
  assert.deepEqual(syncTarget, { id: bookingId, version: 81 });
  assert.equal(writes.length, 1);
});

test('uncertain submission automatically confirms the original booking without a second write or technical request UI', async t => {
  let writes = 0, reads = 0, done = 0, originalKey, syncTarget = null;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).endsWith('/preview')) return Response.json({ inventoryVersion: 80, roomNights: 1 });
    if (String(url).includes('/requests/')) {
      reads++; assert.ok(String(url).endsWith(originalKey));
      return Response.json({ bookingId, requestKey: originalKey, readbackVerified: true, inventoryVersion: 81,
        currentStatus: 'confirmed', currentChannelSyncState: 'awaiting_manual_sync' });
    }
    writes++; originalKey = options.headers['idempotency-key'];
    return Response.json({ outcome: 'unknown' }, { status: 202 });
  });
  const ui = await mount(t, ManualBookingDialog, { ...props, onDone: () => done++,
    onSyncCreated: (id, version) => { syncTarget = { id, version }; } });
  await ui.fill(document.getElementById('manual-guest'), 'Synthetic Recovery Guest');
  await selectRoom(ui, '101');
  await ui.fill(document.getElementById('manual-price-101-2026-11-10'), '3900');
  await ui.click(ui.button('檢查房晚')); await ui.click(ui.button('確認提交'));
  await pause(40);
  assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(done, 1);
  assert.equal(readPendingManualRequest(window.localStorage), null);
  assert.doesNotMatch(document.body.textContent, /原請求|[a-f0-9]{8}-[a-f0-9]{4}-/);
  assert.match(document.body.textContent, /訂單已儲存並確認/);
  await ui.click(ui.button('同步房況'));
  assert.deepEqual(syncTarget, { id: bookingId, version: 81 });
  assert.equal(writes, 1);
});

test('a reopened pending submission is checked automatically; failed reads retain its identity and never write', async t => {
  const pending = { requestKey: '22222222-2222-4222-8222-222222222222', mode: 'create', bookingId: null, createdAt: 1 };
  let reads = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    assert.notEqual(options.method, 'POST');
    assert.ok(String(url).endsWith(pending.requestKey)); reads++;
    return Response.json({ code: 'MANUAL_READ_UNAVAILABLE' }, { status: 503 });
  });
  const ui = await mount(t, ManualBookingDialog, { ...props, open: false });
  savePendingManualRequest(window.localStorage, pending);
  await act(() => ui.root.render(createElement(ManualBookingDialog, props)));
  await pause(40);
  assert.equal(reads, 1); assert.deepEqual(readPendingManualRequest(window.localStorage), pending);
  assert.equal(ui.button('確認提交'), undefined);
  assert.doesNotMatch(document.body.textContent, /原請求鍵|查詢原請求/);
});

test('booking date uses the current Taipei day, independent of stay date or UTC midnight', () => {
  assert.equal(todayInTaipei(new Date('2026-10-24T16:01:00Z')), '2026-10-25');
  assert.equal(todayInTaipei(new Date('2026-10-24T15:59:00Z')), '2026-10-24');
  assert.deepEqual(stayNights('2026-11-30', '2026-12-02'), ['2026-11-30', '2026-12-01']);
});

const editDetail = { bookingId, version: 3, status: 'confirmed', source: 'external', osEditMode: 'full',
  channelSyncState: 'not_required', sourceReviewRequired: false, guestName: 'Synthetic LINE Guest',
  contact: 'synthetic@example.test', notes: 'Original note', totalCents: 900000, netReceivedCents: 200000,
  bookedAt: '2026-10-20', stays: [
    { checkIn: '2026-11-10', checkOut: '2026-11-11', roomNumbers: ['101'] },
    { checkIn: '2026-11-15', checkOut: '2026-11-16', roomNumbers: ['202'] },
  ], roomNightPrices: [
    { roomNumber: '101', date: '2026-11-10', amountCents: 400000 },
    { roomNumber: '202', date: '2026-11-15', amountCents: 500000 },
  ] };

test('legacy LINE full form edits multiple/disjoint stays, booking date and exact nightly amounts', async t => {
  const writes = [], previews = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (!options.method) return Response.json(editDetail);
    if (String(url).endsWith('/preview')) {
      previews.push(JSON.parse(options.body)); return Response.json({ inventoryVersion: 80, roomNights: 2 });
    }
    writes.push(JSON.parse(options.body));
    return Response.json({ bookingId, requestKey: options.headers['idempotency-key'], operationState: 'awaiting_manual_sync' });
  });
  const ui = await mount(t, ManualBookingDialog, { ...props, mode: 'amend', bookingId });
  assert.equal(document.getElementById('manual-booked').disabled, false);
  assert.equal(document.querySelectorAll('select').length, 2);
  await ui.fill(document.getElementById('manual-guest'), 'Changed Synthetic Guest');
  await ui.fill(document.getElementById('manual-contact'), 'changed@example.test');
  await ui.fill(document.getElementById('manual-notes'), 'Changed note');
  await ui.fill(document.getElementById('manual-booked'), '2026-10-21');
  // Reuse the same room on a disjoint date; the first segment must survive.
  await ui.fill(document.querySelector('[aria-label="第 2 段房間"]'), '101');
  await ui.fill(document.getElementById('amend-price-0-2026-11-10'), '4100');
  await ui.fill(document.getElementById('amend-price-1-2026-11-15'), '5300');
  await ui.fill(document.getElementById('manual-reason'), 'Synthetic correction');
  assert.equal(document.querySelector('output').textContent, 'NT$ 9,400');
  await ui.click(ui.button('檢查房晚')); await ui.click(ui.button('確認提交'));
  assert.equal(previews.length, 1); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].changes, { guestName: 'Changed Synthetic Guest', contact: 'changed@example.test',
    notes: 'Changed note', bookedAt: '2026-10-21', stays: [editDetail.stays[0],
      { ...editDetail.stays[1], roomNumbers: ['101'] }], totalCents: 940000,
    roomNightPrices: [{ roomNumber: '101', date: '2026-11-10', amountCents: 410000 },
      { roomNumber: '101', date: '2026-11-15', amountCents: 530000 }] });
});

test('metadata edit preserves unknown nightly distribution and the original stay representation', async t => {
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (_url, options = {}) => {
    if (!options.method) return Response.json({ ...editDetail, source: 'line', roomNightPrices: null });
    assert.equal(options.method, 'PATCH'); writes.push(JSON.parse(options.body));
    return Response.json({ bookingId, requestKey: options.headers['idempotency-key'] });
  });
  const ui = await mount(t, ManualBookingDialog, { ...props, mode: 'amend', bookingId });
  await ui.fill(document.getElementById('manual-notes'), 'Metadata only');
  await ui.fill(document.getElementById('manual-booked'), '');
  await ui.fill(document.getElementById('manual-reason'), 'Synthetic correction');
  await ui.click(ui.button('確認修改'));
  assert.deepEqual(writes[0].changes, { notes: 'Metadata only', bookedAt: null });
});

test('adding and removing segments retains other stays and rejects duplicate room-nights before network writes', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options = {}) => {
    assert.ok(!options.method); return Response.json(editDetail);
  });
  const ui = await mount(t, ManualBookingDialog, { ...props, mode: 'amend', bookingId });
  await ui.click(ui.button('新增住宿段'));
  assert.equal(document.querySelectorAll('select').length, 3);
  await ui.click(byLabel('移除第 3 段'));
  assert.equal(document.querySelectorAll('select').length, 2);
  await ui.fill(document.querySelector('[aria-label="第 2 段房間"]'), '101');
  await ui.click(byLabel('第 2 段入住日期')); await ui.click(byLabel('2026-11-10')); await ui.click(byLabel('2026-11-11'));
  await ui.fill(document.getElementById('manual-reason'), 'Synthetic duplicate');
  await ui.click(ui.button('檢查房晚'));
  assert.match(document.body.textContent, /同一間房的住宿日期不能重複/);
});

test('manual closure confirmation displays exact stays, requires attestation and only posts the local confirmation', async t => {
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (!options.method) return Response.json({ bookingId, version: 1, status: 'confirmed', source: 'line',
      osEditMode: 'full', channelSyncState: 'action_required', manualRoomConfirmationAvailable: true,
      sourceReviewRequired: false, guestName: null, contact: null, notes: null, totalCents: 100000,
      netReceivedCents: 0, bookedAt: null, roomNightPrices: null,
      stays: [{ checkIn: '2026-12-05', checkOut: '2026-12-06', roomNumbers: ['301'] }] });
    writes.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json({ bookingId, requestKey: options.headers['idempotency-key'], channelSyncState: 'manually_confirmed', operationState: 'manually_confirmed' });
  });
  const ui = await mount(t, ManualBookingDialog, { ...props, mode: 'manual-confirm', bookingId });
  assert.match(document.body.textContent, /301 房.*2026-12-05.*2026-12-06/);
  assert.match(document.body.textContent, /不會開關 OwlNest/);
  assert.equal(ui.button('確認並清除待處理提示').disabled, true);
  assert.equal(document.getElementById('manual-guest'), null);
  await ui.click(document.querySelector('input[type="checkbox"]'));
  await ui.click(ui.button('確認並清除待處理提示'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, `/api/v1/bookings/manual/${bookingId}/confirm-manual-room-handling`);
  assert.equal(writes[0].body.confirmed, true);
  assert.equal(writes[0].body.expectedBookingVersion, 1);
  assert.match(document.body.textContent, /待處理提示已清除.*未變更 OwlNest/);
  assert.equal(readPendingManualRequest(window.localStorage), null);
});

test('manual room changes show opening and closing scope before owner confirmation', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ bookingId, version: 3,
    status: 'confirmed', source: 'os', osEditMode: 'full', channelSyncState: 'action_required',
    manualRoomConfirmationAvailable: true, sourceReviewRequired: false, guestName: null,
    totalCents: 100000, netReceivedCents: 0, roomNightPrices: null,
    manualRoomHandling: { confirmedAt: '2026-10-25T04:00:00Z', pending: [
      { roomNumber: '101', date: '2026-11-12', desired: 'open' },
      { roomNumber: '102', date: '2026-11-13', desired: 'closed' }] },
    stays: [{ checkIn: '2026-11-13', checkOut: '2026-11-14', roomNumbers: ['102'] }] }));
  const ui = await mount(t, ManualBookingDialog, { ...props, mode: 'manual-confirm', bookingId });
  assert.match(document.body.textContent, /101 房.*2026-11-12.*已手動開房/);
  assert.match(document.body.textContent, /102 房.*2026-11-13.*已手動關房/);
  assert.equal(ui.button('確認並清除待處理提示').disabled, true);
});
