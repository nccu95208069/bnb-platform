import test from "node:test";
import assert from "node:assert/strict";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { IronGateService } from "../src/service.ts";
import { createBusinessReport } from "../src/business-report.ts";
import { firstGmailNotification, firstNotificationAt, notificationCoverageFrom } from "../src/source-notification.ts";
import { planSourceNotificationRecovery, sourceNotificationRecoverySql } from "../src/source-notification-recovery.mjs";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const grantId = "44444444-4444-4444-8444-444444444444";
const sourceSystem = "sweetfun-calendar-sheet", sourceAccount = "synthetic-sheet";
const receivedAt = "2026-10-22T16:01:00.000Z";
const sourceVersion = `gmail-v1:${Date.parse(receivedAt)}:${"a".repeat(64)}`;
const requestKey = "55555555-5555-5555-8555-555555555555";
const reviewNow = new Date("2026-10-24T03:00:00.000Z");
const actor = { origin: "source", clientId: "synthetic-gmail-writer", subjectId: "gmail-order-handler",
  workspaceId, propertyIds: [propertyId], authorityEpoch: 1, grantId,
  actions: ["source:write"], fields: [], sourceSystem, sourceAccount };
const input = { propertyId, sourceSystem, sourceAccount, externalOrderId: "L:SYNTHETIC-ONLY",
  sourceVersion, previousSourceVersion: null, kind: "upsert", expectedInventoryVersion: 1,
  stays: [{ roomIds: [roomId], checkIn: "2027-01-03", checkOut: "2027-01-05" }],
  guestName: "PRIVATE-SYNTHETIC-GUEST", bookedAt: null, totalCents: null, currency: "TWD", platform: "booking" };

function setup() {
  const repository = new MemoryPropertyRepository();
  repository.seed({ workspaceId, propertyId, roomIds: [roomId], version: 1, authorityEpoch: 1, readOnly: false,
    channel: { mode: "none", ready: false, websiteSalesEnabled: false, grantId: null, websiteBindingId: null },
    sourceGrants: [{ grantId, sourceSystem, sourceAccount, active: true }],
    bookings: [], sourceLinks: [], receipts: [], operations: [], manualBlocks: [], fences: [] });
  return { repository, service: new IronGateService(repository) };
}

async function recoveryFixture(key = requestKey) {
  const { repository, service } = setup();
  await service.applySourceEvent(actor, key, input);
  await service.enrichSourceFacts(actor, crypto.randomUUID(), { propertyId, sourceSystem, sourceAccount,
    externalOrderId: input.externalOrderId, sourceVersion, expectedInventoryVersion: 2,
    expectedBookingVersion: 1, totalCents: 123400, currency: "TWD", platform: "booking", externalOrderNo: null });
  const state = await repository.read(propertyId);
  // Simulates a pre-release create whose original immutable metadata was absent.
  delete state.sourceLinks[0].firstNewOrderNotification;
  const snapshot = { schema: 1, propertyId, workspaceId, authorityEpoch: 1,
    inventoryVersion: state.version, readOnly: false, stateSha256: "a".repeat(64), auditSha256: "b".repeat(64),
    sourceGrants: state.sourceGrants, sourceLinks: state.sourceLinks, receipts: state.receipts,
    audits: repository.auditRecords(propertyId),
    bookings: state.bookings.map((b) => ({ id: b.id, source: b.source, sourceKey: b.sourceKey,
      createdAt: b.createdAt, bookedAt: b.bookedAt, version: b.version, status: b.status,
      hasSweetfunSnapshot: false, hasOsSnapshot: false, hasSourceCalendar: true, lineOverridePending: false })) };
  const manifest = { schema: 1, propertyId, workspaceId, authorityEpoch: 1,
    expectedInventoryVersion: state.version, sourceAccount, clientId: actor.clientId,
    subjectId: actor.subjectId, grantId, sourceVersions: [sourceVersion], recoveryKey: crypto.randomUUID(),
    notificationCoverageFrom: "2026-10-25" };
  return { snapshot, manifest, state };
}

