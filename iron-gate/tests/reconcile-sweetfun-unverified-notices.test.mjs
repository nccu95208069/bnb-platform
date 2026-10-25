import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { validateManifest, repairSql } from
  "../scripts/reconcile-sweetfun-unverified-notices.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function syntheticOrder({ orderId = "OBESYNTHETIC001", checkIn = "2026-11-09",
  checkOut = "2026-11-11", alias = "6200060561", version = 4 } = {}) {
  const sourceMessageId = "a".repeat(16);
  const event = {
    propertyId: "95ae9bd1-5e6d-4386-be5b-6af3c5668a16",
    sourceSystem: "sweetfun-calendar-sheet",
    sourceAccount: "1ZU1aJ4mLgysBz1UM84GLzljuWly8saF0p1HaNmAIBWc",
    externalOrderId: `L:${orderId}`,
    sourceVersion: `gmail-v1:1792841075000:${hash(sourceMessageId)}`,
    previousSourceVersion: null, kind: "upsert", expectedInventoryVersion: version - 1,
    stays: [{ checkIn, checkOut, roomIds: [randomUUID()] }],
    guestName: "Synthetic Guest", bookedAt: null, totalCents: 197000,
    currency: "TWD", platform: "booking", externalOrderNo: alias,
  };
  return { sourceMessageId, originalRequestKey: randomUUID(),
    originalRequestHash: hash(canonical({ action: "source:write", input: event })),
    originalReceiptVersion: version, bookingId: randomUUID(),
    repairRequestKey: randomUUID(),
    providerStatus: "confirmed", providerCheckedAt: "2026-10-25T11:25:00.000Z",
    event };
}
function manifest(orders = [syntheticOrder()]) {
  return { schema: 1, propertyId: "95ae9bd1-5e6d-4386-be5b-6af3c5668a16",
    expectedAuthorityEpoch: 1, expectedCurrentVersion: 10, orders };
}

test("repair manifest ties every room night to an unchanged source receipt", () => {
  const source = manifest();
  const checked = validateManifest(source);
  assert.deepEqual(checked.orders[0].cells.map((cell) => cell.date),
    ["2026-11-09", "2026-11-10"]);
  assert.match(checked.orders[0].sourceKey, /OBESYNTHETIC001/);
  assert.match(repairSql(source, true), /ROLLBACK;$/);
  assert.match(repairSql(source, false), /COMMIT;$/);
  assert.match(repairSql(source, true), /'channelSyncState','not_required'/);
  assert.doesNotMatch(repairSql(source, true), /'channel_pending'/);
  source.orders[0].event.guestName = "Changed Guest";
  assert.throws(() => validateManifest(source), /ORIGINAL_SOURCE_REQUEST_MISMATCH/);
});

test("repair refuses alias duplication, overlapping nights, and absent provider evidence", () => {
  const first = syntheticOrder();
  const second = syntheticOrder({ orderId: "OBESYNTHETIC002", alias: "6200060562" });
  second.sourceMessageId = "b".repeat(16);
  second.event.sourceVersion = `gmail-v1:1792841076000:${hash(second.sourceMessageId)}`;
  second.event.stays[0].roomIds = [...first.event.stays[0].roomIds];
  second.originalRequestHash = hash(canonical({ action: "source:write", input: second.event }));
  assert.throws(() => validateManifest(manifest([first, second])), /OVERLAPPING_REPAIR_ORDERS/);
  second.event.stays[0].roomIds = [randomUUID()];
  second.originalRequestHash = hash(canonical({ action: "source:write", input: second.event }));
  second.event.externalOrderNo = first.event.externalOrderNo;
  second.originalRequestHash = hash(canonical({ action: "source:write", input: second.event }));
  assert.throws(() => validateManifest(manifest([first, second])), /DUPLICATE_OTA_ALIAS/);
  second.event.externalOrderNo = "6200060562";
  second.originalRequestHash = hash(canonical({ action: "source:write", input: second.event }));
  second.providerStatus = "unknown";
  assert.throws(() => validateManifest(manifest([first, second])), /INVALID_REPAIR_ORDER/);
});

test("provider half-unit rounding preserves the signed notice and books the exact total", () => {
  const order = syntheticOrder();
  order.event.totalCents = 684300;
  order.originalRequestHash = hash(canonical({ action: "source:write", input: order.event }));
  order.providerTotalCents = 684250;
  order.providerNightTotalsCents = [332350, 351900];
  const checked = validateManifest(manifest([order]));
  assert.equal(checked.orders[0].event.totalCents, 684300);
  assert.equal(checked.orders[0].effectiveTotalCents, 684250);
  const sql = repairSql(manifest([order]), true);
  assert.match(sql, /'totalCents',\(o->>'effectiveTotalCents'\)::integer/);
  assert.match(sql, /providerVerifiedTotalCents/);
  order.providerNightTotalsCents = [332350, 351950];
  assert.throws(() => validateManifest(manifest([order])), /PROVIDER_AMOUNT_MISMATCH/);
  order.providerNightTotalsCents = [332350, 351900];
  order.providerTotalCents = 684200;
  assert.throws(() => validateManifest(manifest([order])), /PROVIDER_AMOUNT_MISMATCH/);
});
