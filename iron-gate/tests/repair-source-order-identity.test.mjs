import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIdentityRepair, identityRepairSql } from '../scripts/repair-source-order-identity.mjs';

const manifest = { schema: 1, propertyId: '95ae9bd1-5e6d-4386-be5b-6af3c5668a16',
  bookingId: '11111111-1111-4111-8111-111111111111', requestKey: '22222222-2222-4222-8222-222222222222',
  externalOrderId: 'L:OBESYNTHETIC', orderId: '1234567890', expectedInventoryVersion: 8,
  expectedBookingVersion: 2, expectedTotalCents: 100000,
  expectedSourceVersion: `gmail-v1:1792859314000:${'a'.repeat(64)}` };

test('identity repair refuses broadened, stale-shape or unvalidated private manifests', () => {
  assert.deepEqual(validateIdentityRepair(manifest), manifest);
  for (const patch of [{ propertyId: manifest.bookingId }, { expectedInventoryVersion: 0 },
    { expectedBookingVersion: 1.5 }, { expectedTotalCents: -1 }, { expectedSourceVersion: 'unknown' },
    { externalOrderId: "L:OBE';COMMIT;" }, { orderId: '' }, { force: true }, { bookingId: null }])
    assert.throws(() => validateIdentityRepair({ ...manifest, ...patch }), /INVALID_IDENTITY_REPAIR/);
  assert.match(identityRepairSql(manifest), /ROLLBACK;$/);
  assert.match(identityRepairSql(manifest, false), /COMMIT;$/);
});
