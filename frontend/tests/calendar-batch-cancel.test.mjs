import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { adaptSheetBookings } from '../src/lib/booking-sources/sweetfun-sheet.ts';
import { SWEETFUN_SOURCE } from '../src/lib/booking-sources/config.ts';
import { HEADERS } from '../src/lib/sheet-monitor/reconcile.ts';
import { planBatchCancel, expectedAfterDelete, verifiedAfterDelete, deleteDimensionRequests } from '../src/lib/booking-sources/batch-cancel.ts';
import { commitBatchCancel } from '../src/lib/booking-sources/batch-cancel-service.ts';

const source = { ...SWEETFUN_SOURCE, sourceId: `synthetic-${randomUUID()}` };
const roomNight = (room, date, uid, order, paid = 'not_yet') => [
  room, 'SYNTHETIC_GUEST', 'LINE', date,
  new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10),
  '2026-10-01', '2500', paid, 'OK', uid, '', order, '2',
];
const snapshotIds = values => adaptSheetBookings(values, source.sourceId, '2026-10-19T00:00:00Z', [], undefined, source.property).bookings.map(b => b.id);

test('selects twelve independent room nights across distinct order numbers without guessing by guest name', () => {
  const rooms = ['101', '102', '201', '202', '301', '302'];
  const rows = ['2026-10-24', '2026-10-25'].flatMap(date => rooms.map(room =>
    roomNight(room, date, `synthetic-${date}-${room}`, `SYN-${date}-${room}`)));
  const values = [HEADERS, ...rows];
  const plan = planBatchCancel(values, source, snapshotIds(values));
  assert.equal(plan.preview.roomNightCount, 12);
  assert.equal(plan.preview.distinctOrderCount, 12);
  assert.equal(plan.preview.formalOrderCount, 12);
  assert.equal(plan.preview.unlinkedRoomNightCount, 0);
  assert.equal(plan.preview.canConfirm, true);
  assert.deepEqual(new Set(plan.preview.rows.map(row => row.date)), new Set(['2026-10-24', '2026-10-25']));
  assert.deepEqual(new Set(plan.preview.rows.map(row => row.room)), new Set(rooms));
  assert.ok(plan.preview.rows.every(row => row.guest === 'SYNTHETIC_GUEST' && row.orderNumber?.startsWith('SYN-')));
  assert.deepEqual(deleteDimensionRequests(source, plan.selectedRows).map(r => r.deleteDimension.range.startIndex),
    Array.from({length: 12}, (_, i) => 12 - i));
  const after = expectedAfterDelete(values, plan.selectedRows);
  assert.equal(verifiedAfterDelete(values, after, plan.selectedRows), true);
  assert.equal(verifiedAfterDelete(values, [HEADERS, ...rows.slice(1)], plan.selectedRows), false);
});

test('partial parent order is blocked and reveals the omitted date and room', () => {
  const values = [HEADERS,
    roomNight('101', '2026-10-24', 'one', 'SYN-PARENT'),
    roomNight('101', '2026-10-25', 'two', 'SYN-PARENT'),
    roomNight('102', '2026-10-25', 'three', 'SYN-OTHER')];
  const ids = snapshotIds(values);
  const partial = planBatchCancel(values, source, [ids[0], ids[2]]);
  assert.equal(partial.preview.canConfirm, false);
  assert.deepEqual(partial.preview.omitted.map(row => [row.id, row.date, row.room]), [[ids[1], '2026-10-25', '101']]);
  assert.equal(partial.preview.distinctOrderCount, 2);
  const whole = planBatchCancel(values, source, ids);
  assert.equal(whole.preview.canConfirm, true);
  assert.notEqual(partial.preview.digest, whole.preview.digest);
});

test('blank formal order remains one independent source row and is never presented as a copyable number', () => {
  const values = [HEADERS, roomNight('301', '2026-10-24', 'unlinked', '', 'done')];
  const plan = planBatchCancel(values, source, snapshotIds(values));
  assert.equal(plan.preview.formalOrderCount, 0);
  assert.equal(plan.preview.unlinkedRoomNightCount, 1);
  assert.equal(plan.preview.rows[0].orderNumber, null);
  assert.equal(plan.preview.paidRoomNightCount, 1);
});

