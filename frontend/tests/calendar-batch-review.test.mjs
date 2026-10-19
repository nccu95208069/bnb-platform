import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { adaptSheetBookings } from '../src/lib/booking-sources/sweetfun-sheet.ts';
import { SWEETFUN_SOURCE } from '../src/lib/booking-sources/config.ts';
import { HEADERS } from '../src/lib/sheet-monitor/reconcile.ts';
import { planBatchReview } from '../src/lib/booking-sources/batch-review.ts';

const source = { ...SWEETFUN_SOURCE, sourceId: `synthetic-${randomUUID()}` };
const roomNight = (room, date, uid, order, paid = 'not_yet') => [
  room, 'SYNTHETIC_GUEST', 'LINE', date,
  new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10),
  '2026-10-01', '2500', paid, 'OK', uid, '', order, '2',
];
const snapshotIds = values => adaptSheetBookings(values, source.sourceId, '2026-10-19T00:00:00Z', [], undefined, source.property).bookings.map(b => b.id);

test('reviews twelve independent room nights across distinct order numbers without guessing by guest name', () => {
  const rooms = ['101', '102', '201', '202', '301', '302'];
  const rows = ['2026-10-24', '2026-10-25'].flatMap(date => rooms.map(room =>
    roomNight(room, date, `synthetic-${date}-${room}`, `SYN-${date}-${room}`)));
  const values = [HEADERS, ...rows];
  const plan = planBatchReview(values, source, snapshotIds(values));
  assert.equal(plan.preview.roomNightCount, 12);
  assert.equal(plan.preview.distinctOrderCount, 12);
  assert.equal(plan.preview.formalOrderCount, 12);
  assert.equal(plan.preview.unlinkedRoomNightCount, 0);
  assert.equal(plan.preview.selectionComplete, true);
  assert.deepEqual(new Set(plan.preview.rows.map(row => row.date)), new Set(['2026-10-24', '2026-10-25']));
  assert.deepEqual(new Set(plan.preview.rows.map(row => row.room)), new Set(rooms));
  assert.ok(plan.preview.rows.every(row => row.guest === 'SYNTHETIC_GUEST' && row.orderNumber?.startsWith('SYN-')));
});

test('partial parent order reveals the omitted date and room', () => {
  const values = [HEADERS,
    roomNight('101', '2026-10-24', 'one', 'SYN-PARENT'),
    roomNight('101', '2026-10-25', 'two', 'SYN-PARENT'),
    roomNight('102', '2026-10-25', 'three', 'SYN-OTHER')];
  const ids = snapshotIds(values);
  const partial = planBatchReview(values, source, [ids[0], ids[2]]);
  assert.equal(partial.preview.selectionComplete, false);
  assert.deepEqual(partial.preview.omitted.map(row => [row.id, row.date, row.room]), [[ids[1], '2026-10-25', '101']]);
  assert.equal(partial.preview.distinctOrderCount, 2);
  assert.equal(planBatchReview(values, source, ids).preview.selectionComplete, true);
});

test('blank formal order stays an independent row and paid status is visible', () => {
  const values = [HEADERS, roomNight('301', '2026-10-24', 'unlinked', '', 'done')];
  const plan = planBatchReview(values, source, snapshotIds(values));
  assert.equal(plan.preview.formalOrderCount, 0);
  assert.equal(plan.preview.unlinkedRoomNightCount, 1);
  assert.equal(plan.preview.rows[0].orderNumber, null);
  assert.equal(plan.preview.paidRoomNightCount, 1);
});

test('stale, duplicate and conflicting row identities fail closed', () => {
  const values = [HEADERS, roomNight('101', '2026-10-24', 'one', 'SYN-ONE')];
  const id = snapshotIds(values)[0];
  assert.throws(() => planBatchReview(values, source, [id, id]), /INVALID_INPUT/);
  assert.throws(() => planBatchReview(values, source, ['sheet-00000000000000000000']), /SOURCE_CHANGED/);
  const conflicted = [HEADERS, values[1], roomNight('101', '2026-10-24', 'two', 'SYN-TWO')];
  assert.throws(() => planBatchReview(conflicted, source, [id]), /SOURCE_CHANGED/);
});

test('a quarantined night sharing a formal order blocks the review', () => {
  const values = [HEADERS,
    roomNight('101', '2026-10-24', 'valid', 'SYN-PARENT'),
    roomNight('102', '2026-10-25', 'unchecked', 'SYN-PARENT')];
  values[2][8] = 'pending';
  assert.throws(() => planBatchReview(values, source, [snapshotIds(values)[0]]), /SOURCE_CONFLICT/);
});
