import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { randomUUID } from 'node:crypto';
import { mount } from './helpers/customer-dom.mjs';
import { websiteFixture } from './helpers/website-booking-fixture.mjs';
import { amendWebsiteBooking } from '../src/lib/customer-workspaces/website-amendment.ts';
import { holdOperation } from '../src/lib/customer-workspaces/holds.ts';
import { view } from '../src/lib/customer-workspaces/service.ts';
import { addDays } from '../src/lib/website-booking/config.ts';
import { OrderDetail } from '../src/components/customer-workspaces/order-detail.tsx';
import { OrderAmendment } from '../src/components/customer-workspaces/order-amendment.tsx';

const property = {
  id: 'property-a', name: 'Synthetic inn', kind: 'rooms', sourceMode: 'native',
  rooms: [{ id: 'room-101', name: '101' }, { id: 'room-102', name: '102' }], villaRoomIds: [],
};
const order = {
  id: 'website-order', version: 3, propertyId: property.id, guestName: 'Synthetic',
  checkIn: '2027-01-01', checkOut: '2027-01-03', roomIds: ['room-101'], total: 9000,
  payments: [], status: 'held', entry: 'os', platform: 'Official Website',
  createdAt: '2026-10-01T12:00:00Z', contact: null, notes: null, guestNotified: false,
  hold: { schema: 1, scope: 'platform_only', startedAt: '2026-10-01T12:00:00Z', expiresAt: '2026-10-02T12:00:00Z', state: 'active' },
};
const initial = {
  id: 'workspace', slug: 'synthetic-amendment', name: 'Synthetic', version: 7, role: 'owner',
  properties: [property, { ...property, id: 'property-b', rooms: [{ id: 'room-201', name: '201' }] }],
  bookings: [order], readiness: { [property.id]: { complete: true, unresolvedCount: 0 } }, features: { holds: true },
};
const props = data => ({ initial: data, bookingId: order.id, backHref: '/w/synthetic-amendment/orders' });
const confirmation = '我已核對新日期、房間與整筆總額，確認更新同一筆訂單';
const saveLabel = '確認改期／換房並核對';
async function edit(ui) {
  await ui.click(ui.button('改期／換房與總額'));
  await ui.fill(ui.control('新入住日期'), '2027-02-05');
  await ui.fill(ui.control('新退房日期'), '2027-02-08');
  await ui.click(ui.control('101'));
  await ui.click(ui.control('102'));
  await ui.fill(ui.control('新整筆應收總額'), '12345.5');
}
function saved(input, data = initial) {
  return { workspace: { ...data, version: data.version + 1, bookings: [{ ...data.bookings[0],
    version: data.bookings[0].version + 1, checkIn: input.checkIn, checkOut: input.checkOut, roomIds: input.roomIds, total: input.total,
  }] } };
}

test('website amendment shows the original stay and sends explicitly confirmed dates, physical rooms and one total', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const input = JSON.parse(options.body); calls.push({ url, input }); return Response.json(saved(input));
  });
  const ui = await mount(t, OrderDetail, props(initial));
  await edit(ui);
  assert.equal(ui.control('201'), undefined);
  assert.match(document.body.textContent, /變更前.*2027-01-01.*2027-01-03.*NT\$ 9,000/s);
  assert.match(document.body.textContent, /不會自動計價/);
  assert.match(document.body.textContent, /原 24 小時保留期限不因改期或換房重置/);
  assert.equal(ui.button(saveLabel).disabled, true);
  await ui.click(ui.control(confirmation));
  await ui.fill(ui.control('新整筆應收總額'), '13000');
  assert.equal(ui.control(confirmation).checked, false);
  await ui.click(ui.control(confirmation));
  await ui.click(ui.button(saveLabel));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/customer-workspaces/synthetic-amendment/operations');
  const { requestKey, ...input } = calls[0].input;
  assert.match(requestKey, /^[a-f0-9-]{36}$/);
  assert.deepEqual(input, { action: 'website-amend', bookingId: order.id, version: 7, bookingVersion: 3,
    checkIn: '2027-02-05', checkOut: '2027-02-08', roomIds: ['room-102'], total: 13000, confirmed: true, allowOverpayment: false });
  assert.match(document.body.textContent, /2027-02-05 入住 → 2027-02-08 退房/);
  assert.match(document.body.textContent, /已更新並重新查回同一筆訂單/);
  assert.match(document.body.textContent, /通知已排入寄送佇列，實際送達仍待確認/);
  assert.doesNotMatch(document.body.textContent, /通知已送達/);
});

