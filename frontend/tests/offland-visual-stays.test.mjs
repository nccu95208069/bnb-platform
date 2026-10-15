import test from 'node:test';
import assert from 'node:assert/strict';
import {visualCalendarStays} from '../src/components/calendar/visual-stays.ts';
import {layoutMonthWeek} from '../src/components/calendar/month-layout.ts';

const rows = [
  ['sheet-b7402ee1d1d15fe944f8', '2026-10-12'],
  ['sheet-6a2a144755ad3ef892cf', '2026-10-13'],
  ['sheet-0bb01cb0bd5fd5534bf1', '2026-10-14'],
  ['sheet-9875596077c6235027ea', '2026-10-15'],
  ['sheet-6d71d91558f920c25983', '2026-10-16'],
].map(([id, check_in], index) => ({
  id, sheet_row_id: id, order_id: `row-order-${index}`, property_id: 'offland',
  property_name: 'OFFLAND', room_id: 'offland-villa', room_number: '包棟',
  platform: 'airbnb', reservation_status: 'confirmed',
  source_read_only: true, source_order_linked: false, source_identity_kind: 'row',
  booked_at: '2026-10-01', guest_name_kind: 'real', guest_name: index < 3 ? 'Sample Guest A' : 'Sample Guest B',
  check_in, check_out: new Date(Date.parse(check_in + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10),
  room_rate: 100 + index, payment_status: 'paid',
  nightly_amounts: [{date: check_in, amount: 100 + index}],
}));

test('the five verified OFFLAND rows display as two stays without changing underlying orders', () => {
  const original = structuredClone(rows);
  const display = visualCalendarStays(rows);
  assert.equal(display.length, 2);
  assert.deepEqual(display.map(stay => [stay.check_in, stay.check_out, stay.stay_nights]), [
    ['2026-10-12', '2026-10-15', 3], ['2026-10-15', '2026-10-17', 2],
  ]);
  assert.deepEqual(display.map(stay => stay.visual_source_ids.length), [3, 2]);
  assert.deepEqual(display.map(stay => stay.order_id), [rows[0].order_id, rows[3].order_id]);
  const week = ['12', '13', '14', '15', '16', '17', '18'].map(day => `2026-10-${day}`);
  const spans = layoutMonthWeek(display, week, '2026-10-19');
  assert.deepEqual(spans.map(span => [span.start, span.end]), [[0, 3], [3, 5]]);
  assert.deepEqual(rows, original);
});

test('changed source identity, dates, or explicit parent links fail closed', () => {
  for (const changed of [
    {...rows[1], id: 'replacement-row'},
    {...rows[1], check_in: '2026-10-20'},
    {...rows[1], source_order_linked: true},
    {...rows[1], room_id: 'other-room'},
    {...rows[1], booked_at: '2026-10-09'},
    {...rows[1], guest_name_kind: 'real', guest_name: 'Other Guest'},
  ]) {
    const input = rows.map(row => row === rows[1] ? changed : row);
    const display = visualCalendarStays(input);
    assert.equal(display.length, 4);
    assert.equal(display.find(row => row.id === rows[0].id).visual_source_ids, undefined);
  }
});
