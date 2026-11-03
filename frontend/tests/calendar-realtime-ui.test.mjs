import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, useCallback, useEffect, useState } from 'react';
import { mount } from './helpers/customer-dom.mjs';
import { useCalendarRealtime } from '../src/components/calendar/use-calendar-realtime.ts';
import { useCalendarData } from '../src/components/calendar/use-calendar-data.ts';
import { useAvailabilityData } from '../src/components/calendar/use-availability-data.ts';

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const settle = () => act(async () => { await tick(230); });

function streams(t) {
  const instances = [];
  const prior = globalThis.EventSource;
  globalThis.EventSource = class {
    constructor(url) { this.url = url; this.closed = false; this.listeners = new Map(); instances.push(this); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    close() { this.closed = true; }
    emit(name, value) { this.listeners.get(name)?.({ data: typeof value === 'string' ? value : JSON.stringify(value) }); }
  };
  t.after(() => { globalThis.EventSource = prior; });
  return instances;
}
function visibility() {
  let hidden = false, online = true;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  return {
    async show(value) { await act(() => { hidden = !value; document.dispatchEvent(new Event('visibilitychange')); }); },
    async online(value) { await act(() => { online = value; window.dispatchEvent(new Event(value ? 'online' : 'offline')); }); },
  };
}

test('ready and a burst of property changes reconcile once, without reconnecting during the resulting read', async t => {
  const events = streams(t);
  let reloads = 0;
  const changed = () => { reloads++; };
  function Probe({ busy = false }) {
    useCalendarRealtime({ properties: 'offland,sweetfun', scope: 'owner', enabled: true, busy, changed });
    return createElement('span', null, 'calendar');
  }
  const { root } = await mount(t, Probe);
  const screen = visibility(); await screen.show(true);
  assert.equal(events.length, 1);
  assert.equal(events[0].url, '/api/v1/calendar/stream?properties=offland%2Csweetfun');
  await act(() => {
    events[0].emit('ready', { properties: ['sweetfun', 'offland'] });
    events[0].emit('change', { property: 'sweetfun', revision: 'v1' });
    events[0].emit('change', { property: 'sweetfun', revision: 'v2' });
    events[0].emit('change', { property: 'offland', revision: 'v3' });
  });
  await settle(); assert.equal(reloads, 1);
  await act(() => root.render(createElement(Probe, { busy: true })));
  await act(() => {
    events[0].emit('change', { property: 'sweetfun', revision: 'v4' });
    events[0].emit('change', { property: 'sweetfun', revision: 'v5' });
  });
  await settle(); assert.equal(reloads, 1, 'changes wait for the active read');
  await act(() => root.render(createElement(Probe, { busy: false })));
  await settle(); assert.equal(reloads, 2, 'one trailing read covers all changes received while busy');
  assert.equal(events.length, 1); assert.equal(events[0].closed, false);
  await act(() => {
    events[0].emit('ready', { properties: ['sweetfun', 'offland'] });
    events[0].emit('change', { property: 'sweetfun', revision: 'v5' });
    events[0].emit('change', { property: 'other', revision: 'v6' });
    events[0].emit('change', { property: 'sweetfun', revision: {} });
    events[0].emit('change', 'not-json');
  });
  await settle(); assert.equal(reloads, 2, 'duplicates and malformed/cross-property events do not refresh');
  await act(() => events[0].emit('change', { property: 'sweetfun', revision: 'v1' }));
  await settle(); assert.equal(reloads, 3, 'a lower cursor can belong to a later commit; only equality is deduplicated');
});

test('scope change closes the old stream and discards its queued refresh and late messages', async t => {
  const events = streams(t); let reloads = 0;
  const changed = () => { reloads++; };
  function Probe({ scope = 'member-a', properties = 'sweetfun', enabled = true }) {
    useCalendarRealtime({ properties, scope, enabled, busy: false, changed });
    return null;
  }
  const { root } = await mount(t, Probe);
  const screen = visibility(); await screen.show(true);
  await act(() => events[0].emit('ready', { properties: ['sweetfun'] }));
  await act(() => root.render(createElement(Probe, { scope: 'member-b', properties: 'offland' })));
  assert.equal(events[0].closed, true); assert.equal(events.length, 2);
  await act(() => {
    events[0].emit('change', { property: 'sweetfun', revision: 'v8' });
    events[1].emit('ready', { properties: ['sweetfun'] });
  });
  await settle(); assert.equal(reloads, 0);
  await act(() => events[1].emit('ready', { properties: ['offland'] }));
  await settle(); assert.equal(reloads, 1);
  await act(() => root.render(createElement(Probe, { enabled: false })));
  assert.equal(events[1].closed, true);
});

test('hidden/offline screens close the stream and every successful reconnect reconciles missed changes', async t => {
  const events = streams(t); let reloads = 0;
  const changed = () => { reloads++; };
  function Probe() {
    useCalendarRealtime({ properties: 'sweetfun', scope: 'owner', enabled: true, busy: false, changed });
    return null;
  }
  await mount(t, Probe);
  const screen = visibility(); await screen.show(true);
  await act(() => events[0].emit('ready', { properties: ['sweetfun'] }));
  await settle(); assert.equal(reloads, 1);
  await screen.show(false); assert.equal(events[0].closed, true);
  await act(() => events[0].emit('change', { property: 'sweetfun', revision: 'v9' }));
  await settle(); assert.equal(reloads, 1);
  await screen.show(true); assert.equal(events.length, 2);
  await act(() => events[1].emit('ready', { properties: ['sweetfun'] }));
  await settle(); assert.equal(reloads, 2);
  await screen.online(false); assert.equal(events[1].closed, true);
  await act(() => window.dispatchEvent(new Event('focus'))); assert.equal(events.length, 2);
  await screen.online(true); assert.equal(events.length, 3);
  await act(() => events[2].emit('ready', { properties: ['sweetfun'] }));
  await settle(); assert.equal(reloads, 3);
  await act(() => events[2].emit('error', {})); assert.equal(events[2].closed, true);
  await act(async () => { await tick(1050); }); assert.equal(events.length, 4);
  await act(() => events[3].emit('ready', { properties: ['sweetfun'] }));
  await settle(); assert.equal(reloads, 4);
});

test('revocation requests authorized access-loss readback and stays closed until the account scope changes', async t => {
  const events = streams(t); let reloads = 0;
  const changed = () => { reloads++; };
  function Probe({ scope = 'member-a', busy = true }) {
    useCalendarRealtime({ properties: 'sweetfun', scope, enabled: true, busy, changed });
    return null;
  }
  const { root } = await mount(t, Probe);
  const screen = visibility(); await screen.show(true);
  await act(() => events[0].emit('revoked', {}));
  assert.equal(events[0].closed, true);
  await settle(); assert.equal(reloads, 0);
  await act(() => root.render(createElement(Probe, { busy: false })));
  await settle(); assert.equal(reloads, 1);
  await screen.show(false); await screen.show(true);
  await screen.online(false); await screen.online(true);
  await act(() => events[0].emit('error', {}));
  assert.equal(events.length, 1, 'focus, network and old stream callbacks cannot reopen revoked access');
  await act(() => root.render(createElement(Probe, { scope: 'member-b', busy: false })));
  assert.equal(events.length, 2);
});

const range = { start: '2026-10-01', end: '2026-11-01' };
const sold = (version, cancelled = false) => ({
  period_start: range.start, period_end: range.end, properties: [], rooms: [],
  source: { private_snapshot_version: String(version) },
  bookings: cancelled ? [] : [{ id: 'synthetic', order_id: 'synthetic', property_id: 'sweetfun', room_id: '101',
    guest_name: `SYNTHETIC_${version}`, check_in: '2026-10-15', check_out: '2026-10-16' }],
});

test('a change during a slow sold read is retained and cancellation becomes visible after one trailing read', async t => {
  const events = streams(t), attempts = [];
  const read = () => new Promise(resolve => attempts.push(resolve));
  const onProperties = () => {}, onAccessLost = () => {};
  function Probe() {
    const [reload, setReload] = useState(0);
    const changed = useCallback(() => setReload(value => value + 1), []);
    const data = useCalendarData({ ...range, scope: 'owner', reload, read, onProperties, onAccessLost });
    useCalendarRealtime({ properties: 'sweetfun', scope: 'owner', enabled: true,
      busy: data.loading || data.refreshing, changed });
    return createElement('span', null, data.data ? data.data.bookings.length ? data.data.bookings[0].guest_name : 'no bookings' : 'loading');
  }
  await mount(t, Probe); const screen = visibility(); await screen.show(true);
  await act(() => {
    events[0].emit('ready', { properties: ['sweetfun'] });
    events[0].emit('change', { property: 'sweetfun', revision: 'cancelled:2' });
  });
  await settle(); assert.equal(attempts.length, 1);
  await act(async () => { attempts[0](sold(1)); await tick(); });
  await settle(); assert.equal(attempts.length, 2);
  await act(async () => { attempts[1](sold(2, true)); await tick(); });
  assert.equal(document.body.textContent, 'no bookings');
  await settle(); assert.equal(attempts.length, 2); assert.equal(events.length, 1);
});

test('unsold reads without a saved device copy keep the same stream through every refresh', async t => {
  const events = streams(t), attempts = [];
  const query = { ...range, rooms: [], channel: 'direct', demo_cycle: 1 };
  const read = requested => new Promise(resolve => attempts.push({ requested, resolve }));
  const onProperties = () => {}, onAccessLost = () => {};
  let state;
  function Probe() {
    const [reload, setReload] = useState(0);
    const changed = useCallback(() => setReload(value => value + 1), []);
    const data = useAvailabilityData({ query, property: 'sweetfun', scope: 'owner', reload,
      preload: false, read, onProperties, onAccessLost });
    useEffect(() => { state = data; }, [data]);
    useCalendarRealtime({ properties: 'sweetfun', scope: 'owner', enabled: true,
      busy: data.loading || data.refreshing, changed });
    return null;
  }
  await mount(t, Probe); const screen = visibility(); await screen.show(true);
  const finish = async (index, version) => act(async () => {
    const cells = Array.from({ length: 31 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, '0')}`,
      room: '101', state: 'available', reason: 'synthetic' }));
    attempts[index].resolve({ status: 'ok', mode: 'live', property_id: 'sweetfun', query, rooms: ['101'], cells,
      snapshot_id: `v${version}`, asof: new Date().toISOString(), counts: {}, price_hidden: false,
      continuous_windows: [], source_notice: '', inventory_source: { kind: 'iron_gate', inventory_version: version, authority_epoch: 1, observed_at: new Date().toISOString() } });
    await tick();
  });
  await act(() => events[0].emit('ready', { properties: ['sweetfun'] }));
  await finish(0, 1); await settle(); assert.equal(attempts.length, 2);
  await act(() => events[0].emit('change', { property: 'sweetfun', revision: 'v2' }));
  await settle(); assert.equal(attempts.length, 2);
  await finish(1, 2); await settle(); assert.equal(attempts.length, 3);
  await finish(2, 2); await settle();
  assert.equal(state.data.inventory_source.inventory_version, 2);
  assert.equal(attempts.length, 3); assert.equal(events.length, 1);
});
