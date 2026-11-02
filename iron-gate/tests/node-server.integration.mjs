import test from "node:test";
import assert from "node:assert/strict";
import { MemoryPropertyRepository } from "../src/memory-repository.ts";
import { IronGateService } from "../src/service.ts";
import { createHandler } from "../src/http.ts";
import { createNodeServer } from "../src/node-server.mjs";

test("Node listener serves scoped booking requests over loopback", async () => {
  const workspaceId = crypto.randomUUID(), propertyId = crypto.randomUUID(), roomId = crypto.randomUUID();
  const repository = new MemoryPropertyRepository();
  repository.seed({ workspaceId, propertyId, roomIds: [roomId], version: 1,
    authorityEpoch: 1, channel: { mode: "none", ready: false,
      websiteSalesEnabled: false, grantId: null, websiteBindingId: null },
    sourceGrants: [], bookings: [], sourceLinks: [], operations: [], fences: [],
    manualBlocks: [], receipts: [] });
  const principal = { clientId: "synthetic-os", subjectId: "synthetic-member", origin: "os",
    workspaceId, propertyIds: [propertyId], authorityEpoch: 1,
    actions: ["booking:create", "booking:read"], fields: [] };
  const server = createNodeServer(createHandler(new IronGateService(repository), async () => principal));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const created = await fetch(`${base}/v1/properties/${propertyId}/bookings`, {
      method: "POST", headers: { "content-type": "application/json",
        "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ expectedInventoryVersion: 1,
        stays: [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [roomId] }],
        guestName: null, contact: null, notes: null, totalCents: null,
        bookedAt: null, source: "os" }),
    });
    assert.equal(created.status, 201);
    const receipt = await created.json();
    const read = await fetch(`${base}/v1/properties/${propertyId}/bookings/${receipt.bookingId}`);
    assert.equal(read.status, 200);
    assert.equal((await read.json()).id, receipt.bookingId);
    assert.equal(read.headers.get("cache-control"), "private, no-store");
  } finally {
    if (server.listening) await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});
