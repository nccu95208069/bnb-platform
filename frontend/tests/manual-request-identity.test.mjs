import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearPendingManualRequest, readPendingManualRequest,
  savePendingManualRequest } from '../src/lib/booking-sources/manual-request-identity.ts';

const key = '11111111-1111-4111-8111-111111111111';
const otherKey = '22222222-2222-4222-8222-222222222222';

test('manual request identity survives dialog reload and is not overwritten', () => {
  const values = new Map();
  const storage = { getItem: name => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
    removeItem: name => values.delete(name) };
  const pending = { requestKey: key, mode: 'create', bookingId: null, createdAt: 1 };
  savePendingManualRequest(storage, pending);
  assert.deepEqual(readPendingManualRequest(storage), pending);
  assert.throws(() => savePendingManualRequest(storage,
    { ...pending, requestKey: otherKey }), /MANUAL_PENDING_REQUEST/);
  clearPendingManualRequest(storage, otherKey);
  assert.deepEqual(readPendingManualRequest(storage), pending);
  clearPendingManualRequest(storage, key);
  assert.equal(readPendingManualRequest(storage), null);
});

test('manual booking writes stop when the browser cannot retain the recovery key', () => {
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  assert.throws(() => savePendingManualRequest(storage,
    { requestKey: key, mode: 'create', bookingId: null, createdAt: 1 }),
  /MANUAL_STORAGE_UNAVAILABLE/);
});

test('room-sync request keeps its booking identity across a reload', () => {
  const values = new Map();
  const storage = { getItem: name => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
    removeItem: name => values.delete(name) };
  const pending = { requestKey: key, mode: 'sync', bookingId: otherKey, createdAt: 1 };
  savePendingManualRequest(storage, pending);
  assert.deepEqual(readPendingManualRequest(storage), pending);
});