test("first notification survives idempotent replay, amount repair, later amendments and cancellation", async () => {
  const { repository, service } = setup();
  const created = await service.applySourceEvent(actor, requestKey, input);
  const first = (await repository.read(propertyId)).sourceLinks[0].firstNewOrderNotification;
  assert.equal(first.receivedAt, receivedAt);
  assert.equal((await service.applySourceEvent(actor, requestKey, input)).bookingId, created.bookingId);
  assert.equal(repository.auditRecords(propertyId).length, 1);
  await service.enrichSourceFacts(actor, crypto.randomUUID(), { propertyId, sourceSystem, sourceAccount,
    externalOrderId: input.externalOrderId, sourceVersion, expectedInventoryVersion: 2,
    expectedBookingVersion: 1, totalCents: 123400, currency: "TWD", platform: "booking", externalOrderNo: null });
  const amendedVersion = `gmail-v1:${Date.parse("2026-10-23T16:30:00Z")}:${"b".repeat(64)}`;
  await service.applySourceEvent(actor, crypto.randomUUID(), { ...input, expectedInventoryVersion: 3,
    previousSourceVersion: sourceVersion, sourceVersion: amendedVersion, totalCents: 123400 });
  let state = await repository.read(propertyId);
  assert.deepEqual(state.sourceLinks[0].firstNewOrderNotification, first);
  assert.equal(state.bookings[0].bookedAt, null);
  assert.equal(firstNotificationAt(state, state.bookings[0]), receivedAt);
  const report = createBusinessReport(state, () => false, new Date("2026-10-24T03:00:00Z"));
  assert.equal(report.yesterday.orders, 1);
  assert.equal(report.yesterday.detail[0].countedDate, "2026-10-23");
  assert.equal(report.yesterday.detail[0].dateBasis, "notification");
  assert.equal(report.yesterday.detail[0].bookingDate, null);
  assert.equal(report.yesterday.detail[0].leadDays, null);
  assert.equal(report.meta.unknownBookingDateOrders, 1);
  assert.equal(report.meta.unknownDailyDateOrders, 0);
  for (const privateValue of [created.bookingId, sourceVersion, requestKey, input.guestName, input.externalOrderId])
    assert.ok(!JSON.stringify(report).includes(privateValue));
  await service.applySourceEvent(actor, crypto.randomUUID(), { ...input, kind: "cancel",
    expectedInventoryVersion: state.version, previousSourceVersion: amendedVersion,
    sourceVersion: `gmail-v1:${Date.parse("2026-10-24T01:00:00Z")}:${"c".repeat(64)}` });
  state = await repository.read(propertyId);
  assert.deepEqual(state.sourceLinks[0].firstNewOrderNotification, first);
  assert.equal(state.bookings[0].bookedAt, null);
  assert.equal(createBusinessReport(state, () => false).meta.orderCount, 0);
});

test("untrusted writer, invalid version, future notice and later legacy amendment cannot establish first notice", async () => {
  for (const [who, version] of [[{ ...actor, subjectId: "another-source" }, sourceVersion],
    [actor, "unstructured-version"], [actor, `gmail-v1:9999999999999:${"a".repeat(64)}`]]) {
    const { repository, service } = setup();
    await service.applySourceEvent(who, crypto.randomUUID(), { ...input, sourceVersion: version });
    assert.equal((await repository.read(propertyId)).sourceLinks[0].firstNewOrderNotification, undefined);
  }
  const { repository, service } = setup();
  await service.applySourceEvent(actor, requestKey, input);
  await repository.transact(propertyId, (draft) => { delete draft.sourceLinks[0].firstNewOrderNotification; });
  await service.applySourceEvent(actor, crypto.randomUUID(), { ...input, previousSourceVersion: sourceVersion,
    expectedInventoryVersion: 2, sourceVersion: `gmail-v1:${Date.parse("2026-10-23T10:00:00Z")}:${"b".repeat(64)}` });
  const state = await repository.read(propertyId);
  assert.equal(state.sourceLinks[0].firstNewOrderNotification, undefined);
  assert.equal(firstNotificationAt(state, state.bookings[0]), null);
});

test("report requires exact creation receipt and never uses the latest mutable source version", async () => {
  const { repository, service } = setup();
  await service.applySourceEvent(actor, requestKey, input);
  const before = await repository.read(propertyId);
  for (const mutate of [
    (s) => { s.receipts = []; },
    (s) => { s.receipts[0].subjectId = "wrong-source"; },
    (s) => { s.sourceLinks[0].firstNewOrderNotification.receivedAt = "2026-10-24T01:00:00.000Z"; },
    (s) => { s.bookings[0].sweetfunSnapshot = {}; },
  ]) { const state = structuredClone(before); mutate(state); assert.equal(firstNotificationAt(state, state.bookings[0]), null); }
  before.sourceLinks[0].sourceVersion = "gmail-v1:9999999999999:" + "d".repeat(64);
  assert.equal(firstNotificationAt(before, before.bookings[0]), receivedAt);
});

