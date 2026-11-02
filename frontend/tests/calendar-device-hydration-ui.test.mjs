import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, useEffect } from 'react';
import { mount } from './helpers/customer-dom.mjs';
import { useCalendarData } from '../src/components/calendar/use-calendar-data.ts';
import { useCalendarPreloadAnchor } from '../src/components/calendar/use-calendar-preload-anchor.ts';
import { sixMonthPrefetchRanges } from '../src/components/calendar/calendar-prefetch.ts';
import { addMonths } from '../src/components/calendar/calendar-utils.ts';
import { validCalendarResponse } from '../src/components/calendar/calendar-retention.ts';
import { clearCalendarDeviceCache, createCalendarDeviceScope, loadCalendarDeviceWindows, saveCalendarDeviceWindow } from '../src/lib/calendar-device-cache.ts';

// Minimal asynchronous IndexedDB surface exercises the real module boundary;
// cache format, scope validation, and restore/save logic remain production code.
let rows = [], readDelay = 0;
const priorIndexedDb = globalThis.indexedDB;
const database = {
  close() {},
  transaction(_store, mode) {
    const tx = { objectStore() { return {
      getAll() {
        const request = {};
        setTimeout(() => {
          request.result = structuredClone(rows); request.onsuccess?.();
          queueMicrotask(() => tx.oncomplete?.());
        }, mode === 'readonly' ? readDelay : 0);
        return request;
      },
      clear() { rows = []; }, put(row) { rows.push(structuredClone(row)); },
    }; }, abort() { tx.onabort?.(); } };
    return tx;
  },
};
globalThis.indexedDB = { open() {
  const request = { result: database };
  queueMicrotask(() => request.onsuccess?.()); return request;
} };
after(() => { globalThis.indexedDB = priorIndexedDb; });
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const range = { start: '2026-10-01', end: '2026-11-01' };
const snapshot = name => ({ period_start: range.start, period_end: range.end,
  properties: [{ id: 'sweetfun', name: 'Synthetic' }], rooms: [{ id: '101', property_id: 'sweetfun' }],
  source: { private_snapshot_version: '10' }, bookings: [{ id: 'synthetic-stay', order_id: 'synthetic-order',
    property_id: 'sweetfun', room_id: '101', guest_name: name,
    check_in: '2026-10-15', check_out: '2026-10-16', payment_status: name === 'SYNTHETIC_OLD' ? 'unpaid' : 'paid' }] });
async function seed() {
  readDelay = 0;
  await clearCalendarDeviceCache({ notify: false, broadcast: false });
  const scope = createCalendarDeviceScope({ initialized: true, sessionVerifiedAt: Date.now(), membership: {
    id: 'synthetic-member', tenantId: 'synthetic-tenant', role: 'owner', status: 'active', allProperties: true,
    propertyIds: ['sweetfun', 'offland'],
  } }, { properties: ['sweetfun'], viewPrices: true });
  assert.ok(scope);
  await saveCalendarDeviceWindow(scope, 'bookings', '', { ...range, data: snapshot('SYNTHETIC_OLD') }, validCalendarResponse);
  return scope;
}
async function view(t, deviceScope) {
  let state; const attempts = [];
  const read = (start, end, base) => new Promise(resolve => attempts.push({ start, end, base, resolve }));
  const onProperties = () => {}, onAccessLost = () => {};
  function Probe() {
    const value = useCalendarData({ ...range, scope: 'owner:sweetfun', reload: 0, deviceScope, read, onProperties, onAccessLost });
    useEffect(() => { state = value; }, [value]);
    return createElement('span', null, value.data?.bookings[0]?.guest_name ?? 'loading');
  }
  await mount(t, Probe);
  return { attempts, get state() { return state; } };
}

