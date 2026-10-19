import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { customerCalendarProjection } from '../src/lib/customer-workspaces/calendar-parity.ts';
import { MonthScroller } from '../src/components/calendar/calendar-views.tsx';
import { BookingIdentity, bookingIdentityText } from '../src/components/calendar/booking-identity.tsx';

test('website hold cards expose their direct channel and hold state instead of a source-conflict label', () => {
  const property = { id: 'p', name: 'Synthetic Inn', rooms: [{ id: 'r', name: '101' }] };
  const booking = { id: 'b', propertyId: 'p', status: 'held', guestName: 'Synthetic guest',
    platform: 'Official Website', checkIn: '2026-10-25', checkOut: '2026-10-27', roomIds: ['r'],
    total: 36000, payments: [], entry: 'os', hold: { state: 'active', expiresAt: '2100-01-01T00:00:00Z' } };
  const projected = customerCalendarProjection({ role: 'owner', bookings: [booking] }, property);
  const row = projected.bookings[0];
  assert.match(bookingIdentityText(row), /直訂.*保留中.*Synthetic guest/);
  const identity = renderToStaticMarkup(createElement(BookingIdentity, { booking: row }));
  assert.match(identity, /保留中/); assert.doesNotMatch(identity, /待核對/);
  const month = renderToStaticMarkup(createElement(MonthScroller, {
    ...projected, months: ['2026-10-01'], targetMonth: '2026-10-01',
    onSelectBooking() {}, onSelectDay() {}, onVisibleMonthChange() {},
  }));
  const labels = month.match(/aria-label="[^"]+"/g) ?? [];
  assert.ok(labels.some(label => label.includes('直訂｜保留中｜Synthetic guest')), labels.join('\n'));
  assert.match(month, />保留中<\/span>/);
  assert.doesNotMatch(month, />待核對<\/span>/);
});