test("service-valid UUID4 is accepted with the same source creation evidence; malformed UUID is not", async () => {
  const key = crypto.randomUUID();
  const { snapshot, manifest } = await recoveryFixture(key);
  assert.equal(planSourceNotificationRecovery(snapshot, manifest, reviewNow).proof.entries[0].notification.requestKey, key);
  assert.equal(firstGmailNotification(sourceSystem, sourceVersion, "invalid", "2026-10-24T03:00:00.000Z"), null);
});

test("bounded recovery uses only original proven source events and does not mutate its input", async () => {
  const { snapshot, manifest } = await recoveryFixture();
  const before = structuredClone(snapshot), plan = planSourceNotificationRecovery(snapshot, manifest, reviewNow);
  assert.deepEqual(snapshot, before);
  assert.equal(plan.summary.candidates, 1);
  assert.deepEqual(plan.summary.receivedDays, { "2026-10-23": 1 });
  assert.equal(plan.summary.resultingInventoryVersion, snapshot.inventoryVersion + 1);
  assert.equal(plan.proof.entries[0].bookingVersion, 2);
  assert.equal(plan.proof.entries[0].notification.receivedAt, receivedAt);
  const sql = sourceNotificationRecoverySql(plan);
  assert.match(sql, /BEGIN ISOLATION LEVEL SERIALIZABLE/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /NOTIFICATION_RECOVERY_AUDIT_CHANGED/);
  assert.match(sql, /NOTIFICATION_RECOVERY_READBACK_MISMATCH/);
  assert.match(sql, /NOTIFICATION_RECOVERY_TARGET_COUNT_CHANGED/);
  assert.match(sql, /source\.notification_recorded/);
  assert.match(sql, /reporting\.policy_recorded/);
  assert.ok(!sql.includes("UPDATE iron_gate.occupied_room_nights"));
  assert.ok(!sql.includes("PRIVATE-SYNTHETIC-GUEST"));
});

test("recovery refuses changed scope, later source events, missing receipt, wrong actor, unknown audits and existing provenance", async () => {
  const fixture = await recoveryFixture();
  for (const mutate of [
    (s) => { s.inventoryVersion++; },
    (s) => { s.audits.push({ ...s.audits[0], bookingVersion: 3 }); },
    (s) => { s.receipts = s.receipts.filter((r) => r.key !== requestKey); },
    (s) => { s.audits[0].actorClientId = "another-writer"; },
    (s) => { s.audits[1].type = null; },
    (s) => { s.sourceLinks[0].firstNewOrderNotification = {}; },
    (s) => { s.bookings[0].hasSweetfunSnapshot = true; },
    (s) => { s.sourceLinks[0].diverged = true; },
    (s) => { s.audits[0].requestKey = "not-a-uuid"; },
    (s) => { s.bookings[0].createdAt = "2026-10-21T00:00:00.000Z"; },
  ]) {
    const snapshot = structuredClone(fixture.snapshot); mutate(snapshot);
    assert.throws(() => planSourceNotificationRecovery(snapshot, fixture.manifest, reviewNow), /NOTIFICATION_RECOVERY_/);
  }
});

test("coverage begins at an explicit future full Taipei day and cannot be inferred or moved backward", async () => {
  const now = new Date("2026-10-24T15:59:00.000Z");
  const good = { schema: 1, authorityEpoch: 1, recordedAt: "2026-10-24T03:00:00.000Z", notificationCoverageFrom: "2026-10-25" };
  assert.equal(notificationCoverageFrom({}, now), null);
  assert.equal(notificationCoverageFrom({ authorityEpoch: 1, reportingPolicy: good }, now), "2026-10-25");
  assert.equal(notificationCoverageFrom({ authorityEpoch: 2, reportingPolicy: good }, now), null);
  assert.equal(notificationCoverageFrom({ authorityEpoch: 1, reportingPolicy: { ...good, notificationCoverageFrom: "2026-10-24" } }, now), null);
  assert.equal(notificationCoverageFrom({ authorityEpoch: 1, reportingPolicy: { ...good, recordedAt: "2026-10-25T00:00:00.000Z" } }, now), null);
  const { snapshot, manifest } = await recoveryFixture();
  assert.throws(() => planSourceNotificationRecovery(snapshot, { ...manifest, notificationCoverageFrom: "2026-10-24" }, now), /COVERAGE_DAY_INVALID/);
  assert.throws(() => planSourceNotificationRecovery(snapshot, manifest, new Date("2026-10-24T16:00:00.000Z")), /COVERAGE_DAY_INVALID/);
  assert.throws(() => planSourceNotificationRecovery({ ...snapshot, reportingPolicy: { ...good, notificationCoverageFrom: "2026-10-26" } }, manifest, now), /COVERAGE_POLICY_CONFLICT/);
});
