import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, useEffect } from 'react';
import { mount } from './helpers/customer-dom.mjs';
import { useCalendarData } from '../src/components/calendar/use-calendar-data.ts';
import { hasCalendarCoverage } from '../src/components/calendar/calendar-retention.ts';
import { ApiError } from '../src/lib/api-client.ts';

const october = { start: '2026-09-28', end: '2026-11-02' };
const september = { start: '2026-08-31', end: '2026-10-05' };
const november = { start: '2026-10-26', end: '2026-12-07' };
const december = { start: '2026-11-30', end: '2027-01-04' };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const response = ({ start, end }, version = '17') => ({
  period_start: start, period_end: end,
  source: { private_snapshot_version: version },
  properties: [], rooms: [],
  bookings: [{ id: `${start}:${version}`, order_id: start, property_id: 'sweetfun',
    room_id: '301', guest_name: `SYNTHETIC_${version}`, check_in: start, check_out: end }],
});

async function calendar(t, initial = {}) {
  const attempts = [];
  let state, denied = 0;
  const read = (start, end) => new Promise((resolve, reject) => attempts.push({ start, end, resolve, reject }));
  const onProperties = () => {};
  const onAccessLost = () => { denied++; };
  const props = { ...october, scope: 'owner:sweetfun', reload: 0,
    prefetch: [september, november], ...initial };
  function Probe(input) {
    const value = useCalendarData({ ...input, read, onProperties, onAccessLost });
    useEffect(() => { state = value; }, [value]);
    return createElement('span', null, value.data?.bookings.map(b => b.guest_name).join(',') ?? 'no snapshot');
  }
  const { root, dom } = await mount(t, Probe, props);
  return {
    attempts, dom, get state() { return state; }, get denied() { return denied; },
    count(range) { return attempts.filter(a => a.start === range.start && a.end === range.end).length; },
    async resolve(attempt, version = '17') {
      await act(async () => { attempt.resolve(response(attempt, version)); await tick(); });
    },
    async reject(attempt, error) {
      await act(async () => { attempt.reject(error); await tick(); });
    },
    async navigate(next) {
      Object.assign(props, next);
      await act(async () => { root.render(createElement(Probe, { ...props })); await tick(); });
    },
  };
}

test('a fast adjacent month is cached before its slow sibling settles, so navigating to it does not read twice', async t => {
  const view = await calendar(t);
  await view.resolve(view.attempts[0]);
  assert.equal(view.attempts.length, 3, 'the adjacent reads start together');
  const next = view.attempts.find(a => a.start === november.start);
  await view.resolve(next);
  assert.equal(hasCalendarCoverage(view.state.data, november.start, november.end), true,
    'the fast next month is usable while the previous month is still pending');
  await view.navigate({ ...november, prefetch: [] });
  assert.equal(view.state.loading, false);
  assert.equal(view.count(november), 1);
});

test('navigation joins an in-flight prefetch and another same-scope prefetch still warms after navigation', async t => {
  const view = await calendar(t);
  await view.resolve(view.attempts[0]);
  const previous = view.attempts.find(a => a.start === september.start);
  const next = view.attempts.find(a => a.start === november.start);
  await view.navigate({ ...november, prefetch: [] });
  assert.equal(view.count(november), 1, 'foreground and prefetch share the pending read');
  await view.resolve(next);
  assert.equal(view.state.loading, false);
  await view.resolve(previous);
  await view.navigate({ ...september, prefetch: [] });
  assert.equal(view.state.loading, false);
  assert.equal(view.count(september), 1, 'moving the viewport does not discard a valid completed prefetch');
});

test('a background access denial after navigation clears private data and late successes cannot refill it', async t => {
  const view = await calendar(t);
  await view.resolve(view.attempts[0]);
  const previous = view.attempts.find(a => a.start === september.start);
  const next = view.attempts.find(a => a.start === november.start);
  await view.navigate({ ...november, prefetch: [] });
  await view.reject(previous, new ApiError(403, 'access revoked'));
  assert.equal(view.denied, 1);
  assert.equal(view.state.data, null);
  assert.equal(view.state.lastLoadedAt, null);
  assert.equal(document.body.textContent.includes('SYNTHETIC'), false);
  await view.resolve(next);
  assert.equal(view.state.data, null, 'late success must not restore revoked data');
  assert.equal(view.denied, 1);
  assert.equal(view.dom.window.localStorage.length, 0);
  assert.equal(view.dom.window.sessionStorage.length, 0);
});

test('reload isolates older prefetch successes and access errors from a newer verified response', async t => {
  const view = await calendar(t);
  await view.resolve(view.attempts[0]);
  const previous = view.attempts.find(a => a.start === september.start);
  const next = view.attempts.find(a => a.start === november.start);
  await view.navigate({ reload: 1, prefetch: [] });
  const refreshed = view.attempts.at(-1);
  await view.resolve(refreshed, '18');
  await view.resolve(previous, '17');
  await view.reject(next, new ApiError(401, 'older request expired'));
  assert.equal(view.state.data.source.private_snapshot_version, '18');
  assert.equal(view.state.requestFailed, false);
  assert.equal(view.denied, 0);
  await view.navigate({ ...september });
  assert.equal(view.count(september), 2, 'old-generation prefetch did not populate the new cache');
});