test('stale, duplicate and conflicting row identities fail closed', () => {
  const values = [HEADERS, roomNight('101', '2026-10-24', 'one', 'SYN-ONE')];
  const id = snapshotIds(values)[0];
  assert.throws(() => planBatchCancel(values, source, [id, id]), /INVALID_INPUT/);
  assert.throws(() => planBatchCancel(values, source, ['sheet-00000000000000000000']), /SOURCE_CHANGED/);
  const conflicted = [HEADERS, values[1], roomNight('101', '2026-10-24', 'two', 'SYN-TWO')];
  assert.throws(() => planBatchCancel(conflicted, source, [id]), /SOURCE_CHANGED/);
  assert.notEqual(planBatchCancel(values, source, [id]).preview.digest,
    planBatchCancel([HEADERS, roomNight('101', '2026-10-24', 'one', 'SYN-ONE', 'done')], source, [id]).preview.digest);
});

test('a quarantined room night in the same formal order blocks the whole deletion', () => {
  const values = [HEADERS,
    roomNight('101', '2026-10-24', 'valid', 'SYN-PARENT'),
    roomNight('102', '2026-10-25', 'unchecked', 'SYN-PARENT')];
  values[2][8] = 'pending';
  assert.throws(() => planBatchCancel(values, source, [snapshotIds(values)[0]]), /SOURCE_CONFLICT/);
});

test('commit checks source and finance, removes only selected rows, then verifies authoritative readback', async () => {
  let values = [HEADERS,
    roomNight('101', '2026-10-24', 'delete-one', 'SYN-ONE'),
    roomNight('102', '2026-10-24', 'keep-one', 'SYN-TWO')];
  const ids = snapshotIds(values), digest = planBatchCancel(values, source, [ids[0]]).preview.digest;
  const calls = [];
  const deps = {
    read: async () => { calls.push('read'); return values; },
    assertNoFinancialLinks: async (property, orders) => { calls.push('finance'); assert.equal(property, source.property.id); assert.equal(orders.length, 1); },
    remove: async (_, rows) => { calls.push('remove'); values = expectedAfterDelete(values, rows); },
  };
  const result = await commitBatchCancel(source, [ids[0]], digest, false, deps);
  assert.equal(result.preview.roomNightCount, 1);
  assert.deepEqual(calls, ['read', 'finance', 'read', 'remove', 'read']);
  assert.equal(snapshotIds(values)[0], ids[1]);
  values[1][6] = '3000';
  await assert.rejects(commitBatchCancel(source, [ids[1]], planBatchCancel([HEADERS, roomNight('102', '2026-10-24', 'keep-one', 'SYN-TWO')], source, [ids[1]]).preview.digest, false, deps), /SOURCE_CHANGED/);
  assert.deepEqual(calls, ['read', 'finance', 'read', 'remove', 'read', 'read']);
});

test('commit blocks partial orders, paid rows without acknowledgement, finance links and failed readback', async () => {
  let values = [HEADERS,
    roomNight('101', '2026-10-24', 'part-one', 'SYN-PARENT', 'done'),
    roomNight('101', '2026-10-25', 'part-two', 'SYN-PARENT', 'done')];
  const ids = snapshotIds(values), partial = planBatchCancel(values, source, [ids[0]]);
  const all = planBatchCancel(values, source, ids);
  const deps = { read: async () => values, remove: async () => { throw Error('SHOULD_NOT_WRITE'); }, assertNoFinancialLinks: async () => {} };
  await assert.rejects(commitBatchCancel(source, [ids[0]], partial.preview.digest, true, deps), /PARTIAL_ORDER/);
  await assert.rejects(commitBatchCancel(source, ids, all.preview.digest, false, deps), /PAID_ACK_REQUIRED/);
  await assert.rejects(commitBatchCancel(source, ids, all.preview.digest, true,
    {...deps, assertNoFinancialLinks: async () => { throw Error('FINANCIAL_LINKS'); }}), /FINANCIAL_LINKS/);
  await assert.rejects(commitBatchCancel(source, ids, all.preview.digest, true,
    {...deps, remove: async () => {} }), /WRITE_UNCONFIRMED/);
});

test('a Sheet edit while finance is checked stops before deletion', async () => {
  let values = [HEADERS, roomNight('201', '2026-10-24', 'race-one', 'SYN-RACE')];
  const ids = snapshotIds(values), digest = planBatchCancel(values, source, ids).preview.digest;
  let removed = false;
  await assert.rejects(commitBatchCancel(source, ids, digest, false, {
    read: async () => values,
    assertNoFinancialLinks: async () => { values = [HEADERS, roomNight('201', '2026-10-24', 'race-one', 'SYN-RACE', 'done')]; },
    remove: async () => { removed = true; },
  }), /SOURCE_CHANGED/);
  assert.equal(removed, false);
});
