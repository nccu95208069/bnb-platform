import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectBookings } from '../src/lib/workspace-auth/projection.ts';

test('no-price calendar response does not expose source order aliases', () => {
  const [hidden] = projectBookings([{
    id: 'synthetic', property_id: 'sweetfun', room_rate: 100,
    external_order_no: 'OTA-PRIVATE', owlnest_order_no: 'OWL-PRIVATE',
    notification_order_id: 'SF-PRIVATE',
  }], { viewPrices: false, allProperties: true, propertyIds: [] });
  assert.equal(hidden.external_order_no, null);
  assert.equal(hidden.owlnest_order_no, null);
  assert.equal(hidden.notification_order_id, undefined);
});
