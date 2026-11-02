import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PaymentBadge } from '../src/components/calendar/payment-badge.tsx';
import { paymentStateForReview } from '../src/components/calendar/calendar-utils.ts';
import { projectBookings } from '../src/lib/workspace-auth/projection.ts';

const booking = { id: 'synthetic', property_id: 'sweetfun', price_hidden: true,
  payment_status: 'paid', payment_review_status: 'paid', source_payment_flag: 'done',
  source_payment_label: 'synthetic source flag', payments: [], audit_log: [], room_rate: 0 };

test('paid Iron Gate booking shades in payment review without exposing a room price', () => {
  assert.equal(paymentStateForReview(booking), 'paid');
  const badge = renderToStaticMarkup(createElement(PaymentBadge, { booking, compact: true }));
  assert.match(badge, /aria-label="已付清"/);
  assert.match(badge, /✓/);
  assert.equal(booking.price_hidden, true);
  assert.equal(booking.room_rate, 0);
});

test('no-price projection removes the paid marker before browser delivery', () => {
  const [hidden] = projectBookings([booking], { viewPrices: false,
    allProperties: false, propertyIds: ['sweetfun'] });
  assert.equal(hidden.payment_status, 'unknown');
  assert.equal(hidden.payment_review_status, undefined);
  assert.equal(hidden.source_payment_flag, undefined);
  assert.equal(paymentStateForReview(hidden), undefined);
  assert.equal(renderToStaticMarkup(createElement(PaymentBadge, { booking: hidden })), '');
});