test('unknown amendment result locks all other order actions and retries the identical command and request key', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    const input = JSON.parse(options.body); calls.push(input);
    if (calls.length === 1) throw Error('Synthetic response lost');
    return Response.json(saved(input));
  });
  const ui = await mount(t, OrderDetail, props(initial));
  await edit(ui); await ui.click(ui.control(confirmation)); await ui.click(ui.button(saveLabel));
  assert.equal(ui.control('新入住日期').matches(':disabled'), true);
  assert.equal(ui.button('取消變更').matches(':disabled'), true);
  for (const label of ['延長保留', '確認已收訂金', '釋出保留', '新增備註／訂單資料', '＋新增標籤']) {
    assert.equal(ui.button(label).disabled, true, label);
  }
  const back = document.querySelector('a');
  assert.equal(back.getAttribute('aria-disabled'), 'true');
  const click = new ui.dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  await act(() => back.dispatchEvent(click)); assert.equal(click.defaultPrevented, true);
  await ui.click(ui.button('重試相同改期／換房操作'));
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(ui.button('延長保留').disabled, false);
  assert.equal(back.getAttribute('aria-disabled'), 'false');
});

test('confirmed website orders can amend and uncertain amendments lock receipt entry', async t => {
  const data = { ...initial, bookings: [{ ...order, status: 'confirmed', hold: { ...order.hold, state: 'converted' } }] };
  t.mock.method(globalThis, 'fetch', async () => { throw Error('Synthetic unavailable'); });
  const ui = await mount(t, OrderDetail, props(data));
  await edit(ui); await ui.click(ui.control(confirmation)); await ui.click(ui.button(saveLabel));
  assert.equal(ui.button('＋已收款').disabled, true);
});

test('amendment is hidden for restricted roles, cancelled, imported, connected and multi-segment orders', async t => {
  const ui = await mount(t, OrderDetail, props(initial));
  const cases = [
    ...['housekeeper', 'viewer', 'viewer_no_price'].map(role => ({ ...initial, role })),
    { ...initial, features: { holds: false } },
    { ...initial, bookings: [{ ...order, status: 'cancelled' }] },
    { ...initial, bookings: [{ ...order, platform: 'Booking' }] },
    { ...initial, bookings: [{ ...order, entry: 'sheet' }] },
    { ...initial, bookings: [{ ...order, hold: undefined }] },
    { ...initial, properties: [{ ...property, setup: { mode: 'sheet' } }] },
    { ...initial, readiness: { [property.id]: { complete: true, connected: true } } },
    { ...initial, bookings: [{ ...order, stays: [
      { checkIn: '2027-01-01', checkOut: '2027-01-03', roomIds: ['room-101'] },
      { checkIn: '2027-02-01', checkOut: '2027-02-03', roomIds: ['room-102'] },
    ] }] },
  ];
  for (const [index, data] of cases.entries()) {
    await act(() => ui.root.render(createElement(OrderDetail, { ...props(data), key: index })));
    assert.equal(ui.button('改期／換房與總額'), undefined, `case ${index}`);
  }
  await act(() => ui.root.render(createElement(OrderDetail, { ...props({ ...initial, role: 'admin' }), key: 'admin' })));
  assert.ok(ui.button('改期／換房與總額'));
});

test('an open amendment keeps its original versions until authoritative reload and requires a room', async t => {
  const calls = [];
  const next = { ...initial, version: 8, bookings: [{ ...order, version: 4, total: 11000 }] };
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    if (options.method === 'GET') return Response.json(next);
    calls.push(JSON.parse(options.body));
    return Response.json({ detail: '資料已更新，請重新載入。' }, { status: 409 });
  });
  const base = { data: initial, booking: order, onSaved() {}, onPendingChange() {}, externalLocked: false };
  const ui = await mount(t, OrderAmendment, base);
  await ui.click(ui.button('改期／換房與總額'));
  await ui.click(ui.control('101'));
  assert.equal(ui.button(saveLabel).disabled, true);
  await ui.click(ui.control('102'));
  await ui.click(ui.control(confirmation));
  await act(() => ui.root.render(createElement(OrderAmendment, { ...base, data: next, booking: next.bookings[0] })));
  await ui.click(ui.button(saveLabel));
  assert.equal(calls[0].version, 7); assert.equal(calls[0].bookingVersion, 3); assert.equal(calls[0].total, 9000);
  assert.equal(ui.button('重試相同改期／換房操作'), undefined);
  await ui.click(ui.button('重新載入最新資料'));
  await ui.click(ui.button('改期／換房與總額'));
  assert.equal(ui.control('新整筆應收總額').value, '11000');
});

