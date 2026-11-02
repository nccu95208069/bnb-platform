import test from 'node:test';
import assert from 'node:assert/strict';
import { readCalendarSources } from '../src/lib/booking-sources/calendar-reader.ts';
import { SourceReadError } from '../src/lib/sheet-monitor/google.ts';
import { SWEETFUN_SOURCE } from '../src/lib/booking-sources/config.ts';
import { adaptSheetBookings } from '../src/lib/booking-sources/sweetfun-sheet.ts';
import { HEADERS, initialState, reconcile, publicSnapshot } from '../src/lib/sheet-monitor/reconcile.ts';
import { runMonitor } from '../src/lib/sheet-monitor/runner.ts';
import { hasCalendarCoverage, retainedCalendar, validCalendarResponse } from '../src/components/calendar/calendar-retention.ts';

const a = SWEETFUN_SOURCE, b = { ...a, key: 'fixture', sourceId: 'fixture-source', property: { id: 'fixture', name: 'Fixture', sourceLabel: 'Fixture', rooms: [{ id: 'fixture-room', number: '301' }] } };
const row = (id, date) => ['301', 'SYNTHETIC_NAME', 'Agoda', date, new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10), '2026-08-01', '2500', 'done', 'OK', id, 'SYNTHETIC_NOTE', 'parent'];
const values = [HEADERS, row('one', '2026-09-30'), row('two', '2026-10-01')];
function snapshot(source = a) {
  const s = adaptSheetBookings(values, source.sourceId, '2026-10-01T00:00:00Z', [], undefined, source.property);
  s.source.sync = { status: 'healthy', last_successful_check_at: '2026-10-01T00:00:00Z' };
  return s;
}
const defaults = { snapshot: async source => snapshot(source), details: async () => values, payments: async rows => rows };
const read = (deps, sources = [a, b], viewPrices = true) => readCalendarSources(sources, '2026-10-01', '2026-11-01', viewPrices, { ...defaults, ...deps });

test('429 names failure on one property preserves both occupancy snapshots and another property’s private details', async () => {
  const events = [];
  const result = await read({ details: async source => { if (source === a) throw new SourceReadError('MONITOR_GOOGLE_READ', 429); return values; }, report: e => events.push(e) });
  assert.equal(result.bookings.length, 4);
  const rows = result.bookings.filter(b => b.property_id === a.property.id);
  assert.ok(rows.every(b => b.snapshot_only && b.guest_name_kind === 'missing' && b.source_notes_unconfirmed));
  assert.ok(rows.every(b => !JSON.stringify(b).includes('SYNTHETIC_')));
  assert.equal(result.bookings.find(row => row.property_id === 'fixture').guest_name, 'SYNTHETIC_NAME');
  assert.equal(result.errors.length, 0);
  assert.equal(events.find(e => e.status === 'error').http_status, 429);
  assert.equal(JSON.stringify(events).includes('SYNTHETIC_'), false);
});
test('timeouts are bounded, return occupancy for a first page load, and ignore late completions', async () => {
  let finish;
  const result = await read({ timeoutMs: 10, details: async () => new Promise(resolve => { finish = resolve; }) }, [a]);
  assert.equal(result.bookings.length, 2);
  assert.equal(result.bookings[0].guest_name_kind, 'missing');
  finish(values); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(result.bookings[0].guest_name_kind, 'missing');
});
test('a failed snapshot is explicit and never creates available inventory; total failure throws', async () => {
  const deps = { snapshot: async source => source === a ? null : snapshot(source) };
  const result = await read(deps);
  assert.equal(result.bookings.length, 2); assert.equal(result.errors[0].property_id, 'sweetfun');
  await assert.rejects(() => read({ snapshot: async () => null }), /CALENDAR_SOURCES_UNAVAILABLE/);
});
test('payment failure removes paid claims only in the affected property, without removing names or nights', async () => {
  const result = await read({ payments: async rows => { if (rows[0].property_id === 'sweetfun') throw Error('STORE_UNAVAILABLE'); return rows; } });
  assert.ok(result.bookings.filter(b => b.property_id === 'sweetfun').every(b => b.payment_status === 'unknown' && b.payment_unconfirmed && b.snapshot_only && b.guest_name === 'SYNTHETIC_NAME'));
  assert.ok(result.bookings.filter(b => b.property_id === 'fixture').every(b => b.payment_status === 'paid' && !b.payment_unconfirmed));
  let reads = 0; await read({ payments: async () => { reads++; throw Error(); } }, [a], false); assert.equal(reads, 0);
});
test('empty or malformed details do not erase occupancy or attach private data', async () => {
  for (const bad of [[], [HEADERS], [['bad'], ['row']]]) {
    const result = await read({ details: async () => bad }, [a]);
    assert.equal(result.bookings.length, 2); assert.equal(result.warnings[0].phase, 'guest_details');
  }
});
test('unconfirmed source revisions and old monitor snapshots remain readonly', async () => {
  const result = await read({ details: async () => [HEADERS, row('moved', '2026-10-01')] }, [a]);
  assert.ok(result.bookings.every(b => b.snapshot_only && b.source_notes_unconfirmed));
  for (const status of ['error', 'stale', 'waiting', 'confirming']) {
    const stale = snapshot(); stale.source.sync.status = status;
    const r = await read({ snapshot: async () => stale }, [a]);
    assert.ok(r.bookings.every(b => b.snapshot_only)); assert.equal(r.warnings[0].phase, 'snapshot');
  }
});
test('last successful verification is not advanced by failed or pending reads', async () => {
  const t0 = '2026-10-01T00:00:00Z', t1 = '2026-10-01T00:01:00Z', t2 = '2026-10-01T00:02:00Z';
  let state = reconcile(reconcile(initialState(snapshot()), values, t0), values, t1);
  const store = { acquire: async () => 'lock', read: async () => state, commit: async (_, next) => { state = next; return true; }, release: async () => {} };
  await runMonitor({ store, seed: async () => snapshot(), read: async () => { throw Error('MONITOR_GOOGLE_READ'); }, now: () => t2 });
  assert.equal(publicSnapshot(state, t2).source.sync.last_successful_check_at, t1);
  assert.equal(publicSnapshot(state, t2).source.sync.last_checked_at, t2);
  const changed = [HEADERS, row('changed', '2026-10-01')];
  assert.equal(reconcile(state, changed, t2).lastSuccessfulAt, t1);
  assert.equal(reconcile(state, values, t2).lastSuccessfulAt, t2);
});
test('retained data is readonly, and unvisited dates or malformed successes never masquerade as available rooms', () => {
  const data = { period_start: '2026-10-01', period_end: '2026-11-01', bookings: snapshot().bookings, rooms: [], properties: [] };
  assert.equal(hasCalendarCoverage(data, '2026-10-02', '2026-10-03'), true);
  assert.equal(hasCalendarCoverage(data, '2026-11-01', '2026-12-01'), false);
  assert.equal(validCalendarResponse({}, '2026-10-01', '2026-11-01'), false);
  assert.equal(validCalendarResponse({ ...data, bookings: null }, '2026-10-01', '2026-11-01'), false);
  assert.equal(validCalendarResponse(data, '2026-10-01', '2026-11-01'), true);
  assert.ok(retainedCalendar(data, true).bookings.every(b => b.snapshot_only));
  assert.equal(retainedCalendar(null, true), null);
});
