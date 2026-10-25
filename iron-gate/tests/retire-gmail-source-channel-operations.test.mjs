import test from "node:test";
import assert from "node:assert/strict";
import { validateRetirementManifest, retirementSql } from
  "../scripts/retire-gmail-source-channel-operations.mjs";

const target = { bookingId: "11111111-1111-4111-8111-111111111111",
  operationKey: "22222222-2222-4222-8222-222222222222",
  externalOrderId: "L:OBESYNTHETIC001",
  expectedSourceVersion: `gmail-v1:1792859314000:${"a".repeat(64)}`,
  expectedDiverged: false };
const manifest = { schema: 1, propertyId: "95ae9bd1-5e6d-4386-be5b-6af3c5668a16",
  expectedAuthorityEpoch: 1, expectedCurrentVersion: 99, targets: [target] };

test("retirement requires exact linked source and preserves the separate review fence", () => {
  assert.deepEqual(validateRetirementManifest(manifest), manifest);
  const sql = retirementSql(manifest);
  assert.match(sql, /ROLLBACK;$/);
  assert.match(retirementSql(manifest, false), /COMMIT;$/);
  assert.match(sql, /channelDispatch/);
  assert.match(sql, /occupied_room_nights/);
  assert.match(sql, /retired_source_managed/);
  assert.match(sql, /f->>'key'<>target->>'operationKey'/);
  assert.doesNotMatch(sql, /provider\.observe|provider\.write|UPDATE .*occupied_room_nights/);
  assert.throws(() => validateRetirementManifest({ ...manifest,
    targets: [{ ...target, externalOrderId: "L:OTHER001" }] }), /INVALID_RETIREMENT_TARGET/);
  assert.throws(() => validateRetirementManifest({ ...manifest,
    targets: [target, target] }), /INVALID_RETIREMENT_TARGET/);
});
