import type { Booking, BookingRetention, PropertyState, SourceEventInput } from "./types.ts";
import { isOsDirectBooking, originalDirectOrderRef } from "./os-direct-booking.ts";

type SourceIdentity = Pick<BookingRetention, "sourceAliases" | "sourceOrderRef">;
const text = (value: unknown): string => String(value ?? "").trim();
const platform = (value: unknown): string => {
  const normalized = text(value).toLowerCase();
  return normalized === "booking.com" ? "booking" : normalized;
};
const aliasKey = (alias: SourceIdentity["sourceAliases"][number]) =>
  JSON.stringify([alias.sourceSystem, alias.sourceAccount, alias.externalOrderId]);

/** Offland's Q/J identity is an import fact, independent of the current stay,
 * price, and booking version. It must never be inferred from a guest name. */
export function originalOfflandOrderRef(booking: Booking): string | null {
  const snapshot = booking.offlandSnapshot;
  const rows = snapshot?.rows, group = snapshot?.groupKey;
  if (booking.source !== "external" || !Array.isArray(rows) || !rows.length ||
    typeof group !== "string" ||
    !/^(?:Q:[A-Za-z0-9-]{8,128}|J:[A-Za-z0-9_-]{8,100})$/.test(group) ||
    !rows.every(row => Array.isArray(row?.values) && row.values.length === 17 &&
      group === (group.startsWith("Q:") ? `Q:${text(row.values[16])}` : `J:${text(row.values[9])}`)))
    return null;
  return group;
}

/** Independent of normal edit eligibility: an authenticated owner may take over
 * an exact, authoritative Offland import without pretending it was native. */
export function retentionSourceIdentity(state: PropertyState, booking: Booking): SourceIdentity | null {
  if (booking.retention) {
    const retention = booking.retention;
    return retention.schema === 1 && Number.isSafeInteger(retention.lifecycleRevision) &&
      retention.lifecycleRevision > 0 && Array.isArray(retention.history) && retention.history.length > 0 &&
      Array.isArray(retention.sourceAliases) && Array.isArray(retention.sourceReviews)
      ? { sourceAliases: structuredClone(retention.sourceAliases), sourceOrderRef: retention.sourceOrderRef }
      : null;
  }
  const links = state.sourceLinks.filter(link => link.bookingId === booking.id);
  if (links.some(link => link.diverged || link.lastAppliedBookingVersion !== booking.version)) return null;
  if (booking.source === "os" || booking.source === "line")
    return { sourceAliases: links.map(({ sourceSystem, sourceAccount, externalOrderId }) =>
      ({ sourceSystem, sourceAccount, externalOrderId })), sourceOrderRef: null };
  if (booking.source !== "external" || links.length !== 1 || links[0].tombstoneNights.length)
    return null;
  const offlandRef = originalOfflandOrderRef(booking);
  const directRef = isOsDirectBooking(booking) ? originalDirectOrderRef(booking) : null;
  const sourceOrderRef = offlandRef ?? directRef;
  if (!sourceOrderRef || links[0].externalOrderId !== sourceOrderRef) return null;
  if (offlandRef && (links[0].sourceSystem !== "offland-calendar-sheet" ||
    state.offlandImport && state.offlandImport.sourceId !== links[0].sourceAccount)) return null;
  const alias = { sourceSystem: links[0].sourceSystem, sourceAccount: links[0].sourceAccount,
    externalOrderId: links[0].externalOrderId };
  const aliases = new Map([[aliasKey(alias), alias]]);
  // A later export can regroup Q children as individual J rows. Those rows
  // already belong to this order, even after its old room nights are released.
  const rows = offlandRef ? booking.offlandSnapshot?.rows : booking.sweetfunSnapshot?.rows;
  if (Array.isArray(rows)) for (const row of rows) {
    const ids = [`J:${text(row?.values?.[9])}`,
      `${offlandRef ? "Q" : "L"}:${text(row?.values?.[offlandRef ? 16 : 11])}`];
    for (const id of ids) if (/^(?:Q:[A-Za-z0-9-]{8,128}|L:[A-Za-z0-9-]{8,64}|J:[A-Za-z0-9_-]{8,100})$/.test(id)) {
      const next = { ...alias, externalOrderId: id };
      aliases.set(aliasKey(next), next);
    }
  }
  return { sourceAliases: [...aliases.values()], sourceOrderRef };
}

/** Resolve all proven owners, not the first plausible guest/stay match. The
 * caller quarantines even ambiguous ownership without inventing occupancy. */
export function retainedSourceOwners(state: PropertyState, input: Pick<SourceEventInput,
  "sourceSystem" | "sourceAccount" | "externalOrderId" | "platform" | "externalOrderNo">): Booking[] {
  const exactKey = aliasKey(input);
  return state.bookings.filter(booking => {
    if (!booking.retention) return false;
    if (state.sourceLinks.some(link => link.bookingId === booking.id && aliasKey(link) === exactKey) ||
      booking.retention.sourceAliases.some(alias => aliasKey(alias) === exactKey)) return true;
    if (!input.platform || !input.externalOrderNo) return false;
    if (booking.sourceCalendar && platform(booking.sourceCalendar.platform) === platform(input.platform) &&
      booking.sourceCalendar.externalOrderNo === input.externalOrderNo) return true;
    const rows = booking.offlandSnapshot?.rows ?? booking.sweetfunSnapshot?.rows;
    const column = booking.offlandSnapshot ? 16 : 13;
    return Array.isArray(rows) && rows.length > 0 && rows.every(row =>
      platform(row?.values?.[2]) === platform(input.platform) &&
      text(row?.values?.[column]) === input.externalOrderNo);
  });
}
