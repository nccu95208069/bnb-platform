import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, useEffect } from 'react';
import { mount } from './helpers/customer-dom.mjs';
import { useCalendarData } from '../src/components/calendar/use-calendar-data.ts';
import { hasCalendarCoverage } from '../src/components/calendar/calendar-retention.ts';
import { ApiError } from '../src/lib/api-client.ts';
const response = (start = '2026-10-01', end = '2026-11-01') => ({ period_start: start, period_end: end, properties: [], rooms: [], bookings: [{ id: 'one', property_id: 'sweetfun', room_id: '301', guest_name: 'SYNTHETIC_PRIVATE', check_in: '2026-10-07', check_out: '2026-10-08' }] });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('mounted calendar retains readonly data through retry, blocks unvisited ranges, clears revoked access, and rejects late older responses', async t => {
  let state, attempts = [], denied = 0;
  const read = () => new Promise((resolve, reject) => attempts.push({ resolve, reject }));
  const onProperties = () => {}, onAccessLost = () => denied++;
  function Probe(props) { const value = useCalendarData({ read, onProperties, onAccessLost, ...props }); useEffect(() => { state = value; }, [value]); return createElement('span', null, value.data?.bookings[0]?.guest_name ?? 'no snapshot'); }
  const props = { start: '2026-10-01', end: '2026-11-01', scope: 'owner', reload: 0 };
  const { root, dom } = await mount(t, Probe, props);
  assert.equal(state.data, null); assert.equal(state.loading, true);
  await act(async () => { attempts[0].resolve(response()); await tick(); });
  assert.ok(document.body.textContent.includes('SYNTHETIC_PRIVATE')); assert.equal(state.requestFailed, false);
  const rerender = async overrides => { Object.assign(props, overrides); await act(async () => { root.render(createElement(Probe, { ...props })); await tick(); }); };
  await rerender({ reload: 1 });
  await act(async () => { attempts[1].reject(Error('offline')); await tick(); });
  assert.equal(state.data.bookings[0].snapshot_only, true);
  await rerender({ reload: 2 }); assert.equal(state.data.bookings[0].snapshot_only, true); assert.equal(state.error, null);
  await act(async () => { attempts[2].resolve({}); await tick(); }); assert.equal(state.data.bookings.length, 1); assert.match(state.error, /不完整/);
  await rerender({ start: '2026-11-01', end: '2026-12-01' });
  await act(async () => { attempts[3].reject(Error('offline')); await tick(); }); assert.equal(hasCalendarCoverage(state.data, props.start, props.end), false);
  await rerender({ reload: 3 });
  await rerender({ reload: 4 });
  await act(async () => { attempts[5].resolve(response(props.start, props.end)); await tick(); });
  await act(async () => { attempts[4].resolve(response()); await tick(); });
  assert.equal(hasCalendarCoverage(state.data, props.start, props.end), true); assert.equal(state.requestFailed, false);
  await rerender({ reload: 5 });
  await act(async () => { attempts[6].reject(new ApiError(401, 'revoked')); await tick(); });
  assert.equal(state.data, null); assert.equal(state.lastLoadedAt, null); assert.equal(denied, 1); assert.equal(document.body.textContent.includes('SYNTHETIC_PRIVATE'), false);
  await rerender({ reload: 6 }); await act(async () => { attempts[7].resolve(response(props.start, props.end)); await tick(); });
  await rerender({ scope: 'viewer-no-price' }); assert.equal(state.data, null); assert.equal(document.body.textContent.includes('SYNTHETIC_PRIVATE'), false);
  await rerender({ scope: 'owner' }); assert.equal(state.data, null);
  assert.equal(dom.window.localStorage.length, 0); assert.equal(dom.window.sessionStorage.length, 0);
});