test('website cancellation explains queued notification without claiming delivery', async t => {
  const calls = [];
  const data = { ...initial, bookings: [{ ...order, status: 'confirmed', hold: { ...order.hold, state: 'converted' } }] };
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    calls.push(JSON.parse(options.body));
    return Response.json({ workspace: { ...data, version: 8,
      bookings: [{ ...data.bookings[0], status: 'cancelled', version: 4 }] } });
  });
  const ui = await mount(t, OrderDetail, props(data));
  await ui.click(ui.button('＋已收款')); await ui.click(ui.button('取消訂單'));
  assert.match(document.body.textContent, /官網通知會排入寄送佇列/);
  await ui.click(ui.control('確認取消這筆訂單'));
  await ui.click(ui.button('確認取消並釋出房間'));
  assert.equal(calls[0].action, 'cancel'); assert.equal(calls[0].confirmed, true);
  assert.match(document.body.textContent, /訂單已取消，房間已釋出。官網通知已排入寄送佇列，實際送達仍待確認/);
  assert.equal(ui.button('改期／換房與總額'), undefined);
});

test('the amendment form persists through the real service and recovers a lost response without altering receipts or the hold deadline', async t => {
  const f = await websiteFixture({ units: 2 });
  const { result: reservation } = await f.reserve();
  const before = await f.workspace(), booking = before.bookings.find(b => b.id === reservation.orderId);
  await holdOperation(f.store, f.account.id, before.slug, {
    action: 'hold-convert', bookingId: booking.id, version: before.version, bookingVersion: booking.version,
    requestKey: randomUUID(), confirmPlatformOnly: true, confirmedReceipt: true,
    amount: 1000, method: 'cash', receivedAt: new Date(f.now.getTime() - 1000).toISOString(),
  }, f.now);
  const workspace = await f.workspace(), paid = workspace.bookings.find(b => b.id === booking.id);
  const current = view(workspace, workspace.members.find(m => m.accountId === f.account.id));
  const rooms = current.properties.find(p => p.id === booking.propertyId).rooms;
  const oldRoom = rooms.find(r => r.id === booking.roomIds[0]), newRoom = rooms.find(r => r.id !== oldRoom.id);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    const input = JSON.parse(options.body); calls.push(input);
    const result = await amendWebsiteBooking(f.store, f.account.id, current.slug, input, f.now);
    if (calls.length === 1) throw Error('Synthetic successful write response lost');
    return Response.json(result);
  });
  const ui = await mount(t, OrderDetail, { initial: current, bookingId: booking.id, backHref: `/w/${current.slug}/orders` });
  await ui.click(ui.button('改期／換房與總額'));
  await ui.fill(ui.control('新入住日期'), addDays(booking.checkIn, 4));
  await ui.fill(ui.control('新退房日期'), addDays(booking.checkOut, 5));
  await ui.click(ui.control(oldRoom.name)); await ui.click(ui.control(newRoom.name));
  await ui.fill(ui.control('新整筆應收總額'), '5000');
  await ui.click(ui.control(confirmation)); await ui.click(ui.button(saveLabel));
  assert.equal(ui.button('＋已收款').disabled, true);
  await ui.click(ui.button('重試相同改期／換房操作'));
  assert.deepEqual(calls[0], calls[1]);
  const actual = (await f.workspace()).bookings.find(b => b.id === booking.id);
  assert.equal(actual.version, paid.version + 1); assert.equal(actual.status, 'confirmed');
  assert.equal(actual.checkIn, addDays(booking.checkIn, 4)); assert.equal(actual.checkOut, addDays(booking.checkOut, 5));
  assert.deepEqual(actual.roomIds, [newRoom.id]); assert.equal(actual.total, 5000);
  assert.deepEqual(actual.payments, paid.payments); assert.deepEqual(actual.hold, paid.hold);
  assert.match(document.body.textContent, /NT\$ 4,000/);
  assert.match(document.body.textContent, /已更新並重新查回同一筆訂單/);
});
