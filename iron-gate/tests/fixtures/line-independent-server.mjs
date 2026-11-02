// Synthetic loopback fixture for the paired GCO wire acceptance script.
// No database, external provider, production config or secret is loaded.
import { MemoryPropertyRepository } from "../../src/memory-repository.ts";
import { IronGateService } from "../../src/service.ts";
import { createHandler } from "../../src/http.ts";
import { createNodeServer } from "../../src/node-server.mjs";
import { createGrantAuthenticator } from "../../src/authenticator.mjs";
import { createLineOperatorProofVerifier } from "../../src/line-operator-proof.mjs";
import { createChannelWorker } from "../../src/channel-worker.mjs";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const propertyId = "22222222-2222-4222-8222-222222222222";
const roomId = "00000000-0000-4000-8000-000000000012";
const channelGrant = "99999999-9999-4999-8999-999999999999";
const grant = {credentialId: "66666666-6666-4666-8666-666666666666", workspaceId, propertyId,
  grantId: "77777777-7777-4777-8777-777777777777", authorityEpoch: 1,
  clientId: "synthetic", subjectId: "synthetic", origin: "line", lineGroupId: "synthetic-line-group",
  lineActorIds: ["synthetic-staff"], lineManageAllEnabled: true, lineInventoryEnabled: true,
  actions: ["booking:read", "booking:amend", "booking:cancel", "booking:manage_all", "inventory:write"], fields: []};
const cell = {roomId, date: "2099-11-10"};
const repository = new MemoryPropertyRepository();
repository.seed({workspaceId, propertyId, roomIds: [roomId], authorityEpoch: 1, version: 7, readOnly: false,
  channel: {mode: "owlnest", ready: true, sourceReadbackEnabled: true, grantId: channelGrant,
    stockObservedFrom: "2099-01-01", stockObservedThrough: "2099-12-31"}, sourceGrants: [],
  bookings: [{id: "33333333-3333-4333-8333-333333333333", version: 1, status: "confirmed",
    channelSyncState: "awaiting_manual_sync", channelOperationKey: null,
    stays: [{checkIn: cell.date, checkOut: "2099-11-11", roomIds: [roomId]}]}],
  sourceLinks: [], operations: [], receipts: [], manualBlocks: [cell],
  fences: [{key: "os-pending", cells: [cell], reason: "channel_pending"}]});
const projection = s => JSON.stringify([s.version, s.bookings, s.manualBlocks, s.fences, s.sourceLinks]);
let expected = projection(await repository.read(propertyId)), writes = 0;
let actual = {count: 0, isLock: false};
const service = new IronGateService(repository, "p".repeat(43));
const principal = {clientId: "synthetic-channel", subjectId: "synthetic-channel", origin: "channel",
  workspaceId, propertyIds: [propertyId], authorityEpoch: 1, grantId: channelGrant,
  actions: ["channel:verify"], fields: []};
const worker = createChannelWorker({repository, service, onReview: async () => {}, provider: {
  async observe(_id, cells) {return {observedAt: new Date().toISOString(), providerVersion: `synthetic-${writes}`,
    cells: cells.map(c => ({roomId: c.roomId, date: c.date, ...actual}))};},
  async setNight(_id, target) {writes++; actual = target.desired === "closed" ?
    {count: 0, isLock: true} : {count: 1, isLock: false};}}});
const jobs = [];
const auth = createGrantAuthenticator({lookup: async token => token === "c".repeat(43) ? grant : null},
  repository, null, createLineOperatorProofVerifier("b".repeat(43)));
const handle = createHandler(service, auth, job => {
  jobs.push(worker.runOne(principal, job.propertyId, job.operationKey));
});
const server = createNodeServer(async request => {
  const path = new URL(request.url).pathname;
  if (path === "/fixture-os-edit" && request.method === "POST") {
    await repository.transact(propertyId, s => {s.version++; s.bookings[0].version++;});
    expected = projection(await repository.read(propertyId));
    return Response.json({edited: true});
  }
  if (path === "/fixture-state" && request.method === "GET") {
    await Promise.all(jobs);
    const state = await repository.read(propertyId);
    return Response.json({writes, osUnchanged: expected === projection(state),
      operations: state.operations.length, verified: state.operations.every(o => o.state === "sync_verified")});
  }
  return handle(request);
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({base: `http://127.0.0.1:${server.address().port}`}) + "\n"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