test('switching to an uncovered date range renders loading immediately, and only a failed request exposes the unavailable state', async t => {
  const attempts = [], renders = [];
  const read = () => new Promise((resolve, reject) => attempts.push({ resolve, reject }));
  const onProperties = () => {}, onAccessLost = () => {};
  const props = { start: '2026-10-01', end: '2026-11-01', scope: 'owner', reload: 0 };
  function Probe({ start, end, scope, reload }) {
    const value = useCalendarData({ start, end, scope, reload, read, onProperties, onAccessLost });
    renders.push({ start, loading: value.loading, covered: hasCalendarCoverage(value.data, start, end), failed: value.requestFailed });
    return createElement('span', null, value.loading ? 'loading' : value.requestFailed ? 'failed' : 'calendar');
  }
  const { root } = await mount(t, Probe, props);
  await act(async () => { attempts[0].resolve(response()); await tick(); });
  assert.equal(document.body.textContent, 'calendar');

  props.start = '2026-11-01'; props.end = '2026-12-01';
  const firstNewRender = renders.length;
  await act(async () => { root.render(createElement(Probe, { ...props })); await tick(); });
  assert.ok(renders.slice(firstNewRender).some(item => item.start === props.start));
  assert.ok(renders.slice(firstNewRender).filter(item => item.start === props.start && !item.covered).every(item => item.loading));
  assert.equal(document.body.textContent, 'loading');

  await act(async () => { attempts[1].reject(Error('offline')); await tick(); });
  assert.equal(document.body.textContent, 'failed');
  props.start = '2026-12-01'; props.end = '2027-01-01';
  await act(async () => { root.render(createElement(Probe, { ...props })); await tick(); });
  assert.equal(document.body.textContent, 'loading');
});

test('a nearby background read keeps the visible month on screen', async t => {
  let state;
  const attempts = [];
  const read = () => new Promise(resolve => attempts.push(resolve));
  const onProperties = () => {}, onAccessLost = () => {};
  const props = { start: '2026-09-28', end: '2026-11-02', visibleStart: '2026-09-28', visibleEnd: '2026-11-02', scope: 'owner', reload: 0 };
  function Probe(input) {
    const value = useCalendarData({ ...input, read, onProperties, onAccessLost });
    useEffect(() => { state = value; }, [value]);
    return createElement('span', null, value.loading ? 'loading' : 'calendar');
  }
  const { root } = await mount(t, Probe, props);
  await act(async () => { attempts[0](response(props.start, props.end)); await tick(); });
  assert.equal(document.body.textContent, 'calendar');
  props.start = '2026-07-27'; props.end = '2027-01-04';
  await act(async () => { root.render(createElement(Probe, { ...props })); await tick(); });
  assert.equal(state.loading, false);
  assert.equal(state.refreshing, true);
  assert.equal(document.body.textContent, 'calendar');
  await act(async () => { attempts[1](response(props.start, props.end)); await tick(); });
  props.visibleStart = '2026-10-26'; props.visibleEnd = '2026-12-07';
  await act(async () => { root.render(createElement(Probe, { ...props })); await tick(); });
  assert.equal(state.loading, false);
  assert.equal(document.body.textContent, 'calendar');
});

test('prefetched monthly windows make the next month available without another main read', async t => {
  let state;
  const attempts = [];
  const read = (start, end) => new Promise(resolve => attempts.push({ start, end, resolve }));
  const onProperties = () => {}, onAccessLost = () => {};
  const props = { start: '2026-09-28', end: '2026-11-02', scope: 'owner', reload: 0,
    prefetch: [{ start: '2026-10-26', end: '2026-12-07' }] };
  const live = (start, end) => ({ ...response(start, end), source: { private_snapshot_version: '17' } });
  function Probe(input) {
    const value = useCalendarData({ ...input, read, onProperties, onAccessLost });
    useEffect(() => { state = value; }, [value]);
    return createElement('span', null, value.loading ? 'loading' : 'calendar');
  }
  const { root } = await mount(t, Probe, props);
  await act(async () => { attempts[0].resolve(live(props.start, props.end)); await tick(); });
  assert.equal(document.body.textContent, 'calendar');
  assert.deepEqual([attempts[1].start, attempts[1].end], ['2026-10-26', '2026-12-07']);
  await act(async () => { attempts[1].resolve(live(attempts[1].start, attempts[1].end)); await tick(); });
  assert.equal(hasCalendarCoverage(state.data, '2026-10-26', '2026-12-07'), true);
  props.start = '2026-10-26'; props.end = '2026-12-07'; props.prefetch = [];
  await act(async () => { root.render(createElement(Probe, { ...props })); await tick(); });
  assert.equal(state.loading, false);
  assert.equal(attempts.filter(item => item.start === props.start && item.end === props.end).length, 1);
});

