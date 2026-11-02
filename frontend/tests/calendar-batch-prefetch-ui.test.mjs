import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, useEffect } from 'react';
import { mount } from './helpers/customer-dom.mjs';
import { useCalendarData } from '../src/components/calendar/use-calendar-data.ts';
import { useAvailabilityData } from '../src/components/calendar/use-availability-data.ts';
import { useCalendarPreloadAnchor } from '../src/components/calendar/use-calendar-preload-anchor.ts';
import { sixMonthPrefetchRanges } from '../src/components/calendar/calendar-prefetch.ts';
import { calendarResponseVersion, combinedCalendarWindows } from '../src/components/calendar/calendar-retention.ts';
import { addMonths, fetchPeriod } from '../src/components/calendar/calendar-utils.ts';
import { ApiError } from '../src/lib/api-client.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const sold = (range, sweetfun = '10', offland = '4', bookings = []) => ({
  period_start: range.start, period_end: range.end, properties: [], rooms: [], bookings,
  source: { private_snapshot_version: sweetfun }, sources: [
    { property_id: 'sweetfun', source: { private_snapshot_version: sweetfun } },
    { property_id: 'offland', source: { private_snapshot_version: offland } },
  ],
});
const booking = (name = 'SYNTHETIC_BEFORE') => ({ id: 'test-booking', order_id: 'test-order',
  property_id: 'offland', room_id: 'villa', guest_name: name, check_in: '2026-11-15', check_out: '2026-11-16' });

test('six-month plan crosses years while every grid request remains below 93 days', () => {
  for (const month of ['2026-01-01', '2026-10-01', '2027-12-01', '2028-02-01']) {
    const bands = sixMonthPrefetchRanges(month, true);
    assert.equal(bands.length, 3);
    for (const band of bands) assert.ok((Date.parse(band.end) - Date.parse(band.start)) / 86400000 <= 93);
  }
  assert.deepEqual(sixMonthPrefetchRanges('2026-10-30'), [
    { start: '2026-11-01', end: '2027-01-01' },
    { start: '2027-01-01', end: '2027-03-01' },
    { start: '2027-03-01', end: '2027-04-01' },
  ]);
});

test('both property versions protect combined windows and newer overlapping reads remove cancelled rows', () => {
  const old = sold({ start: '2026-11-01', end: '2027-01-01' }, '10', '4', [booking()]);
  const offlandChanged = sold({ start: '2027-01-01', end: '2027-03-01' }, '10', '5');
  assert.notEqual(calendarResponseVersion(old), calendarResponseVersion(offlandChanged));
  assert.equal(combinedCalendarWindows([old, offlandChanged], old.period_start, offlandChanged.period_end), null);
  const later = sold({ start: '2026-11-01', end: '2026-12-01' }, '10', '4', [booking('SYNTHETIC_AFTER')]);
  assert.equal(combinedCalendarWindows([old, later], '2026-11-01', '2026-12-01').bookings[0].guest_name, 'SYNTHETIC_AFTER');
  assert.equal(combinedCalendarWindows([old, { ...later, bookings: [] }], '2026-11-01', '2026-12-01').bookings.length, 0);
});

test('sold calendar starts all six-month bands without scrolling and joins the pending band when entering December', async t => {
  let state; const attempts = [];
  const read = (start, end) => new Promise(resolve => attempts.push({ start, end, resolve }));
  const onProperties = () => {}, onAccessLost = () => {};
  const props = { ...fetchPeriod('2026-10-01', 'month', true), scope: 'owner:both', reload: 0,
    prefetch: sixMonthPrefetchRanges('2026-10-01', true) };
  function Probe(input) {
    const value = useCalendarData({ ...input, read, onProperties, onAccessLost });
    useEffect(() => { state = value; }, [value]);
    return createElement('span', null, value.loading ? 'loading' : 'ready');
  }
  const { root } = await mount(t, Probe, props);
  assert.equal(attempts.length, 1);
  await act(async () => { attempts[0].resolve(sold(attempts[0])); await tick(); });
  assert.equal(attempts.length, 4, 'all three batches start before any navigation');
  const december = fetchPeriod('2026-12-01', 'month', true);
  await act(async () => { root.render(createElement(Probe, { ...props, ...december, prefetch: [] })); await tick(); });
  assert.equal(attempts.length, 4, 'December joins the already running November–December band');
  await act(async () => { attempts[1].resolve(sold(attempts[1])); await tick(); });
  assert.equal(state.loading, false);
  for (const attempt of attempts.slice(2)) await act(async () => { attempt.resolve(sold(attempt)); await tick(); });
  const march = fetchPeriod('2027-03-01', 'month', true);
  await act(async () => { root.render(createElement(Probe, { ...props, ...march, prefetch: [] })); await tick(); });
  assert.equal(state.loading, false);
  assert.equal(attempts.length, 4, 'the sixth month is already usable');
});

