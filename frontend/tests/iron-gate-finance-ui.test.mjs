import assert from 'node:assert/strict';
import { test } from 'node:test';
import { act, createElement } from 'react';
import { mount } from './helpers/customer-dom.mjs';
import { IronGateManualPaymentPanel } from '../src/components/payments/iron-gate-manual-payment-panel.tsx';
import { readPendingManualPayment } from '../src/lib/booking-sources/manual-payment-request-identity.ts';

const bookingId = '11111111-1111-4111-8111-111111111111';
const receivedId = '22222222-2222-4222-8222-222222222222';
const detail = { bookingId, version: 2, status: 'confirmed', totalCents: 100000,
  receivedCents: 40000, refundedCents: 0, netReceivedCents: 40000,
  events: [{ id: receivedId, kind: 'received', amountCents: 40000, evidenceRef: 'SYNTHETIC-RECEIPT',
    occurredAt: '2026-09-30T15:00:00.000Z', recordedAt: '2026-09-30T15:00:00.000Z', method: 'cash' }] };

test('refund form sends original receipt and method; financial readback is required before clearing request', async t => {
  const requests = []; let recoverable = false, changed = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (options.method === 'POST') {
      requests.push({ key: options.headers['idempotency-key'], body: JSON.parse(options.body) });
      return Response.json({ bookingId, paymentEventId: requests[0].key }); // Incomplete success is uncertain.
    }
    if (String(url).includes('/payment-requests/')) return Response.json({ bookingId,
      paymentEventId: requests[0].key, financeVerified: recoverable });
    return Response.json(detail);
  });
  const ui = await mount(t, IronGateManualPaymentPanel, { bookingId, canRecord: true, onChange: () => changed++ });
  await ui.click(ui.button('登記收付'));
  await ui.click(document.querySelectorAll('input[type=radio]')[1]);
  await ui.fill(document.querySelector('[aria-label="對應原收款"]'), receivedId);
  await ui.fill(document.querySelector('[aria-label="收付方式"]'), 'cash');
  await ui.fill(document.getElementById('iron-gate-payment-amount'), '100');
  await ui.fill(document.getElementById('iron-gate-payment-at'), '2026-10-01T09:00');
  await ui.fill(document.getElementById('iron-gate-payment-evidence'), 'SYNTHETIC-REFUND');
  await act(() => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, { expectedBookingVersion: 2, kind: 'refunded', amountCents: 10000,
    evidenceRef: 'SYNTHETIC-REFUND', method: 'cash', refundOfEventId: receivedId, occurredAt: '2026-10-01T01:00:00.000Z' });
  assert.equal(readPendingManualPayment(window.localStorage).requestKey, requests[0].key);
  assert.equal(ui.button('確認登記退款'), undefined);
  await ui.click(ui.button('查詢原請求'));
  assert.equal(readPendingManualPayment(window.localStorage).requestKey, requests[0].key);
  assert.equal(changed, 0);
  recoverable = true;
  await ui.click(ui.button('查詢原請求'));
  assert.equal(readPendingManualPayment(window.localStorage), null);
  assert.equal(changed, 1); assert.equal(requests.length, 1);
  assert.match(document.body.textContent, /財務首頁讀回確認/);
});

test('cancelled order opens refund mode and disables receiving money', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ ...detail, status: 'cancelled' }));
  const ui = await mount(t, IronGateManualPaymentPanel, { bookingId, canRecord: true, onChange: () => {} });
  await ui.click(ui.button('登記收付'));
  const radios = document.querySelectorAll('input[type=radio]');
  assert.equal(radios[0].disabled, true);
  assert.equal(radios[1].checked, true);
  assert.ok(document.querySelector('[aria-label="對應原收款"]'));
});

test('reload retains original payload and safely retries a request that never reached the server', async t => {
  const attempts = []; let changed = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (options.method === 'POST') {
      attempts.push({ key: options.headers['idempotency-key'], payload: JSON.parse(options.body) });
      if (attempts.length === 1) throw Error('offline before send');
      return Response.json({ bookingId, paymentEventId: attempts[0].key, financeVerified: true });
    }
    if (String(url).includes('/payment-requests/')) return Response.json({ code: 'REQUEST_NOT_FOUND' }, { status: 404 });
    return Response.json(detail);
  });
  const props = { bookingId, canRecord: true, onChange: () => changed++ };
  const ui = await mount(t, IronGateManualPaymentPanel, props);
  await ui.click(ui.button('登記收付'));
  await ui.fill(document.getElementById('iron-gate-payment-amount'), '100');
  await ui.fill(document.getElementById('iron-gate-payment-at'), '2026-10-01T09:00');
  await ui.fill(document.getElementById('iron-gate-payment-evidence'), 'SYNTHETIC-OFFLINE');
  await act(() => document.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
  assert.ok(readPendingManualPayment(window.localStorage)?.payload);
  await act(() => ui.root.render(createElement(IronGateManualPaymentPanel, { ...props, key: 'reload' })));
  await ui.click(ui.button('查詢原請求'));
  await ui.click(ui.button('重試原收付款'));
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(changed, 1); assert.equal(readPendingManualPayment(window.localStorage), null);
});
