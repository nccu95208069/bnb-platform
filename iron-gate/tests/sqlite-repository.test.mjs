import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlitePropertyRepository } from "../src/sqlite-repository.mjs";
import { IronGateService } from "../src/service.ts";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
const principal = { clientId: "os", subjectId: "owner", origin: "os", workspaceId,
  propertyIds: [propertyId], authorityEpoch: 7,
  actions: ["booking:create", "booking:read", "booking:cancel"], fields: [] };
const state = () => ({ workspaceId, propertyId, roomIds: [roomId], version: 1, authorityEpoch: 7,
  channel: { mode: "none", ready: false, websiteSalesEnabled: false,
    grantId: null, websiteBindingId: null }, sourceGrants: [], bookings: [], sourceLinks: [],
  operations: [], fences: [], manualBlocks: [], receipts: [] });
const input = () => ({ expectedInventoryVersion: 1,
  stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }],
  guestName: null, contact: null, notes: null, totalCents: null, bookedAt: null, source: "os" });

test("committed booking and request receipt survive process-style reopen", async () => {
  const folder = mkdtempSync(join(tmpdir(), "iron-gate-"));
  const filename = join(folder, "bookings.sqlite");
  let repo;
  try {
    repo = new SqlitePropertyRepository(filename);
    await repo.seed(state());
    const requestKey = crypto.randomUUID();
    const first = await new IronGateService(repo).createBooking(principal, propertyId, requestKey, input());
    repo.close();
    repo = new SqlitePropertyRepository(filename);
    const service = new IronGateService(repo);
    assert.deepEqual(await service.createBooking(principal, propertyId, requestKey, input()), first);
    assert.equal((await repo.read(propertyId)).bookings.length, 1);
    assert.equal((await service.requestResult(principal, propertyId, requestKey)).bookingId, first.bookingId);
    const events = await repo.events(propertyId, 0, 10);
    assert.equal(events.length, 1);
    assert.equal(events[0].bookingId, first.bookingId);
    const audit = repo.auditRecords(propertyId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actorSubjectId, "owner");
    assert.equal(audit[0].requestKey, requestKey);
  } finally {
    repo?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("two connections serialize last-room writes and failed drafts roll back", async () => {
  const folder = mkdtempSync(join(tmpdir(), "iron-gate-"));
  const filename = join(folder, "bookings.sqlite");
  const firstRepo = new SqlitePropertyRepository(filename);
  const secondRepo = new SqlitePropertyRepository(filename);
  try {
    await firstRepo.seed(state());
    const firstService = new IronGateService(firstRepo);
    const secondService = new IronGateService(secondRepo);
    const outcomes = await Promise.allSettled([
      firstService.createBooking(principal, propertyId, crypto.randomUUID(), input()),
      secondService.createBooking(principal, propertyId, crypto.randomUUID(), input()),
    ]);
    assert.equal(outcomes.filter((value) => value.status === "fulfilled").length, 1);
    assert.equal((await secondRepo.read(propertyId)).bookings.length, 1);
    await assert.rejects(firstRepo.transact(propertyId, (draft) => {
      draft.bookings = [];
      throw Error("synthetic failure");
    }), /synthetic failure/);
    assert.equal((await firstRepo.read(propertyId)).bookings.length, 1);
    const beforeEvents = await firstRepo.events(propertyId, 0, 10);
    const beforeAudits = firstRepo.auditRecords(propertyId);
    await assert.rejects(firstRepo.transact(propertyId, (draft, tx) => {
      draft.bookings = [];
      tx.emit({ eventId: crypto.randomUUID(), at: new Date().toISOString(), type: "booking.cancelled",
        propertyId, bookingId: null, bookingVersion: null, inventoryVersion: draft.version });
      throw Error("synthetic failure after outbox");
    }), /synthetic failure after outbox/);
    assert.equal((await firstRepo.events(propertyId, 0, 10)).length, beforeEvents.length);
    assert.equal(firstRepo.auditRecords(propertyId).length, beforeAudits.length);
    await assert.rejects(firstRepo.transact(propertyId, (draft) => {
      draft.bookings.push({ ...draft.bookings[0], id: crypto.randomUUID() });
    }), /UNIQUE constraint failed/);
    assert.equal((await firstRepo.read(propertyId)).bookings.length, 1);
    await assert.rejects(firstRepo.transact(propertyId, async () => 1), /ASYNC_TRANSACTION_UNSUPPORTED/);
  } finally {
    firstRepo.close();
    secondRepo.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