test('sold six-month navigation retains its opening horizon and reload starts at the currently visible month', async t => {
  let state, anchor; const attempts = [];
  const read = (start, end) => new Promise(resolve => attempts.push({ start, end, resolve }));
  const onProperties = () => {}, onAccessLost = () => {};
  const props = { month: '2026-10-01', scope: 'owner:both', reload: 0 };
  function Probe(input) {
    const fixed = useCalendarPreloadAnchor(input.month, JSON.stringify([input.scope, input.reload]));
    const value = useCalendarData({ ...fetchPeriod(input.month, 'month', true),
      scope: input.scope, reload: input.reload, prefetch: sixMonthPrefetchRanges(fixed, true),
      read, onProperties, onAccessLost });
    useEffect(() => { state = value; anchor = fixed; }, [value, fixed]);
    return createElement('span', null, value.loading ? 'loading' : 'ready');
  }
  const { root } = await mount(t, Probe, props);
  const navigate = async next => {
    Object.assign(props, next);
    await act(async () => { root.render(createElement(Probe, { ...props })); await tick(); });
  };
  await act(async () => { attempts[0].resolve(sold(attempts[0])); await tick(); });
  for (const attempt of attempts.slice(1)) await act(async () => { attempt.resolve(sold(attempt)); await tick(); });
  for (let offset = 1; offset < 6; offset++) {
    await navigate({ month: addMonths('2026-10-01', offset) });
    assert.equal(anchor, '2026-10-01');
    assert.equal(state.loading, false);
    assert.equal(attempts.length, 4, 'browsing the original six months does not fetch April–August');
  }
  await navigate({ month: '2026-10-01' });
  assert.equal(attempts.length, 4, 'the opening month remains cached after browsing all six months');
  assert.equal(state.loading, false);
  await navigate({ month: '2027-03-01', reload: 1 });
  assert.equal(anchor, '2027-03-01');
  assert.deepEqual({ start: attempts[4].start, end: attempts[4].end },
    { start: fetchPeriod('2027-03-01', 'month', true).start, end: fetchPeriod('2027-03-01', 'month', true).end });
  await act(async () => { attempts[4].resolve(sold(attempts[4])); await tick(); });
  assert.deepEqual(attempts.slice(5).map(({ start, end }) => ({ start, end })), sixMonthPrefetchRanges('2027-03-01', true));
});

const availability = (query, property = 'sweetfun', version = '10') => {
  const cells = [];
  for (let day = Date.parse(query.start); day < Date.parse(query.end); day += 86400000)
    cells.push({ date: new Date(day).toISOString().slice(0, 10), room: '101', state: 'available', reason: 'synthetic' });
  return { query, property_id: property, rooms: ['101'], cells, snapshot_id: version,
    counts: { available: cells.length }, price_hidden: false, asof: '2026-10-30' };
};
async function unsold(t) {
  let state; let denied = 0; const attempts = [];
  const read = query => new Promise((resolve, reject) => attempts.push({ query, resolve, reject }));
  const onProperties = () => {}, onAccessLost = () => denied++;
  const props = { query: { start: '2026-10-01', end: '2026-11-01', rooms: [], channel: 'direct', demo_cycle: 1 },
    property: 'sweetfun', scope: 'owner', reload: 0, preload: true };
  function Probe(input) {
    const value = useAvailabilityData({ ...input, read, onProperties, onAccessLost });
    useEffect(() => { state = value; }, [value]);
    return createElement('span', null, value.error ? 'unavailable' : value.loading ? 'loading' : `available:${value.data?.counts.available}`);
  }
  const { root } = await mount(t, Probe, props);
  return { attempts, get state() { return state; }, get denied() { return denied; },
    async resolve(attempt, property = 'sweetfun') { await act(async () => { attempt.resolve(availability(attempt.query, property)); await tick(); }); },
    async reject(attempt, error) { await act(async () => { attempt.reject(error); await tick(); }); },
    async navigate(next) { Object.assign(props, next); await act(async () => { root.render(createElement(Probe, { ...props })); await tick(); }); },
    props,
  };
}

