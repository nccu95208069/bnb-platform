import test from 'node:test';
import assert from 'node:assert/strict';
import {visualCalendarStays} from '../src/components/calendar/visual-stays.ts';
import {layoutMonthWeek} from '../src/components/calendar/month-layout.ts';

const groups = [
  {platform: 'owljourney', nights: [
    ['sheet-2eafc35d9fcb6a2e0244', '2026-10-09'],
    ['sheet-31d4c161464248c37014', '2026-10-10'],
  ]},
  {platform: 'airbnb', nights: [
    ['sheet-b7402ee1d1d15fe944f8', '2026-10-12'],
    ['sheet-6a2a144755ad3ef892cf', '2026-10-13'],
    ['sheet-0bb01cb0bd5fd5534bf1', '2026-10-14'],
  ]},
  {platform: 'airbnb', nights: [
    ['sheet-9875596077c6235027ea', '2026-10-15'],
    ['sheet-6d71d91558f920c25983', '2026-10-16'],
  ]},
  {platform: 'booking', nights: [
    ['sheet-e5a0273523a36cfc917d', '2026-10-19'],
    ['sheet-2037aeb7e2c4aafb37fd', '2026-10-20'],
  ]},
  {platform: 'airbnb', nights: [
    ['sheet-b7b2645bd55994420fa6', '2026-10-26'],
    ['sheet-143b70fae41711bac4b3', '2026-10-27'],
  ]},
];
const rows = groups.flatMap((group, groupIndex) => group.nights.map(([id, check_in], nightIndex) => ({
  id, sheet_row_id: id, order_id: `row-order-${groupIndex}-${nightIndex}`, property_id: 'offland',
  property_name: 'OFFLAND', room_id: 'offland-villa', room_number: '包棟',
  platform: group.platform, reservation_status: 'confirmed',
  source_read_only: true, source_order_linked: false, source_identity_kind: 'row',
  booked_at: `2026-09-${String(groupIndex + 1).padStart(2, '0')}`, guest_name_kind: 'real', guest_name: `Sample Guest ${groupIndex}`,
  check_in, check_out: new Date(Date.parse(check_in + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10),
  room_rate: 100 + nightIndex, payment_status: 'paid',
  nightly_amounts: [{date: check_in, amount: 100 + nightIndex}],
})));

test('eleven verified OFFLAND rows display as five stays without changing underlying orders', () => {
  const original = structuredClone(rows);
  const display = visualCalendarStays(rows);
  assert.equal(display.length, 5);
  assert.deepEqual(display.map(stay => [stay.check_in, stay.check_out, stay.stay_nights]), [
    ['2026-10-09', '2026-10-11', 2],
    ['2026-10-12', '2026-10-15', 3],
    ['2026-10-15', '2026-10-17', 2],
    ['2026-10-19', '2026-10-21', 2],
    ['2026-10-26', '2026-10-28', 2],
  ]);
  assert.deepEqual(display.map(stay => stay.visual_source_ids.length), [2, 3, 2, 2, 2]);
  assert.deepEqual(display.map(stay => stay.order_id), [rows[0], rows[2], rows[5], rows[7], rows[9]].map(row => row.order_id));
  const week = ['12', '13', '14', '15', '16', '17', '18'].map(day => `2026-10-${day}`);
  const spans = layoutMonthWeek(display, week, '2026-10-19');
  assert.deepEqual(spans.map(span => [span.start, span.end]), [[0, 3], [3, 5]]);
  assert.deepEqual(rows, original);
});

test('changed source identity, dates, or explicit parent links fail closed', () => {
  for (const changed of [
    {...rows[3], id: 'replacement-row'},
    {...rows[3], check_in: '2026-10-20'},
    {...rows[3], source_order_linked: true},
    {...rows[3], room_id: 'other-room'},
    {...rows[3], booked_at: '2026-10-09'},
    {...rows[3], guest_name_kind: 'real', guest_name: 'Other Guest'},
  ]) {
    const input = rows.map(row => row === rows[3] ? changed : row);
    const display = visualCalendarStays(input);
    assert.equal(display.length, 7);
    assert.equal(display.find(row => row.id === rows[2].id).visual_source_ids, undefined);
  }
});
