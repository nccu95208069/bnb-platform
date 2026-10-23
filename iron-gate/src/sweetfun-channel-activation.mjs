import { createHash } from "node:crypto";
import { checkPropertyIntegrity } from "./property-integrity.mjs";

const PROJECT_REF = "brcszrkwkgiwatrxevkf";
const SOURCE_SYSTEM = "sweetfun-calendar-sheet";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;
const MIN_HORIZON = 180;
const MAX_HORIZON = 410;
const key = (cell) => `${cell.roomId}|${cell.date}`;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const addDays = (day, count) => new Date(Date.parse(day + "T00:00:00Z") +
  count * DAY).toISOString().slice(0, 10);

function taipeiToday(now) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (name) => parts.find((item) => item.type === name)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function common(state, occupancy, manifest) {
  if (manifest?.projectRef !== PROJECT_REF ||
    !UUID.test(manifest.propertyId ?? "") || !UUID.test(manifest.workspaceId ?? "") ||
    !UUID.test(manifest.channelGrantId ?? "") ||
    state?.propertyId !== manifest.propertyId ||
    state.workspaceId !== manifest.workspaceId ||
    state.authorityEpoch !== 1 || state.readOnly !== false ||
    !Array.isArray(state.roomIds) || state.roomIds.length !== 6 ||
    new Set(state.roomIds).size !== 6 || !state.roomIds.every((id) => UUID.test(id)) ||
    !Array.isArray(state.manualBlocks) || !Array.isArray(state.sourceGrants) ||
    !state.sourceGrants.some((grant) => grant.active === true &&
      grant.sourceSystem === SOURCE_SYSTEM &&
      grant.sourceAccount === state.sweetfunImport?.sourceId) ||
    !checkPropertyIntegrity(state, occupancy).ok)
    throw Error("SWEETFUN_CHANNEL_PREFLIGHT_FAILED");
}

/** Pure, complete provider-stock preflight. No provider or database write here. */
export function planSweetfunChannelActivation(state, occupancy, manifest, snapshot,
  now = new Date()) {
  common(state, occupancy, manifest);
  if (state.version !== manifest.expectedVersion ||
    state.channel?.mode !== "none" || state.channel.ready !== false ||
    state.channel.grantId !== null || state.channel.websiteSalesEnabled !== false ||
    state.channel.sourceReadbackEnabled === true ||
    state.channelDispatch || state.manualBlocks.length ||
    state.operations.some((op) => ["sync_pending", "review_required"].includes(op.state)))
    throw Error("SWEETFUN_CHANNEL_PREFLIGHT_FAILED");
  const today = taipeiToday(now), end = snapshot?.endDate;
  const endMs = typeof end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(end) ?
    Date.parse(end + "T00:00:00Z") : NaN;
  const days = (endMs - Date.parse(today + "T00:00:00Z")) / DAY + 1;
  if (!Number.isSafeInteger(days) || days < MIN_HORIZON || days > MAX_HORIZON ||
    addDays(today, days - 1) !== end ||
    occupancy.some((row) => row.night > end) ||
    state.fences.some((fence) => fence.cells.some((cell) => cell.date >= today)) ||
    snapshot?.propertyId !== state.propertyId || snapshot.startDate !== today ||
    !Array.isArray(snapshot.cells) ||
    snapshot.cells.length !== state.roomIds.length * days ||
    typeof snapshot.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(snapshot.capturedAt)) ||
    now.getTime() - Date.parse(snapshot.capturedAt) < 0 ||
    now.getTime() - Date.parse(snapshot.capturedAt) > 10 * 60_000)
    throw Error("SWEETFUN_CHANNEL_SNAPSHOT_INVALID");
  const dates = Array.from({ length: days }, (_, index) => addDays(today, index));
  const expected = new Set(state.roomIds.flatMap((roomId) =>
    dates.map((date) => `${roomId}|${date}`)));
  const seen = new Set(), canonical = [];
  for (const cell of snapshot.cells) {
    const cellKey = key(cell);
    if (!expected.has(cellKey) || seen.has(cellKey) ||
      !Number.isSafeInteger(cell.count) || cell.count < 0 || cell.count > 100 ||
      typeof cell.isLock !== "boolean")
      throw Error("SWEETFUN_CHANNEL_SNAPSHOT_INVALID");
    seen.add(cellKey);
    canonical.push({ roomId: cell.roomId, date: cell.date,
      count: cell.count, isLock: cell.isLock });
  }
  if (seen.size !== expected.size) throw Error("SWEETFUN_CHANNEL_SNAPSHOT_INVALID");
  canonical.sort((a, b) => key(a).localeCompare(key(b)));
  const snapshotHash = hash(canonical);
  if (snapshotHash !== manifest.expectedSnapshotHash)
    throw Error("SWEETFUN_CHANNEL_SNAPSHOT_HASH_MISMATCH");
  const occupied = new Set(occupancy.filter((row) => row.night >= today &&
    row.night <= end).map((row) => `${row.room_id}|${row.night}`));
  const blocks = [];
  for (const cell of canonical) {
    const closed = cell.count === 0 || cell.isLock;
    if (occupied.has(key(cell)) && !closed)
      throw Error("SWEETFUN_CHANNEL_OCCUPIED_OPEN");
    if (!occupied.has(key(cell)) && closed)
      blocks.push({ roomId: cell.roomId, date: cell.date });
  }
  const next = structuredClone(state);
  next.version++;
  next.manualBlocks = blocks;
  next.channel = { mode: "owlnest", ready: true, sourceReadbackEnabled: true,
    stockObservedThrough: end,
    websiteSalesEnabled: false, grantId: manifest.channelGrantId, websiteBindingId: null };
  return { state: next, summary: { propertyId: state.propertyId,
    inventoryVersion: next.version, channelGrantId: manifest.channelGrantId,
    observedCells: canonical.length, stockObservedThrough: end,
    occupiedCells: occupied.size,
    importedBlocks: blocks.length, snapshotHash, blockHash: hash(blocks) } };
}

/** Only before any property write after activation; preserve imported blocks. */
export function planSweetfunChannelNoWriteRollback(state, occupancy, manifest) {
  common(state, occupancy, manifest);
  const blocks = [...state.manualBlocks].sort((a, b) => key(a).localeCompare(key(b)));
  if (state.version !== manifest.expectedVersion ||
    state.channel?.mode !== "owlnest" || state.channel.ready !== true ||
    state.channel.sourceReadbackEnabled !== true ||
    state.channel.grantId !== manifest.channelGrantId ||
    state.channel.websiteSalesEnabled !== false || state.channelDispatch ||
    state.operations.length !== manifest.expectedOperationCount ||
    hash(blocks) !== manifest.expectedBlockHash)
    throw Error("SWEETFUN_CHANNEL_ROLLBACK_UNSAFE");
  const next = structuredClone(state);
  next.version++;
  next.channel = { mode: "none", ready: false, sourceReadbackEnabled: false,
    websiteSalesEnabled: false, grantId: null, websiteBindingId: null };
  return { state: next, summary: { propertyId: state.propertyId,
    inventoryVersion: next.version, retainedBlocks: blocks.length } };
}