test('unsold summary and every month share six-month batches; moving into a pending month does not fetch twice', async t => {
  const view = await unsold(t);
  assert.equal(view.attempts.length, 1);
  await view.resolve(view.attempts[0]);
  assert.equal(view.attempts.length, 4);
  assert.equal(view.state.data.counts.available, 31);
  await view.navigate({ query: { ...view.props.query, start: '2026-12-01', end: '2027-01-01' }, preload: false });
  assert.equal(view.attempts.length, 4);
  await view.resolve(view.attempts[1]);
  assert.equal(view.state.loading, false);
  assert.equal(view.state.data.counts.available, 31, 'summary counts the visible month, not the full batch');
  await view.resolve(view.attempts[2]); await view.resolve(view.attempts[3]);
  assert.equal(view.state.month('2027-03-01', '2027-04-01').data.counts.available, 31);
  await view.navigate({ query: { ...view.props.query, start: '2027-03-01', end: '2027-04-01' } });
  assert.equal(view.attempts.length, 4);
  assert.equal(view.state.loading, false);
});

test('unsold keeps the original six-month horizon through March and moves it only after crossing into April', async t => {
  const view = await unsold(t);
  await view.resolve(view.attempts[0]);
  for (const attempt of view.attempts.slice(1)) await view.resolve(attempt);
  for (let offset = 1; offset < 6; offset++) {
    const start = addMonths('2026-10-01', offset);
    await view.navigate({ query: { ...view.props.query, start, end: addMonths(start, 1) } });
    assert.equal(view.state.loading, false);
    assert.equal(view.attempts.length, 4, 'preloading remains enabled without rolling the horizon forward');
    assert.equal(view.state.month('2026-10-01', '2026-11-01').data.counts.available, 31);
  }
  await view.navigate({ query: { ...view.props.query, start: '2027-04-01', end: '2027-05-01' } });
  assert.equal(view.attempts.length, 5, 'April first gets its own foreground read');
  await view.resolve(view.attempts[4]);
  assert.deepEqual(view.attempts.slice(5).map(({ query: { start, end } }) => ({ start, end })), sixMonthPrefetchRanges('2027-04-01'));
});

test('an unsold batch failure is explicit and never becomes an empty or available month', async t => {
  const view = await unsold(t);
  await view.resolve(view.attempts[0]);
  await view.reject(view.attempts[1], Error('temporarily unavailable'));
  assert.equal(view.state.month('2026-11-01', '2026-12-01').data, null);
  assert.match(view.state.month('2026-11-01', '2026-12-01').error, /unavailable/);
  assert.equal(view.state.data.counts.available, 31, 'the successful current month is retained');
  await view.navigate({ query: { ...view.props.query, start: '2026-11-01', end: '2026-12-01' }, preload: false });
  await view.reject(view.attempts.at(-1), Error('still unavailable'));
  assert.equal(view.state.data, null);
  assert.equal(document.body.textContent, 'unavailable');
});

test('unsold reload and property change discard old batches; background denial clears every visible month', async t => {
  const view = await unsold(t);
  await view.resolve(view.attempts[0]);
  const oldBatch = view.attempts[1];
  await view.navigate({ property: 'offland', scope: 'owner:offland', preload: false });
  assert.equal(view.state.data, null);
  await view.resolve(oldBatch);
  assert.equal(view.state.data, null);
  await view.resolve(view.attempts.at(-1), 'offland');
  assert.equal(view.state.data.property_id, 'offland');
  await view.navigate({ reload: 1, preload: true });
  assert.equal(view.state.data, null);
  await view.resolve(view.attempts.at(-1), 'offland');
  await view.reject(view.attempts.at(-1), new ApiError(403, 'access revoked'));
  assert.equal(view.state.data, null);
  assert.equal(view.denied, 1);
});
