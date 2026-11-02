import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, apiClient } from '../src/lib/api-client.ts';
import { readCalendarWithChanges } from '../src/lib/calendar-sync-client.ts';
import { createCalendarDelta } from '../src/lib/calendar-sync.ts';

const start = '2026-11-01', end = '2026-12-01';
const data = (name = 'Synthetic Before') => ({ period_start: start, period_end: end,
  properties: [{ id: 'sweetfun', name: 'Synthetic Property' }],
  rooms: [{ id: 'room-101', property_id: 'sweetfun' }],
  bookings: [{ id: 'one', property_id: 'sweetfun', room_id: 'room-101',
    check_in: '2026-11-04', check_out: '2026-11-06', guest_name: name }],
});

test('valid changes return the complete updated calendar without a full transfer', async t => {
  const base = data(), fresh = data('Synthetic After');
  const get = t.mock.method(apiClient, 'get', async () => { throw Error('Unexpected full read'); });
  const post = t.mock.method(apiClient, 'post', async (path, body) => {
    assert.equal(path, '/bookings/calendar/sync');
    assert.deepEqual(body.properties, ['sweetfun']);
    return createCalendarDelta(body.manifest, fresh);
  });
  assert.deepEqual(await readCalendarWithChanges(start, end, ['sweetfun'], base), fresh);
  assert.equal(post.mock.callCount(), 1);
  assert.equal(get.mock.callCount(), 0);
});

test('rejected bases and corrupt patches each recover with exactly one validated full read', async t => {
  for (const failure of ['conflict', 'corrupt']) {
    await t.test(failure, async t => {
      const base = data(), fresh = data('Synthetic Recovered');
      const post = t.mock.method(apiClient, 'post', async (_path, body) => {
        if (failure === 'conflict') throw new ApiError(409, 'Refresh required');
        return { ...await createCalendarDelta(body.manifest, fresh), digest: 'a'.repeat(64) };
      });
      const get = t.mock.method(apiClient, 'get', async path => {
        assert.equal(path, `/bookings/calendar?start=${start}&end=${end}&properties=sweetfun`);
        return fresh;
      });
      assert.deepEqual(await readCalendarWithChanges(start, end, ['sweetfun'], base), fresh);
      assert.equal(post.mock.callCount(), 1);
      assert.equal(get.mock.callCount(), 1);
      assert.equal(base.bookings[0].guest_name, 'Synthetic Before');
    });
  }
});

test('revoked access and network failures propagate without a full-read retry', async t => {
  for (const error of [new ApiError(401, 'Signed out'), new ApiError(403, 'Access revoked'),
    new ApiError(503, 'Unavailable'), new TypeError('Network failed')]) {
    await t.test(error.message, async t => {
      const post = t.mock.method(apiClient, 'post', async () => { throw error; });
      const get = t.mock.method(apiClient, 'get', async () => data());
      await assert.rejects(readCalendarWithChanges(start, end, ['sweetfun'], data()), cause => cause === error);
      assert.equal(post.mock.callCount(), 1);
      assert.equal(get.mock.callCount(), 0);
    });
  }
});

test('failed full recovery propagates once and cannot accept an incomplete response as current', async t => {
  for (const failure of ['access', 'network', 'malformed']) {
    await t.test(failure, async t => {
      const error = failure === 'access' ? new ApiError(403, 'Access revoked') : new TypeError('Network failed');
      const post = t.mock.method(apiClient, 'post', async () => { throw new ApiError(409, 'Refresh required'); });
      const get = t.mock.method(apiClient, 'get', async () => {
        if (failure === 'malformed') return { ...data(), bookings: null };
        throw error;
      });
      await assert.rejects(readCalendarWithChanges(start, end, ['sweetfun'], data()),
        failure === 'malformed' ? /日曆資料不完整/ : cause => cause === error);
      assert.equal(post.mock.callCount(), 1);
      assert.equal(get.mock.callCount(), 1);
    });
  }
});

test('initial full reads reject malformed or incomplete coverage before reaching the hook', async t => {
  const post = t.mock.method(apiClient, 'post', async () => { throw Error('Unexpected sync'); });
  for (const response of [{ ...data(), rooms: null }, { ...data(), period_end: '2026-11-15' }]) {
    const get = t.mock.method(apiClient, 'get', async () => response);
    await assert.rejects(readCalendarWithChanges(start, end, ['sweetfun']), /日曆資料不完整/);
    assert.equal(get.mock.callCount(), 1);
    get.mock.restore();
  }
  assert.equal(post.mock.callCount(), 0);
});
