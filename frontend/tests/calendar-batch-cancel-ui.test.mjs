import test from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { mount } from './helpers/customer-dom.mjs';
import { apiClient } from '../src/lib/api-client.ts';
import { BatchCancelForm } from '../src/components/calendar/batch-cancel-dialog.tsx';

const property = {id: 'sweetfun', name: 'Synthetic Lodge'};
const rooms = ['101', '102', '201', '202', '301', '302'];
const bookings = ['2026-10-24', '2026-10-25'].flatMap((date, night) => rooms.map((room, index) => ({
  id: `sheet-${String(night * 6 + index + 1).padStart(20, '0')}`,
  property_id: property.id, room_number: room, guest_name: 'SYNTHETIC_GUEST',
  check_in: date, check_out: date === '2026-10-24' ? '2026-10-25' : '2026-10-26',
  order_id: `synthetic-order-${night}-${room}`, owlnest_order_no: `SYN-${night}-${room}`,
  source_order_linked: true, source_read_only: true, reservation_status: 'confirmed',
})));
const summary = row => ({id: row.id, date: row.check_in, room: row.room_number, guest: row.guest_name,
  orderNumber: row.owlnest_order_no, sourceLinked: true, sourcePaid: false});
const props = onVerified => ({onOpenChange: () => {}, bookings, properties: [property],
  initialStart: '2026-10-24', initialEnd: '2026-10-26', onVerified});
const submit = async button => act(async () => { button.click(); await Promise.resolve(); });

test('date and guest filter select twelve distinct orders, preview all rows, then require an explicit second confirmation', async t => {
  const calls = [], verified = [];
  t.mock.method(apiClient, 'post', async (_, body) => {
    calls.push(body);
    if (body.action === 'preview') return {digest: 'a'.repeat(64), rows: bookings.map(summary), omitted: [],
      roomNightCount: 12, distinctOrderCount: 12, formalOrderCount: 12, unlinkedRoomNightCount: 0,
      paidRoomNightCount: 0, financialBlockCount: 0, canConfirm: true};
    return {verified: true, deletedIds: body.ids};
  });
  const {button, click} = await mount(t, BatchCancelForm, props(ids => verified.push(ids)));
  assert.match(document.body.textContent, /符合條件：12 房晚/);
  await click(button('勾選篩選結果'));
  assert.match(document.body.textContent, /已選：12 房晚/);
  await submit(button('預覽刪除範圍'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ids.length, 12);
  assert.match(document.body.textContent, /12 房晚，涉及 12 個獨立來源訂單/);
  assert.equal(verified.length, 0);
  await submit(button('確認刪除 12 房晚'));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].action, 'confirm');
  assert.equal(verified[0].length, 12);
});

test('partial parent order cannot confirm until omitted date is explicitly added and previewed again', async t => {
  const calls = [];
  t.mock.method(apiClient, 'post', async (_, body) => {
    calls.push(body);
    const first = body.ids.length === 1;
    return {digest: first ? 'b'.repeat(64) : 'c'.repeat(64), rows: first ? [summary(bookings[0])] : [summary(bookings[0]), summary(bookings[6])],
      omitted: first ? [summary(bookings[6])] : [], roomNightCount: body.ids.length,
      distinctOrderCount: 1, formalOrderCount: 1, unlinkedRoomNightCount: 0,
      paidRoomNightCount: 0, financialBlockCount: 0, canConfirm: !first};
  });
  const {button, click} = await mount(t, BatchCancelForm, props(() => {}));
  await click(document.querySelector('section[aria-label="可選房晚"] input[type="checkbox"]'));
  await submit(button('預覽刪除範圍'));
  assert.equal(button('確認刪除 1 房晚').disabled, true);
  assert.match(document.body.textContent, /部分原訂單還有其他日期/);
  await click(button('加入上述房晚並重新預覽'));
  assert.equal(calls.length, 1);
  await submit(button('預覽刪除範圍'));
  assert.equal(calls[1].ids.length, 2);
  assert.equal(button('確認刪除 2 房晚').disabled, false);
});
