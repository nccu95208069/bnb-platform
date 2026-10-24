import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPendingManualPayment, savePendingManualPayment,
  clearPendingManualPayment } from '../src/lib/booking-sources/manual-payment-request-identity.ts';

function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key) };
}

test('a payment request survives reload and prevents a second write until recovered', () => {
  const store = storage();
  const pending = { requestKey: '11111111-1111-4111-8111-111111111111',
    bookingId: '22222222-2222-4222-8222-222222222222', createdAt: Date.now() };
  savePendingManualPayment(store, pending);
  assert.deepEqual(readPendingManualPayment(store), pending);
  assert.throws(() => savePendingManualPayment(store, { ...pending,
    requestKey: '33333333-3333-4333-8333-333333333333' }), /MANUAL_PENDING_REQUEST/);
  clearPendingManualPayment(store, '33333333-3333-4333-8333-333333333333');
  assert.deepEqual(readPendingManualPayment(store), pending);
  clearPendingManualPayment(store, pending.requestKey);
  assert.equal(readPendingManualPayment(store), null);
});

test('original payment payload survives reload but malformed retry fields are rejected', () => {
  const store = storage();
  const pending = { requestKey: '11111111-1111-4111-8111-111111111111',
    bookingId: '22222222-2222-4222-8222-222222222222', createdAt: Date.now(),
    payload: { expectedBookingVersion: 1, kind: 'received', amountCents: 10000, method: 'cash',
      evidenceRef: 'synthetic receipt', occurredAt: '2026-10-01T00:00:00.000Z' } };
  savePendingManualPayment(store, pending);
  assert.deepEqual(readPendingManualPayment(store), pending);
  for (const patch of [{ amountCents: -1 }, { method: 'ota' }, { kind: 'refunded' }, { unrelated: true }]) {
    const bad = storage();
    bad.setItem('sweetfun-manual-payment-request-v1', JSON.stringify({ ...pending, payload: { ...pending.payload, ...patch } }));
    assert.throws(() => readPendingManualPayment(bad), /INVALID/);
  }
});
