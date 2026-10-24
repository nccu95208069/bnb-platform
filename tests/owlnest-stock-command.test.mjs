import test from "node:test";
import assert from "node:assert/strict";
import { buildOwlNestStockCommand } from "../src/owlnest-stock-command.mjs";

const propertyId = "00000000-0000-4000-8000-000000000011";
const roomId = "00000000-0000-4000-8000-000000000021";
const propertyConfigs = { [propertyId]: { hotelId: 6188, roomIds: { [roomId]: 101 } } };

test("stock command matches the current web editor's single-night absolute fields", () => {
  const base = { propertyConfigs, propertyId, roomId, date: "2026-11-10" };
  const closed = buildOwlNestStockCommand({ ...base, desired: "closed" });
  assert.equal(closed.method, "PUT");
  assert.equal(closed.url,
    "https://www.owlting.com/booking/v2/admin/hotels/6188/calendars/stock");
  assert.deepEqual(closed.uiData, { stock_items: [{
    room_ids: [101], week_days: [1, 2, 3, 4, 5, 6, 0],
    during_start_date: "2026-11-10", during_end_date: "2026-11-10",
    exclude_holiday: 0, count: 0, safe_stock_check: 1, is_lock: 1,
  }] });
  const open = buildOwlNestStockCommand({ ...base, desired: "open" });
  assert.equal(open.uiData.stock_items[0].count, 1);
  assert.equal(open.uiData.stock_items[0].is_lock, 0);
});

test("stock command cannot target an unconfigured property or room", () => {
  const base = { propertyConfigs, propertyId, roomId, date: "2026-11-10",
    desired: "closed" };
  assert.throws(() => buildOwlNestStockCommand({ ...base,
    propertyId: "00000000-0000-4000-8000-000000000099" }),
  { message: "OWLNEST_NOT_CONFIGURED" });
  assert.throws(() => buildOwlNestStockCommand({ ...base,
    roomId: "00000000-0000-4000-8000-000000000099" }),
  { message: "OWLNEST_INVALID_CELLS" });
  assert.throws(() => buildOwlNestStockCommand({ ...base, date: "2026-02-30" }),
    { message: "OWLNEST_INVALID_DAY" });
});