test('scrolling October to November keeps the yearly snapshot and makes no network read', async t => {
  const attempts = [];
  let state;
  const read = (start, end) => new Promise(resolve => attempts.push({ start, end, resolve }));
  const onProperties = () => {}, onAccessLost = () => {};
  const props = { start: '2025-12-29', end: '2027-02-01',
    visibleStart: '2026-09-28', visibleEnd: '2026-11-02',
    scope: 'owner:sweetfun', reload: 0 };
  function Probe(input) {
    const value = useCalendarData({ ...input, read, onProperties, onAccessLost });
    useEffect(() => { state = value; }, [value]);
    return createElement('span', null, value.loading ? 'loading' : 'calendar');
  }
  const { root } = await mount(t, Probe, props);
  await act(async () => { attempts[0].resolve({ ...response(props.start, props.end),
    source: { private_snapshot_version: '17' } }); await tick(); });
  assert.equal(document.body.textContent, 'calendar');
  props.visibleStart = '2026-10-26'; props.visibleEnd = '2026-12-07';
  await act(async () => { root.render(createElement(Probe, { ...props })); await tick(); });
  assert.equal(state.loading, false);
  assert.equal(attempts.length, 1);
  props.visibleStart = '2026-11-30'; props.visibleEnd = '2027-01-04';
  await act(async () => { root.render(createElement(Probe, { ...props })); await tick(); });
  assert.equal(state.loading, false);
  assert.equal(attempts.length, 1);
});

test('both adjacent years warm in parallel and stay available across a twelve-month scroll', async t => {
  const attempts = [];
  let state;
  const read = (start, end) => new Promise(resolve => attempts.push({ start, end, resolve }));
  const onProperties = () => {}, onAccessLost = () => {};
  const years = [
    { start: '2024-12-30', end: '2026-02-02' },
    { start: '2025-12-29', end: '2027-02-01' },
    { start: '2026-12-28', end: '2028-02-07' },
  ];
  const props = { ...years[1], visibleStart: '2026-09-28', visibleEnd: '2026-11-02',
    scope: 'owner:sweetfun', reload: 0, prefetch: [years[0], years[2]] };
  const live = ({ start, end }) => ({ ...response(start, end), source: { private_snapshot_version: '17' } });
  function Probe(input) {
    const value = useCalendarData({ ...input, read, onProperties, onAccessLost });
    useEffect(() => { state = value; }, [value]);
    return createElement('span', null, value.loading ? 'loading' : 'calendar');
  }
  const { root } = await mount(t, Probe, props);
  await act(async () => { attempts[0].resolve(live(years[1])); await tick(); });
  assert.equal(attempts.length, 3, 'both neighboring year reads start without waiting for each other');
  await act(async () => {
    attempts[1].resolve(live(years[0])); attempts[2].resolve(live(years[2])); await tick();
  });
  for (const [year, month] of [[years[0], '2025-10-01'], [years[2], '2027-10-01']]) {
    Object.assign(props, year, { visibleStart: month, visibleEnd: month.replace('-10-', '-11-'), prefetch: [] });
    await act(async () => { root.render(createElement(Probe, { ...props })); await tick(); });
    assert.equal(state.loading, false);
    assert.equal(attempts.length, 3, 'scrolling across years reuses the verified snapshot');
  }
});
