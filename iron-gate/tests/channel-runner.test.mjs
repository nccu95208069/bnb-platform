import test from "node:test";
import assert from "node:assert/strict";
import { reconcileChannelOperation } from "../src/channel-runner.mjs";

const propertyId = crypto.randomUUID(), operationKey = crypto.randomUUID();
const rooms = [crypto.randomUUID(), crypto.randomUUID()];
const cells = rooms.map((roomId) => ({ roomId, date: "2026-11-10", desired: "closed" }));

function harness({ failFirstWrite = false } = {}) {
  const stock = new Map(rooms.map((roomId) => [roomId, { count: 1, isLock: false }]));
  const writes = [], readbacks = [];
  const adapter = {
    wait: async () => {},
    withPropertyLease: async (_propertyId, fn) => fn(),
    loadOperation: async () => ({ key: operationKey, state: "sync_pending", cells }),
    recordReadback: async (evidence) => { readbacks.push(evidence); return evidence; },
    provider: {
      observe: async () => ({ observedAt: new Date().toISOString(),
        providerVersion: crypto.randomUUID(), cells: rooms.map((roomId) =>
          ({ roomId, date: "2026-11-10", ...stock.get(roomId) })) }),
      setNight: async (_propertyId, input) => {
        writes.push(input);
        if (failFirstWrite && writes.length === 1) {
          stock.set(input.roomId, { count: 0, isLock: true });
          throw Error("UNKNOWN_WRITE_OUTCOME");
        }
        stock.set(input.roomId, { count: 0, isLock: true });
      },
    },
  };
  return { adapter, writes, readbacks };
}

test("channel runner writes absolute desired state and submits a fresh full observation", async () => {
  const { adapter, writes, readbacks } = harness();
  await reconcileChannelOperation({ propertyId, operationKey, ...adapter });
  assert.equal(writes.length, 2);
  assert.equal(readbacks.length, 1);
  assert.equal(readbacks[0].cells.length, 2);
  assert.ok(readbacks[0].cells.every((cell) => cell.count === 0 && cell.isLock));
});

test("unknown provider write outcome stops further writes and exposes partial observation", async () => {
  const { adapter, writes, readbacks } = harness({ failFirstWrite: true });
  await reconcileChannelOperation({ propertyId, operationKey, ...adapter });
  assert.equal(writes.length, 1);
  assert.equal(readbacks.length, 1);
  assert.deepEqual(readbacks[0].cells.map((cell) => cell.count), [0, 1]);
});

test("incomplete provider observation prevents writes and readback submission", async () => {
  const { adapter, writes, readbacks } = harness();
  adapter.provider.observe = async () => ({ observedAt: new Date().toISOString(),
    providerVersion: "provider-v1", cells: [] });
  await assert.rejects(reconcileChannelOperation({ propertyId, operationKey, ...adapter }),
    { message: "PROVIDER_SNAPSHOT_INCOMPLETE" });
  assert.equal(writes.length, 0);
  assert.equal(readbacks.length, 0);
});

test("delayed OwlNest visibility is resolved by fresh GETs without a second PUT", async () => {
  const { adapter, writes, readbacks } = harness();
  const originalObserve = adapter.provider.observe;
  let postWriteReads = 0;
  adapter.provider.observe = async (...args) => {
    const snapshot = await originalObserve(...args);
    if (writes.length && ++postWriteReads === 1)
      return { ...snapshot, cells: snapshot.cells.map((cell) => ({ ...cell,
        count: 1, isLock: false })) };
    return snapshot;
  };
  const delays = [];
  adapter.wait = async (ms) => { delays.push(ms); };
  await reconcileChannelOperation({ propertyId, operationKey, ...adapter });
  assert.equal(writes.length, 2);
  assert.deepEqual(delays, [3000]);
  assert.equal(postWriteReads, 2);
  assert.ok(readbacks[0].cells.every((cell) => cell.count === 0 && cell.isLock));
});

test("moving a booking verifies new closed nights before reopening old nights", async () => {
  const oldRoom = rooms[0], newRoom = rooms[1];
  const stock = new Map([[oldRoom, { count: 0, isLock: true }],
    [newRoom, { count: 1, isLock: false }]]);
  const writes = [], observations = [];
  const result = await reconcileChannelOperation({ propertyId, operationKey,
    withPropertyLease: async (_id, fn) => fn(), wait: async () => {},
    loadOperation: async () => ({ key: operationKey, state: "sync_pending", cells: [
      { roomId: oldRoom, date: "2026-11-10", desired: "open" },
      { roomId: newRoom, date: "2026-11-10", desired: "closed" },
    ] }),
    recordReadback: async (evidence) => evidence,
    provider: {
      observe: async () => {
        const current = { observedAt: new Date().toISOString(), providerVersion: "v1",
          cells: [oldRoom, newRoom].map((roomId) =>
            ({ roomId, date: "2026-11-10", ...stock.get(roomId) })) };
        observations.push(current);
        return current;
      },
      setNight: async (_id, input) => {
        writes.push(input.desired);
        if (input.desired === "open") {
          assert.ok(observations.at(-1).cells.find((cell) => cell.roomId === newRoom).isLock);
        }
        stock.set(input.roomId, input.desired === "closed" ?
          { count: 0, isLock: true } : { count: 1, isLock: false });
      },
    },
  });
  assert.deepEqual(writes, ["closed", "open"]);
  assert.ok(result.cells.every((cell) =>
    cell.roomId === newRoom ? cell.isLock : !cell.isLock));
});

test("an unverified new closure leaves old nights closed", async () => {
  const oldRoom = rooms[0], newRoom = rooms[1];
  const writes = [];
  const result = await reconcileChannelOperation({ propertyId, operationKey,
    withPropertyLease: async (_id, fn) => fn(), wait: async () => {},
    loadOperation: async () => ({ key: operationKey, state: "sync_pending", cells: [
      { roomId: oldRoom, date: "2026-11-10", desired: "open" },
      { roomId: newRoom, date: "2026-11-10", desired: "closed" },
    ] }),
    recordReadback: async (evidence) => evidence,
    provider: {
      observe: async () => ({ observedAt: new Date().toISOString(), providerVersion: "v1",
        cells: [
          { roomId: oldRoom, date: "2026-11-10", count: 0, isLock: true },
          { roomId: newRoom, date: "2026-11-10", count: 1, isLock: false },
        ] }),
      setNight: async (_id, input) => { writes.push(input.desired); },
    },
  });
  assert.deepEqual(writes, ["closed"]);
  assert.equal(result.cells.find((cell) => cell.roomId === oldRoom).isLock, true);
});
