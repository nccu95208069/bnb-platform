import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from '../../frontend/node_modules/typescript/lib/typescript.js';

const directory = mkdtempSync(join(tmpdir(), 'radar-calendar-'));
const source = readFileSync(new URL('../../frontend/src/components/competitor-radar/calendar-data.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
writeFileSync(join(directory, 'calendar.cjs'), compiled);
const { calendarDay, periodDates, weekStart, shiftMonth, summarizeCalendar, isCapacityConfirmed } = createRequire(import.meta.url)(join(directory, 'calendar.cjs'));
after(() => rmSync(directory, { recursive: true }));
const rooms = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
const inventory = { a: 2, b: 4 };
const offer = (id, quantity) => ({ canonicalRoomId: id, availability: 'available', quantityState: 'exact', quantity, amount: 1000, currency: 'TWD' });
const scan = (overrides = {}) => ({ observations: [{ stayDate: '2026-09-15', state: 'ready', identityVerified: true, dateVerified: true, rooms: [offer('a', 1), offer('b', 3)], ...overrides }] });

test('received price-only stock is visible without treating excluded prices as verified totals', () => {
  const observation = scan({state:'partial',priceReview:true,observedAt:'2026-09-15T05:00:00Z',rooms:[{...offer('a',1),amount:undefined,displayedAmount:4071,displayedPriceBasis:'tax_excluded'},{...offer('b',3),amount:undefined}]});
  const value = calendarDay('2026-09-15',observation,rooms,undefined,false,false);
  assert.equal(value.remaining,4);assert.equal(value.rate,null);assert.equal(value.rooms[0].amount,undefined);assert.equal(value.rooms[0].displayedAmount,4071);assert.equal(value.observedAt,'2026-09-15T05:00:00Z');
  assert.equal(value.state, '容量待確認');
});
test('a missing received room leaves total remaining unknown while exposing only the observed subtotal', () => {
  const value = calendarDay('2026-09-15',scan({state:'partial',rooms:[offer('a',1)],roomIssues:{b:'未列出・保持未知'}}),rooms,undefined,false,false);
  assert.equal(value.remaining,null);assert.equal(value.observedRemaining,1);assert.equal(value.unknownRooms,1);assert.equal(value.rate,null);
  assert.equal(value.state, '容量待確認');
  const summary=summarizeCalendar([value]);assert.equal(summary.observedRemainingNights,1);assert.equal(summary.rate,null);assert.equal(summary.completeDays,0);
});

test('calendar periods cover an entire leap month and Monday-aligned weeks across years', () => {
  assert.equal(periodDates('2028-02-20', 'month').length, 29);
  assert.equal(periodDates('2026-09-15', 'month').length, 30);
  assert.equal(weekStart('2027-01-01'), '2026-12-28');
  assert.equal(periodDates('2027-01-01', 'week').at(-1), '2027-01-03');
  assert.equal(shiftMonth('2026-12-31', 1), '2027-01-01');
});

test('unobserved dates never become zero stock or 100% depleted', () => {
  const value = calendarDay('2026-09-16', scan(), rooms, inventory, true, true);
  assert.equal(value.remaining, null);
  assert.equal(value.rate, null);
  assert.equal(value.state, '未抓取');
});

test('unlisted zero applies only to verified pages with the explicit user policy', () => {
  const source = scan({ rooms: [offer('a', 1)], roomIssues: { b: '未列出' } });
  assert.equal(calendarDay('2026-09-15', source, rooms, inventory, true, true).remaining, 1);
  assert.equal(calendarDay('2026-09-15', source, rooms, inventory, false, true).remaining, null);
  const blocked = scan({ state: 'blocked', rooms: [], roomIssues: { a: '未列出', b: '未列出' } });
  assert.equal(calendarDay('2026-09-15', blocked, rooms, inventory, true, true).rate, null);
});

test('null, capped, conflicting quantities and over-capacity stock do not yield a rate', () => {
  for (const item of [{ ...offer('a', undefined) }, { ...offer('a', 1), quantityState: 'capped' }, offer('a', 3)]) {
    assert.equal(calendarDay('2026-09-15', scan({ rooms: [item, offer('b', 3)] }), rooms, inventory, true, true).rate, null);
  }
  const duplicate = scan({ rooms: [offer('a', 1), offer('a', 2), offer('b', 3)] });
  assert.equal(calendarDay('2026-09-15', duplicate, rooms, inventory, true, true).remaining, null);
});

test('rate plans share stock and explicit all-room unavailability is zero', () => {
  const duplicate = scan({ rooms: [offer('a', 1), offer('a', 1), offer('b', 3)] });
  assert.equal(calendarDay('2026-09-15', duplicate, rooms, inventory, true, true).remaining, 4);
  const unavailable = scan({ rooms: rooms.map(room => ({ canonicalRoomId: room.id, availability: 'sold_out' })) });
  assert.equal(calendarDay('2026-09-15', unavailable, rooms, inventory, true, true).rate, 100);
});

test('period summary weights room-nights and excludes unknown dates', () => {
  const summary = summarizeCalendar([
    { total: 10, remaining: 9, depleted: 1 },
    { total: 30, remaining: 3, depleted: 27 },
    { total: 20, remaining: null, depleted: null },
  ]);
  assert.equal(summary.rate, 70);
  assert.equal(summary.completeDays, 2);
  assert.equal(summary.requestedDays, 3);
  assert.equal(summarizeCalendar([{ total: 25, remaining: null, depleted: null }]).rate, null);
});

test('isCapacityConfirmed only accepts explicit confirmed', () => {
  assert.equal(isCapacityConfirmed('confirmed'), true);
  assert.equal(isCapacityConfirmed('unconfirmed'), false);
  assert.equal(isCapacityConfirmed('pending'), false);
  assert.equal(isCapacityConfirmed('draft'), false); // not a RadarImport status; still must not unlock rates
  assert.equal(isCapacityConfirmed(undefined), false);
  assert.equal(isCapacityConfirmed(null), false);
});

test('unconfirmed capacity: inventory present by mistake still yields no rates/heat inputs', () => {
  // capacityConfirmed=false must ignore inventory even if caller forgot to strip it
  const value = calendarDay('2026-09-15', scan(), rooms, inventory, false, false);
  assert.equal(value.total, null);
  assert.equal(value.rate, null);
  assert.equal(value.depleted, null);
  assert.equal(value.capacityConfirmed, false);
  assert.equal(value.state, '容量待確認');
  assert.equal(value.observedRemaining, 4); // known remaining still visible
  assert.equal(value.unknownRooms, 0);
  const summary = summarizeCalendar([value]);
  assert.equal(summary.rate, null);
  assert.equal(summary.completeDays, 0);
});

test('confirmed complete day: sell-through rate and totals from full roomInventory', () => {
  const value = calendarDay('2026-09-15', scan(), rooms, inventory, false, true);
  assert.equal(value.total, 6);
  assert.equal(value.remaining, 4);
  assert.equal(value.depleted, 2);
  assert.equal(value.rate, (2 / 6) * 100);
  assert.equal(value.state, '已核對');
  assert.equal(value.capacityConfirmed, true);
  assert.equal(value.unknownRooms, 0);
  const summary = summarizeCalendar([value]);
  assert.equal(summary.completeDays, 1);
  assert.ok(summary.rate !== null);
});

test('confirmed day with unknown room: rate null and N 房型未知', () => {
  const value = calendarDay(
    '2026-09-15',
    scan({ state: 'partial', rooms: [offer('a', 1)], roomIssues: { b: '未列出・保持未知' } }),
    rooms,
    inventory,
    false, // assumeUnlisted false — unknown ≠ 0
    true,
  );
  assert.equal(value.total, 6);
  assert.equal(value.remaining, null);
  assert.equal(value.rate, null);
  assert.equal(value.observedRemaining, 1);
  assert.equal(value.unknownRooms, 1);
  assert.equal(value.state, '1 房型未知');
  assert.equal(value.rooms[1].remaining, null);
});

test('no observation stays 未抓取 even when capacity confirmed', () => {
  const value = calendarDay('2026-09-16', scan(), rooms, inventory, false, true);
  assert.equal(value.state, '未抓取');
  assert.equal(value.rate, null);
  assert.equal(value.remaining, null);
  assert.equal(value.observedRemaining, null);
  assert.equal(value.total, 6); // capacity known, but day not scraped
});

test('over-capacity room nulls that room and day rate', () => {
  const value = calendarDay('2026-09-15', scan({ rooms: [offer('a', 3), offer('b', 3)] }), rooms, inventory, false, true);
  assert.equal(value.rooms[0].remaining, null);
  assert.equal(value.rooms[0].state, '超出容量・待核對');
  assert.equal(value.rate, null);
  assert.equal(value.remaining, null);
});

test('incomplete inventory (missing catalog room id) never yields rate', () => {
  const value = calendarDay('2026-09-15', scan(), rooms, { a: 2 }, false, true);
  assert.equal(value.total, null);
  assert.equal(value.rate, null);
  assert.equal(value.state, '容量待確認');
  assert.equal(value.capacityConfirmed, false);
});

test('non-positive inventory units never yield rate', () => {
  const value = calendarDay('2026-09-15', scan(), rooms, { a: 2, b: 0 }, false, true);
  assert.equal(value.total, null);
  assert.equal(value.rate, null);
});
