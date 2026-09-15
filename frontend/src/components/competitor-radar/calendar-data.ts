import type { OtaPlatformScan } from "@/lib/competitor-radar/ota-types";

export type CalendarRoom = { id: string; name: string };
export type CalendarRoomValue = CalendarRoom & { remaining: number | null; amount?: number; displayedAmount?: number; state: string };
export type CalendarDay = {
  date: string;
  total: number | null;
  remaining: number | null;
  depleted: number | null;
  rate: number | null;
  verified: boolean;
  state: string;
  rooms: CalendarRoomValue[];
  observedRemaining: number | null;
  unknownRooms: number;
  observedAt?: string;
  priceReview?: boolean;
  /** True only when caller gated capacityStatus==="confirmed" and inventory was applied. */
  capacityConfirmed: boolean;
};

export function offsetDate(value: string, amount: number) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function weekStart(value: string) {
  return offsetDate(value, -((new Date(`${value}T00:00:00Z`).getUTCDay() + 6) % 7));
}

export function shiftMonth(value: string, amount: number) {
  const date = new Date(`${value.slice(0, 7)}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + amount);
  return date.toISOString().slice(0, 10);
}

export function periodDates(anchor: string, mode: "month" | "week") {
  const first = mode === "week" ? weekStart(anchor) : `${anchor.slice(0, 7)}-01`;
  const count = mode === "week" ? 7 : new Date(`${shiftMonth(anchor, 1)}T00:00:00Z`).getTime() - new Date(`${first}T00:00:00Z`).getTime();
  return Array.from({ length: mode === "week" ? 7 : count / 86400000 }, (_, i) => offsetDate(first, i));
}

/** Treat only explicit "confirmed" as usable for rates/heat; unconfirmed/pending/draft/missing → false. */
export function isCapacityConfirmed(capacityStatus?: string | null): boolean {
  return capacityStatus === "confirmed";
}

/**
 * Build one calendar day.
 * Rate/heat inputs require capacityConfirmed===true AND a complete positive integer roomInventory
 * for every catalog room. Unconfirmed/pending/draft never uses inventory for totals even if present by mistake.
 * assumeUnlisted must stay false on github imports (unknown/unlisted ≠ 0).
 */
export function calendarDay(
  date: string,
  scan: OtaPlatformScan | undefined,
  rooms: CalendarRoom[],
  inventory: Record<string, number> | undefined,
  assumeUnlisted: boolean,
  capacityConfirmed = false,
): CalendarDay {
  // Gate: never apply inventory for rates unless capacity is confirmed.
  const gatedInventory = capacityConfirmed ? inventory : undefined;
  const capacityValid =
    !!gatedInventory &&
    rooms.length > 0 &&
    rooms.every(room => Number.isInteger(gatedInventory[room.id]) && gatedInventory[room.id]! > 0);
  const total = capacityValid ? rooms.reduce((n, room) => n + gatedInventory![room.id]!, 0) : null;
  const day = scan?.observations.find(item => item.stayDate === date);
  const verified =
    !!day &&
    day.identityVerified &&
    day.dateVerified &&
    (day.state === "ready" || day.state === "partial") &&
    scan?.collectionState !== "withdrawn";
  const observationState = !day
    ? "未抓取"
    : day.state === "blocked"
      ? "抓取受限"
      : day.state === "failed"
        ? "抓取失敗"
        : !verified
          ? "待核對"
          : "房量待確認";
  const values = rooms.map(room => {
    if (!verified) return { ...room, remaining: null, state: observationState };
    const offers = day!.rooms.filter(item => item.canonicalRoomId === room.id);
    if (!offers.length) {
      const unlisted = assumeUnlisted && day!.roomIssues?.[room.id] === "未列出";
      return { ...room, remaining: unlisted ? 0 : null, state: unlisted ? "未列出・依規則計 0" : "房況待確認" };
    }
    if (offers.every(offer => offer.availability === "sold_out")) return { ...room, remaining: 0, state: "平台明示無房" };
    const available = offers.filter(offer => offer.availability === "available");
    const counts = [...new Set(available.map(offer => offer.quantity))];
    const exact =
      available.length > 0 &&
      available.length === offers.length &&
      available.every(offer => offer.quantityState === "exact" && Number.isInteger(offer.quantity) && offer.quantity! >= 0);
    const quantity = exact && counts.length === 1 ? counts[0]! : null;
    const prices = available
      .filter(offer => offer.currency === "TWD" && Number.isFinite(offer.amount) && offer.amount! > 0)
      .map(offer => offer.amount!);
    const displayed = available
      .filter(
        offer =>
          offer.currency === "TWD" &&
          offer.displayedPriceBasis === "tax_excluded" &&
          Number.isFinite(offer.displayedAmount) &&
          offer.displayedAmount! > 0,
      )
      .map(offer => offer.displayedAmount!);
    const roomCap = capacityValid ? gatedInventory![room.id]! : undefined;
    const overCapacity = quantity !== null && roomCap !== undefined && quantity > roomCap;
    return {
      ...room,
      remaining: overCapacity ? null : quantity,
      amount: prices.length ? Math.min(...prices) : undefined,
      displayedAmount: displayed.length ? Math.min(...displayed) : undefined,
      state: overCapacity ? "超出容量・待核對" : quantity === null ? "數量未確認" : "可售",
    };
  });
  const remaining =
    verified && values.length > 0 && values.every(value => value.remaining !== null)
      ? values.reduce((n, value) => n + value.remaining!, 0)
      : null;
  const depleted = total !== null && remaining !== null ? total - remaining : null;
  const known = values.filter(value => value.remaining !== null);
  const unknownRooms = values.length - known.length;
  const rate = depleted !== null && total !== null ? (depleted / total) * 100 : null;

  let state: string;
  if (!day) {
    state = "未抓取";
  } else if (depleted !== null) {
    state = "已核對";
  } else if (verified && total === null) {
    state = "容量待確認";
  } else if (verified && unknownRooms > 0) {
    state = `${unknownRooms} 房型未知`;
  } else {
    state = observationState;
  }

  return {
    date,
    total,
    remaining,
    depleted,
    rate,
    verified,
    state,
    rooms: values,
    observedRemaining: verified && known.length ? known.reduce((n, value) => n + value.remaining!, 0) : null,
    unknownRooms,
    observedAt: day?.observedAt,
    priceReview: day?.priceReview,
    capacityConfirmed: capacityValid,
  };
}

export function summarizeCalendar(days: CalendarDay[]) {
  const complete = days.filter(day => day.depleted !== null && day.total !== null && day.remaining !== null);
  const capacityNights = complete.reduce((n, day) => n + day.total!, 0);
  const remainingNights = complete.reduce((n, day) => n + day.remaining!, 0);
  const depletedNights = capacityNights - remainingNights;
  const observed = days.filter(day => day.observedRemaining !== null);
  return {
    completeDays: complete.length,
    requestedDays: days.length,
    capacityNights,
    remainingNights,
    depletedNights,
    rate: capacityNights ? (depletedNights / capacityNights) * 100 : null,
    observedDays: observed.length,
    observedRemainingNights: observed.reduce((n, day) => n + day.observedRemaining!, 0),
  };
}
