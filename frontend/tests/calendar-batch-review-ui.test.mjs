import test from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { mount } from './helpers/customer-dom.mjs';
import { apiClient } from '../src/lib/api-client.ts';
import { BatchReviewForm } from '../src/components/calendar/batch-review-dialog.tsx';

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
const props = {onOpenChange: () => {}, bookings, properties: [property],
  initialStart: '2026-10-24', initialEnd: '2026-10-26'};
const submit = async button => act(async () => { button.click(); await Promise.resolve(); });

test('selects twelve distinct orders and shows a read-only source review', async t => {
  const calls = [];
  t.mock.method(apiClient, 'post', async (path, body) => {
    calls.push({path, body});
    return {rows: bookings.map(summary), omitted: [], roomNightCount: 12, distinctOrderCount: 12,
      formalOrderCount: 12, unlinkedRoomNightCount: 0, paidRoomNightCount: 0,
      financialBlockCount: 0, selectionComplete: true, manualActionRequired: true};
  });
  const {button, click} = await mount(t, BatchReviewForm, props);
  assert.match(document.body.textContent, /符合條件：12 房晚/);
  await click(button('勾選篩選結果'));
  assert.match(document.body.textContent, /已選：12 房晚/);
  await submit(button('核對主表房晚'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/bookings/batch-review');
  assert.equal(calls[0].body.action, 'preview');
  assert.equal(calls[0].body.ids.length, 12);
  assert.match(document.body.textContent, /已選 12 房晚，涉及 12 個獨立來源訂單/);
  assert.match(document.body.textContent, /不會自動寫入/);
  assert.doesNotMatch(document.body.textContent, /確認刪除/);
});

test('partial parent order reveals omitted nights for another read-only review', async t => {
  const calls = [];
  t.mock.method(apiClient, 'post', async (_, body) => {
    calls.push(body);
    const first = body.ids.length === 1;
    return {rows: first ? [summary(bookings[0])] : [summary(bookings[0]), summary(bookings[6])],
      omitted: first ? [summary(bookings[6])] : [], roomNightCount: body.ids.length,
      distinctOrderCount: 1, formalOrderCount: 1, unlinkedRoomNightCount: 0,
      paidRoomNightCount: 0, financialBlockCount: 0, selectionComplete: !first, manualActionRequired: true};
  });
  const {button, click} = await mount(t, BatchReviewForm, props);
  await click(document.querySelector('section[aria-label="可選房晚"] input[type="checkbox"]'));
  await submit(button('核對主表房晚'));
  assert.match(document.body.textContent, /同筆來源訂單還有其他房晚/);
  await click(button('加入上述房晚並重新預覽'));
  assert.equal(calls.length, 1);
  await submit(button('核對主表房晚'));
  assert.equal(calls[1].ids.length, 2);
  assert.doesNotMatch(document.body.textContent, /確認刪除/);
});
