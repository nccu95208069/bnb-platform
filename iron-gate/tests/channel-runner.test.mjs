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
