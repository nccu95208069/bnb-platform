import test from "node:test";
import assert from "node:assert/strict";
import { runControlledOwlNestStockProbe } from
  "../src/owlnest-stock-probe.mjs";

const propertyId = "11111111-1111-4111-8111-111111111111";
const roomId = "22222222-2222-4222-8222-222222222222";
const date = "2026-11-10";
const probe = (overrides) => runControlledOwlNestStockProbe({ propertyId,
  roomId, date, checkSafeCell: async () => {}, ...overrides });
const cell = (count, isLock) => ({ roomId, date, count, isLock });

test("one close and one restore require exact readback of original stock", async () => {
  const calls = [], safety = [];
  let current = cell(1, false);
  const result = await probe({
    checkSafeCell: async ({ phase }) => { safety.push(phase); },
    provider: {
      observe: async () => { calls.push("GET"); return { cells: [current] }; },
      setNight: async (_property, input) => {
        calls.push(input.desired);
        current = input.desired === "closed" ? cell(0, true) : cell(1, false);
        return { acknowledged: true };
      },
    },
  });
  assert.equal(result.status, "verified");
  assert.equal(result.restored, true);
  assert.deepEqual(calls, ["GET", "GET", "closed", "GET", "open", "GET"]);
  assert.deepEqual(safety, ["preflight", "before_close", "before_restore"]);
});

test("unknown close acknowledgment is resolved by GET, with no close retry", async () => {
  const writes = [];
  let current = cell(1, false);
  const result = await probe({ provider: {
    observe: async () => ({ cells: [current] }),
    setNight: async (_property, input) => {
      writes.push(input.desired);
      current = input.desired === "closed" ? cell(0, true) : cell(1, false);
      if (input.desired === "closed") throw Error("connection reset after write");
      return { acknowledged: true };
    },
  } });
  assert.deepEqual(writes, ["closed", "open"]);
  assert.equal(result.status, "verified_with_unknown_ack");
  assert.equal(result.restored, true);
});

test("a changed baseline prevents every write", async () => {
  let writes = 0;
  const result = await probe({ provider: {
    observe: async () => ({ cells: [cell(0, true)] }),
    setNight: async () => { writes++; },
  } });
  assert.equal(result.status, "baseline_changed");
  assert.equal(writes, 0);
});

test("unverified close stops without a blind restore or retry", async () => {
  const writes = [];
  const result = await probe({ attempts: 2, provider: {
    observe: async () => ({ cells: [cell(1, false)] }),
    setNight: async (_property, input) => {
      writes.push(input.desired);
      throw Error("unknown result");
    },
  } });
  assert.equal(result.status, "close_unverified");
  assert.equal(result.restored, false);
  assert.deepEqual(writes, ["closed"]);
});

test("a new source conflict after close blocks reopening", async () => {
  const writes = [];
  let current = cell(1, false);
  const result = await probe({
    checkSafeCell: async ({ phase }) => {
      if (phase === "before_restore") throw Error("new booking");
    },
    provider: {
      observe: async () => ({ cells: [current] }),
      setNight: async (_property, input) => {
        writes.push(input.desired);
        current = cell(0, true);
        return { acknowledged: true };
      },
    },
  });
  assert.equal(result.status, "restore_blocked");
  assert.deepEqual(writes, ["closed"]);
});
