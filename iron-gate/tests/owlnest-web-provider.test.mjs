import test from "node:test";
import assert from "node:assert/strict";
import { reconcileChannelOperation } from "../src/channel-runner.mjs";
import { buildOwlNestStockCommand } from "../src/owlnest-stock-command.mjs";
import { createOwlNestWebProvider, owlNestStockForm } from
  "../src/owlnest-web-provider.mjs";

const propertyId = "11111111-1111-4111-8111-111111111111";
const roomId = "22222222-2222-4222-8222-222222222222";
const operationKey = "33333333-3333-4333-8333-333333333333";
const propertyConfigs = { [propertyId]: { hotelId: 6188,
  roomIds: { [roomId]: 432 } } };
const token = `Bearer ${"a".repeat(43)}`;

test("stock form matches the page's form-valued one-night request", () => {
  const command = buildOwlNestStockCommand({ propertyConfigs, propertyId, roomId,
    date: "2026-11-10", desired: "closed" });
  const form = owlNestStockForm(command);
  assert.deepEqual(form.getAll("stock_items[0][room_ids][]"), ["432"]);
  assert.deepEqual(form.getAll("stock_items[0][week_days][]"),
    ["1", "2", "3", "4", "5", "6", "0"]);
  assert.equal(form.get("stock_items[0][count]"), "0");
  assert.equal(form.get("stock_items[0][is_lock]"), "1");
  assert.equal(form.get("stock_items[0][safe_stock_check]"), "1");
  assert.equal(form.get("stock_items[0][during_start_date]"), "2026-11-10");
  assert.equal(form.get("stock_items[0][during_end_date]"), "2026-11-10");
});

test("channel runner accepts stock change only after a fresh exact GET", async () => {
  let count = 1, lock = false, gets = 0, puts = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(url.hostname, "www.owlting.com");
    assert.equal(options.headers.Authorization, token);
    if (options.method === "PUT") {
      puts++;
      assert.equal(url.pathname,
        "/booking/v2/admin/hotels/6188/calendars/stock");
      assert.equal(url.searchParams.get("lang"), "zh_tw");
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("stock_items[0][room_ids][]"), "432");
      count = Number(form.get("stock_items[0][count]"));
      lock = form.get("stock_items[0][is_lock]") === "1";
      return new Response(JSON.stringify({ status: 0 }), { status: 200 });
    }
    gets++;
    return new Response(JSON.stringify({ status: 0, data: [{ room_id: 432,
      stocks: [{ date: "2026-11-10", count, is_lock: lock }] }] }), { status: 200 });
  };
  const provider = createOwlNestWebProvider({ propertyConfigs,
    getAuthorization: async () => token, fetchImpl });
  const recorded = await reconcileChannelOperation({ propertyId, operationKey,
    withPropertyLease: async (_property, run) => run(),
    loadOperation: async () => ({ key: operationKey, state: "sync_pending",
      cells: [{ roomId, date: "2026-11-10", desired: "closed" }] }),
    recordReadback: async (value) => value, provider });
  assert.equal(puts, 1);
  assert.equal(gets, 2);
  assert.equal(recorded.cells[0].count, 0);
  assert.equal(recorded.cells[0].isLock, true);
});

test("unknown PUT outcome is never retried and remains subject to GET", async () => {
  let gets = 0, puts = 0;
  const provider = createOwlNestWebProvider({ propertyConfigs,
    getAuthorization: async () => token,
    fetchImpl: async (_url, options) => {
      if (options.method === "PUT") { puts++; throw Error("connection closed"); }
      gets++;
      return new Response(JSON.stringify({ status: 0, data: [{ room_id: 432,
        stocks: [{ date: "2026-11-10", count: 1, is_lock: false }] }] }),
      { status: 200 });
    } });
  const recorded = await reconcileChannelOperation({ propertyId, operationKey,
    withPropertyLease: async (_property, run) => run(),
    loadOperation: async () => ({ key: operationKey, state: "sync_pending",
      cells: [{ roomId, date: "2026-11-10", desired: "closed" }] }),
    recordReadback: async (value) => value, provider });
  assert.equal(puts, 1);
  assert.equal(gets, 2);
  assert.equal(recorded.cells[0].count, 1);
});