test('reopening shows a timestamped readonly copy while sending its exact base for changed-row verification', async t => {
  const scope = await seed();
  const screen = await view(t, scope);
  await act(async () => { await tick(10); });
  assert.equal(screen.state.fromDeviceCache, true);
  assert.equal(screen.state.refreshing, true);
  assert.ok(screen.state.lastLoadedAt instanceof Date);
  assert.equal(screen.state.data.bookings[0].snapshot_only, true);
  assert.equal(screen.attempts.length, 1, 'cached data does not suppress the current server read');
  assert.equal(screen.attempts[0].base.bookings[0].payment_status, 'unpaid');
  await act(async () => { screen.attempts[0].resolve(snapshot('SYNTHETIC_NEW')); await tick(); });
  assert.equal(screen.state.fromDeviceCache, false);
  assert.equal(screen.state.data.bookings[0].guest_name, 'SYNTHETIC_NEW');
  assert.equal(screen.state.data.bookings[0].payment_status, 'paid', 'same inventory version still accepts a changed payment');
  assert.equal(screen.state.data.bookings[0].snapshot_only, undefined);
});

test('slow device storage cannot delay the network beyond its short budget or overwrite a newer live response', async t => {
  const scope = await seed(); readDelay = 260;
  const screen = await view(t, scope);
  await act(async () => { await tick(160); });
  assert.equal(screen.attempts.length, 1);
  assert.equal(screen.attempts[0].base, undefined, 'storage timeout falls back to a normal full server read');
  await act(async () => { screen.attempts[0].resolve(snapshot('SYNTHETIC_NEW')); await tick(); });
  await act(async () => { await tick(140); });
  assert.equal(screen.state.fromDeviceCache, false);
  assert.equal(screen.state.data.bookings[0].guest_name, 'SYNTHETIC_NEW');
  readDelay = 0;
});

test('logout clears both the displayed copy and verified memory; a pending read cannot restore names', async t => {
  const scope = await seed();
  const screen = await view(t, scope);
  await act(async () => { await tick(10); });
  assert.ok(document.body.textContent.includes('SYNTHETIC_OLD'));
  await act(async () => { await clearCalendarDeviceCache({ broadcast: false }); await tick(); });
  assert.equal(screen.state.data, null);
  assert.ok(!document.body.textContent.includes('SYNTHETIC'));
  await act(async () => { screen.attempts[0].resolve(snapshot('SYNTHETIC_NEW')); await tick(); });
  assert.equal(screen.state.data, null);
  assert.ok(!document.body.textContent.includes('SYNTHETIC'));
  assert.equal(rows.length, 0);
});

test('browsing all six preloaded months retains the original opening month in device storage', async t => {
  const deviceScope = await seed();
  let state; const attempts = [];
  const read = (start, end) => new Promise(resolve => attempts.push({ start, end, resolve }));
  const onProperties = () => {}, onAccessLost = () => {};
  function Probe({ month }) {
    const fixed = useCalendarPreloadAnchor(month, 'owner:sweetfun:0');
    const value = useCalendarData({ start: month, end: addMonths(month, 1), scope: 'owner:sweetfun',
      reload: 0, deviceScope, prefetch: sixMonthPrefetchRanges(fixed), read, onProperties, onAccessLost });
    useEffect(() => { state = value; }, [value]);
    return createElement('span', null, value.loading ? 'loading' : 'ready');
  }
  const { root } = await mount(t, Probe, { month: '2026-10-01' });
  await act(async () => { await tick(10); });
  const finish = async attempt => {
    const data = snapshot('SYNTHETIC_NEW');
    data.period_start = attempt.start; data.period_end = attempt.end;
    data.bookings = data.bookings.filter(booking => booking.check_in < attempt.end && booking.check_out > attempt.start);
    await act(async () => { attempt.resolve(data); await tick(10); });
  };
  await finish(attempts[0]);
  for (const attempt of attempts.slice(1)) await finish(attempt);
  assert.equal(attempts.length, 4);
  for (let offset = 1; offset < 6; offset++) {
    await act(async () => { root.render(createElement(Probe, { month: addMonths('2026-10-01', offset) })); await tick(); });
    assert.equal(state.loading, false);
  }
  assert.equal(attempts.length, 4, 'navigation cannot fill the device cache with unrequested future horizons');
  const saved = await loadCalendarDeviceWindows(deviceScope, 'bookings', '', validCalendarResponse);
  assert.equal(saved.length, 4);
  assert.ok(saved.some(item => item.start === '2026-10-01' && item.end === '2026-11-01'));
  assert.ok(saved.every(item => item.start >= '2026-10-01' && item.end <= '2027-04-01'));
});