test('reload rereads cached neighbors when guest and payment change without an inventory version change', async t => {
  const view = await calendar(t);
  await view.resolve(view.attempts[0]);
  const previous = view.attempts.find(a => a.start === september.start);
  const next = view.attempts.find(a => a.start === november.start);
  await view.resolve(previous);
  const oldNext = response(next);
  oldNext.bookings[0].guest_name = 'SYNTHETIC_BEFORE_EDIT';
  oldNext.bookings[0].payment_status = 'unpaid';
  await act(async () => { next.resolve(oldNext); await tick(); });
  assert.ok(view.state.data.bookings.some(booking => booking.guest_name === 'SYNTHETIC_BEFORE_EDIT'));

  await view.navigate({ reload: 1 });
  assert.equal(view.state.refreshing, true);
  assert.ok(view.state.data.bookings.some(booking => booking.guest_name === 'SYNTHETIC_BEFORE_EDIT'),
    'the last displayed result remains visible while the foreground refresh is pending');
  await view.resolve(view.attempts.at(-1), '17');
  assert.equal(view.count(september), 2);
  assert.equal(view.count(november), 2, 'inventory version alone cannot validate a cached payment or guest name');
  assert.equal(hasCalendarCoverage(view.state.data, november.start, november.end), false);
  assert.ok(view.state.data.bookings.every(booking => booking.guest_name !== 'SYNTHETIC_BEFORE_EDIT'));

  const freshNext = view.attempts.filter(a => a.start === november.start).at(-1);
  const updated = response(freshNext, '17');
  updated.bookings[0].guest_name = 'SYNTHETIC_AFTER_EDIT';
  updated.bookings[0].payment_status = 'paid';
  await act(async () => { freshNext.resolve(updated); await tick(); });
  const booking = view.state.data.bookings.find(item => item.id === updated.bookings[0].id);
  assert.equal(booking.guest_name, 'SYNTHETIC_AFTER_EDIT');
  assert.equal(booking.payment_status, 'paid');
  assert.equal(view.state.data.source.private_snapshot_version, '17');
});

test('scope changes clear private data immediately and ignore the old scope background results', async t => {
  const view = await calendar(t);
  await view.resolve(view.attempts[0]);
  const previous = view.attempts.find(a => a.start === september.start);
  const next = view.attempts.find(a => a.start === november.start);
  await view.navigate({ scope: 'viewer-no-price:offland', prefetch: [] });
  assert.equal(view.state.data, null);
  assert.equal(document.body.textContent.includes('SYNTHETIC'), false);
  await view.resolve(previous);
  await view.reject(next, new ApiError(403, 'old scope denied'));
  assert.equal(view.state.data, null);
  assert.equal(view.denied, 0);
  await view.resolve(view.attempts.at(-1), '20');
  assert.equal(view.state.data.source.private_snapshot_version, '20');
});

test('a newer foreground inventory version prevents older pending months from repopulating the cache', async t => {
  const view = await calendar(t);
  await view.resolve(view.attempts[0]);
  const previous = view.attempts.find(a => a.start === september.start);
  const next = view.attempts.find(a => a.start === november.start);
  await view.navigate({ ...december, prefetch: [] });
  await view.resolve(view.attempts.at(-1), '18');
  await view.resolve(previous, '17');
  await view.resolve(next, '17');
  assert.equal(view.state.data.source.private_snapshot_version, '18');
  assert.ok(view.state.data.bookings.every(booking => booking.guest_name === 'SYNTHETIC_18'));
  await view.navigate({ ...november });
  assert.equal(view.count(november), 2, 'the old version cannot satisfy a new foreground read');
  await view.resolve(view.attempts.at(-1), '18');
  assert.equal(view.state.data.source.private_snapshot_version, '18');
  assert.ok(view.state.data.bookings.every(booking => booking.guest_name === 'SYNTHETIC_18'));
});

test('navigation after a version change starts a fresh read instead of joining an older pending neighbor', async t => {
  const view = await calendar(t);
  await view.resolve(view.attempts[0]);
  const oldNext = view.attempts.find(a => a.start === november.start);
  await view.navigate({ ...december, prefetch: [] });
  await view.resolve(view.attempts.at(-1), '18');
  await view.navigate({ ...november });
  assert.equal(view.count(november), 2, 'only the current inventory generation can be shared');
  const currentNext = view.attempts.at(-1);
  await view.resolve(oldNext, '17');
  assert.equal(view.state.loading, true);
  assert.equal(view.state.data.source.private_snapshot_version, '18');
  await view.resolve(currentNext, '18');
  assert.equal(view.state.loading, false);
  assert.equal(view.state.data.source.private_snapshot_version, '18');
});

test('a malformed or differently versioned prefetch cannot replace a good visible calendar', async t => {
  const view = await calendar(t);
  await view.resolve(view.attempts[0]);
  const previous = view.attempts.find(a => a.start === september.start);
  const next = view.attempts.find(a => a.start === november.start);
  await act(async () => { previous.resolve({}); await tick(); });
  await view.resolve(next, '18');
  assert.equal(view.state.data.source.private_snapshot_version, '17');
  assert.equal(view.state.requestFailed, false);
  assert.equal(hasCalendarCoverage(view.state.data, november.start, november.end), false);
  await view.navigate({ ...november, prefetch: [] });
  assert.equal(view.count(november), 2);
  await view.resolve(view.attempts.at(-1), '18');
  assert.equal(view.state.data.source.private_snapshot_version, '18');
  assert.ok(view.state.data.bookings.every(booking => booking.guest_name === 'SYNTHETIC_18'));
});
