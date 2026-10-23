import { checkedOwlNestConfig, owlNestDayNumber } from "./owlnest-web-readback.mjs";

/**
 * Candidate request derived from OwlNest's public PlanView bundle. This is a
 * pure UI-value builder: it has no credential, HTTP client, serializer, retry,
 * or write path. The page wrapper also adds lang and encodes the object; its
 * live wire format and effect still require an isolated authenticated test.
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
    uiData: { stock_items: [{
      room_ids: [externalRoomId], week_days: [1, 2, 3, 4, 5, 6, 0],
      during_start_date: date, during_end_date: date, exclude_holiday: 0,
      count: desired === "closed" ? 0 : 1, safe_stock_check: 1,
      is_lock: desired === "closed" ? 1 : 0,
    }] },
  };
}
