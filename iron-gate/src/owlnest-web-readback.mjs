import { createHash } from "node:crypto";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function dayNumber(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw Error("OWLNEST_INVALID_DAY");
  const parsed = Date.parse(value + "T00:00:00.000Z");
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value)
    throw Error("OWLNEST_INVALID_DAY");
  return parsed / DAY;
}

function checkedConfig(propertyId, config) {
  if (!UUID.test(propertyId) || !config || !Number.isSafeInteger(config.hotelId) ||
    config.hotelId <= 0 || !config.roomIds || typeof config.roomIds !== "object" ||
    Array.isArray(config.roomIds)) throw Error("OWLNEST_NOT_CONFIGURED");
  const mapped = Object.entries(config.roomIds);
  if (!mapped.length || mapped.length > 100 || mapped.some(([roomId, externalId]) =>
    !UUID.test(roomId) || !Number.isSafeInteger(externalId) || externalId <= 0) ||
    new Set(mapped.map(([, externalId]) => externalId)).size !== mapped.length)
    throw Error("OWLNEST_NOT_CONFIGURED");
  return config;
}

async function boundedJson(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw Error("OWLNEST_RESPONSE_TOO_LARGE");
  if (!response.body) throw Error("OWLNEST_RESPONSE_INVALID");
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw Error("OWLNEST_RESPONSE_TOO_LARGE");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error?.message === "OWLNEST_RESPONSE_TOO_LARGE") throw error;
    throw Error("OWLNEST_RESPONSE_INVALID");
  } finally {
    reader.releaseLock();
  }
}

/**
 * Read-only adapter for the login-backed OwlNest calendar request already used
 * by the OS. Credentials are supplied at call time and never stored or logged.
 * This does not implement an inventory writer or dispatch channel operations.
 */
export function createOwlNestWebReadback({ propertyConfigs, getAuthorization,
  fetchImpl = fetch, now = () => new Date() }) {
  if (!propertyConfigs || typeof getAuthorization !== "function" ||
    typeof fetchImpl !== "function" || typeof now !== "function")
    throw Error("OWLNEST_NOT_CONFIGURED");
  return {
    async observe(propertyId, requested) {
      const config = checkedConfig(propertyId, propertyConfigs[propertyId]);
      if (!Array.isArray(requested) || !requested.length || requested.length > 4096)
        throw Error("OWLNEST_INVALID_CELLS");
      const knownRooms = new Set(Object.keys(config.roomIds));
      const seen = new Set(), days = [];
      for (const cell of requested) {
        if (!cell || !knownRooms.has(cell.roomId)) throw Error("OWLNEST_INVALID_CELLS");
        const day = dayNumber(cell.date), key = `${cell.roomId}|${cell.date}`;
        if (seen.has(key)) throw Error("OWLNEST_INVALID_CELLS");
        seen.add(key); days.push(day);
      }
      const first = Math.min(...days), last = Math.max(...days);
      if (last - first > 90) throw Error("OWLNEST_INVALID_CELLS");
      let authorization;
      try { authorization = await getAuthorization(propertyId); }
      catch { throw Error("OWLNEST_AUTH_EXPIRED"); }
      if (typeof authorization !== "string" ||
        !/^Bearer [A-Za-z0-9._~+\/-]{20,}={0,2}$/.test(authorization) ||
        /undefined|null/i.test(authorization)) throw Error("OWLNEST_AUTH_EXPIRED");
      const url = new URL(`https://www.owlting.com/booking/v2/admin/hotels/${config.hotelId}/calendars`);
      url.search = new URLSearchParams({
        during_start_date: new Date(first * DAY).toISOString().slice(0, 10),
        during_end_date: new Date(last * DAY).toISOString().slice(0, 10),
      }).toString();
      let response;
      try {
        response = await fetchImpl(url, { method: "GET", cache: "no-store",
          redirect: "error", signal: AbortSignal.timeout(20_000),
          headers: { Authorization: authorization, Accept: "application/json",
            "X-Requested-With": "XMLHttpRequest" } });
      } catch { throw Error("OWLNEST_READ_FAILED"); }
      if (!response || typeof response.status !== "number" ||
        typeof response.ok !== "boolean") throw Error("OWLNEST_READ_FAILED");
      if ([401, 403].includes(response.status)) throw Error("OWLNEST_AUTH_EXPIRED");
      if (!response.ok) throw Error("OWLNEST_READ_FAILED");
      const raw = await boundedJson(response);
      if (raw?.status === 30003) throw Error("OWLNEST_AUTH_EXPIRED");
      if (raw?.status !== 0 || !Array.isArray(raw.data)) throw Error("OWLNEST_RESPONSE_INVALID");
      const byExternalId = new Map(Object.entries(config.roomIds).map(([roomId, externalId]) =>
        [externalId, roomId]));
      const wanted = new Set(seen), stock = new Map(), roomSeen = new Set();
      for (const room of raw.data) {
        const roomId = byExternalId.get(room?.room_id);
        if (!roomId) continue;
        if (roomSeen.has(roomId) || !Array.isArray(room.stocks))
          throw Error("OWLNEST_RESPONSE_INVALID");
        roomSeen.add(roomId);
        for (const item of room.stocks) {
          const key = `${roomId}|${item?.date}`;
          if (!wanted.has(key)) continue;
          if (stock.has(key) || !Number.isSafeInteger(item.count) || item.count < 0 ||
            item.count > 100 || ![true, false, 0, 1].includes(item.is_lock))
            throw Error("OWLNEST_RESPONSE_INVALID");
          stock.set(key, { roomId, date: item.date, count: item.count,
            isLock: Boolean(item.is_lock) });
        }
      }
      if (stock.size !== wanted.size) throw Error("OWLNEST_RESPONSE_INCOMPLETE");
      const cells = requested.map((cell) => stock.get(`${cell.roomId}|${cell.date}`));
      const observedAt = now().toISOString();
      const providerVersion = createHash("sha256").update(JSON.stringify({
        hotelId: config.hotelId, cells: [...cells].sort((a, b) =>
          a.roomId.localeCompare(b.roomId) || a.date.localeCompare(b.date)),
      })).digest("hex");
      return { observedAt, providerVersion, cells };
    },
  };
}
