import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { mount } from './helpers/customer-dom.mjs';
process.env.NEXT_PUBLIC_CALENDAR_SOURCE = 'sheet_snapshot';
process.env.NEXT_PUBLIC_DEMO_MODE = 'true';
process.env.NEXT_PUBLIC_PAYMENT_SANDBOX = 'false';
const { useAccessControl } = await import('../src/lib/access-control.ts');
const { BookingCalendarResponsive } = await import('../src/components/calendar/booking-calendar-responsive.tsx');
const { useCalendarPreferences } = await import('../src/components/calendar/calendar-preferences.ts');
const { createCalendarDelta } = await import('../src/lib/calendar-sync.ts');
let rows = [];
const oldIndexedDb = globalThis.indexedDB;
const database = { close() {}, transaction() {
  const tx = { objectStore() { return { getAll() { const request = {}; setTimeout(() => {
    request.result = structuredClone(rows); request.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.());
  }, 0); return request; }, clear() { rows = []; }, put(row) { rows.push(structuredClone(row)); } }; }, abort() { tx.onabort?.(); } };
  return tx;
} };
globalThis.indexedDB = { open() { const request = { result: database }; queueMicrotask(() => request.onsuccess?.()); return request; } };
after(() => { globalThis.indexedDB = oldIndexedDb; });
const member = { id: 'calendar-owner', tenantId: 'sweetfun-workspace', tenantName: 'Synthetic', displayName: 'Synthetic',
  role: 'owner', status: 'active', allProperties: true, propertyIds: ['sweetfun', 'offland'], email: null, phone: null };
const session = { available: true, authenticated: true, membership: member };
const snapshot = (start, end) => ({ year: 2026, month: 10, month_start: start, month_end: end,
  period_start: start, period_end: end, properties: [], rooms: [], bookings: [], order_count: 0, booking_segment_count: 0,
  total_amount: 0, source: { kind: 'iron_gate', label: 'Synthetic', observed_at: new Date().toISOString(), private_snapshot_version: '9', read_only: true } });
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

test('the mounted live calendar saves and restores device data even when the legacy demo flag remains true', async t => {
  let gets = 0, syncs = 0, finishSync;
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(String(input), 'https://operations.test');
    if (url.pathname.endsWith('/bookings/calendar/sync')) {
      syncs++;
      const body = JSON.parse(options.body);
      return new Promise(resolve => { finishSync = async () => resolve(Response.json(await createCalendarDelta(body.manifest, snapshot(body.manifest.start, body.manifest.end)))); });
    }
    if (url.pathname.endsWith('/bookings/calendar')) { gets++; return Response.json(snapshot(url.searchParams.get('start'), url.searchParams.get('end'))); }
    if (url.pathname === '/api/calendar-session') return Response.json(session);
    if (url.pathname.includes('guest-notification')) return Response.json({ states: {}, can_write: false });
    if (url.pathname.includes('revision')) return Response.json({ revision: '9' });
    return Response.json({});
  });
  useAccessControl.getState().bootstrap(session);
  useCalendarPreferences.setState({ mode: 'sold', view: 'day', selectedPropertyIds: [], searchQuery: '' });
  const first = await mount(t, BookingCalendarResponsive, {}, '?view=day');
  await act(async () => { await tick(50); });
  assert.equal(gets, 1);
  assert.ok(rows.some(row => row.kind === 'bookings'), 'live reads must save despite the leftover demo flag');
  await act(() => first.root.unmount());
  useAccessControl.getState().bootstrap(session);
  const second = await mount(t, BookingCalendarResponsive, {}, '?view=day');
  await act(async () => { await tick(50); });
  assert.equal(syncs, 1, 'reopening uses the saved exact base for a delta request');
  assert.equal(gets, 1, 'reopening does not issue another full request');
  assert.match(document.body.textContent, /先顯示此裝置上次讀取的資料/);
  await act(async () => { await finishSync(); await tick(10); });
  await act(() => second.root.unmount());
});
