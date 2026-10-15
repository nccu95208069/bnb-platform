import { checkedOwlNestConfig, owlNestDayNumber } from "./owlnest-web-readback.mjs";

/**
 * Candidate request derived from OwlNest's public PlanView bundle. This is a
 * pure value builder: it has no credential, HTTP client, retry, or write path.
 * The live wire format and effect still require an isolated authenticated test.
 */
export function buildOwlNestStockCommand({ propertyConfigs, propertyId,
  roomId, date, desired }) {
  const config = checkedOwlNestConfig(propertyId, propertyConfigs?.[propertyId]);
  const externalRoomId = config.roomIds[roomId];
  if (!Number.isSafeInteger(externalRoomId) || !["open", "closed"].includes(desired))
    throw Error("OWLNEST_INVALID_CELLS");
  owlNestDayNumber(date);
  return {
    method: "PUT",
    url: `https://www.owlting.com/booking/v2/admin/hotels/${config.hotelId}/calendars/stock`,
    payload: { stock_items: [{
      room_ids: [externalRoomId], week_days: [1, 2, 3, 4, 5, 6, 0],
      during_start_date: date, during_end_date: date, exclude_holiday: 0,
      count: desired === "closed" ? 0 : 1, safe_stock_check: 1,
      is_lock: desired === "closed" ? 1 : 0,
    }] },
  };
}
