import { buildOwlNestStockCommand } from "./owlnest-stock-command.mjs";
import { boundedOwlNestJson, createOwlNestWebReadback } from
  "./owlnest-web-readback.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Match the current OwlNest page's form-valued PUT for one stock cell. */
export function owlNestStockForm(command, lang = "zh_TW") {
  const item = command?.uiData?.stock_items?.[0];
  if (command?.method !== "PUT" || !item ||
    command.uiData.stock_items.length !== 1 ||
    !Array.isArray(item.room_ids) || item.room_ids.length !== 1 ||
    !Array.isArray(item.week_days) || item.week_days.length !== 7 ||
    ![0, 1].includes(item.is_lock) || ![0, 1].includes(item.count) ||
    ![0, 1].includes(item.safe_stock_check) ||
    !/^[A-Za-z_]{2,10}$/.test(lang)) throw Error("OWLNEST_INVALID_STOCK_COMMAND");
  const body = new URLSearchParams();
  body.set("lang", lang);
  body.set("stock_items[0][room_ids][]", String(item.room_ids[0]));
  for (const day of item.week_days) body.append("stock_items[0][week_days][]", String(day));
  for (const [field, value] of Object.entries({
    during_start_date: item.during_start_date,
    during_end_date: item.during_end_date,
    exclude_holiday: item.exclude_holiday,
    count: item.count,
    safe_stock_check: item.safe_stock_check,
    is_lock: item.is_lock,
  })) body.set(`stock_items[0][${field}]`, String(value));
  return body;
}

/**
 * Inert until injected into a channel runner. A successful PUT response is
 * only an acknowledgement; the runner must make a fresh GET and record its
 * exact per-night readback before releasing a booking fence. No retry here.
 */
export function createOwlNestWebProvider({ propertyConfigs, getAuthorization,
  fetchImpl = fetch, now = () => new Date() }) {
  const readback = createOwlNestWebReadback({ propertyConfigs, getAuthorization,
    fetchImpl, now });
  return {
    observe: readback.observe,
    async setNight(propertyId, input) {
      if (!input || Object.keys(input).sort().join(",") !==
        "date,desired,operationKey,roomId" || !UUID.test(input.operationKey ?? ""))
        throw Error("OWLNEST_INVALID_CELLS");
      const command = buildOwlNestStockCommand({ propertyConfigs, propertyId,
        roomId: input.roomId, date: input.date, desired: input.desired });
      let authorization;
      try { authorization = await getAuthorization(propertyId); }
      catch { throw Error("OWLNEST_AUTH_EXPIRED"); }
      if (typeof authorization !== "string" ||
        !/^Bearer [A-Za-z0-9._~+\/-]{20,}={0,2}$/.test(authorization) ||
        /undefined|null/i.test(authorization)) throw Error("OWLNEST_AUTH_EXPIRED");
      const url = new URL(command.url);
      url.searchParams.set("lang", "zh_tw");
      let response;
      try {
        response = await fetchImpl(url, { method: "PUT", cache: "no-store",
          redirect: "error", signal: AbortSignal.timeout(20_000),
          headers: { Authorization: authorization, Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest" },
          body: owlNestStockForm(command).toString() });
      } catch { throw Error("OWLNEST_WRITE_OUTCOME_UNKNOWN"); }
      if (!response || typeof response.status !== "number" ||
        typeof response.ok !== "boolean") throw Error("OWLNEST_WRITE_OUTCOME_UNKNOWN");
      if ([401, 403].includes(response.status)) throw Error("OWLNEST_AUTH_EXPIRED");
      if (!response.ok) throw Error("OWLNEST_WRITE_OUTCOME_UNKNOWN");
      const raw = await boundedOwlNestJson(response, 65_536);
      if (raw?.status === 30003) throw Error("OWLNEST_AUTH_EXPIRED");
      if (raw?.status !== 0) throw Error("OWLNEST_WRITE_OUTCOME_UNKNOWN");
      return { acknowledged: true };
    },
  };
}
