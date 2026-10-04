import type { Booking, Property, StaySegment, Workspace } from "./types.ts";

export function staysOf(
  booking: Pick<Booking, "checkIn" | "checkOut" | "roomIds" | "stays">,
): StaySegment[] {
  return booking.stays?.length
    ? booking.stays
    : [
        {
          checkIn: booking.checkIn,
          checkOut: booking.checkOut,
          roomIds: booking.roomIds,
        },
      ];
}

export function staysOverlap(a: StaySegment, b: StaySegment) {
  return (
    a.checkIn < b.checkOut &&
    b.checkIn < a.checkOut &&
    a.roomIds.some((id) => b.roomIds.includes(id))
  );
}

export function bookingsOverlap(
  a: Pick<Booking, "checkIn" | "checkOut" | "roomIds" | "stays">,
  b: Pick<Booking, "checkIn" | "checkOut" | "roomIds" | "stays">,
) {
  return staysOf(a).some((left) =>
    staysOf(b).some((right) => staysOverlap(left, right)),
  );
}

export function propertyReadiness(workspace: Workspace, property: Property) {
  const connected = (workspace.calendarSources ?? []).filter(
    (b) => b.propertyId === property.id && b.mode === "connected",
  );
  const stale = connected.some(
    (b) =>
      Boolean(b.error) ||
      !Number.isFinite(Date.parse(b.lastSuccessfulAt)) ||
      Date.now() - Date.parse(b.lastSuccessfulAt) > 10 * 60000,
  );
  const progress =
    property.setup ??
    (workspace.properties[0]?.id === property.id
      ? workspace.onboarding
      : undefined);
  return {
    complete:
      !stale &&
      (!progress ||
        (Boolean(progress.readyAt) && progress.unresolvedCount === 0)),
    unresolvedCount: progress?.unresolvedCount ?? 0,
    sourceUpdatedAt:
      connected.map((b) => b.lastSuccessfulAt).sort()[0] || progress?.readyAt,
    ...(property.setup?.coverageFrom
      ? { coverageFrom: property.setup.coverageFrom }
      : {}),
    ...(property.setup?.coverageTo
      ? { coverageTo: property.setup.coverageTo }
      : {}),
    ...(connected.length ? { connected: true, stale } : {}),
  };
}

export const cents = (value: number) => Math.round(value * 100);
export const businessDate = (value: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
export function financeSummary(
  booking: Pick<
    Booking,
    | "total"
    | "payments"
    | "entry"
    | "openingReceived"
    | "importedFinance"
    | "expectedDeposit"
  >,
) {
  const opening =
    booking.openingReceived?.amount ??
    (booking.entry === "sheet" || booking.entry === "calendar"
      ? (booking.importedFinance?.propertyReceived ?? null)
      : 0);
  const receipts = booking.payments
    .filter((p) => p.kind !== "refund" && p.allocation !== "extra")
    .reduce((sum, p) => sum + cents(p.amount), 0);
  const refunds = booking.payments
    .filter((p) => p.kind === "refund" && p.allocation !== "extra")
    .reduce((sum, p) => sum + cents(p.amount), 0);
  const deposit = booking.payments
    .filter((p) => p.kind === "deposit")
    .reduce((sum, p) => sum + cents(p.amount), 0);
  const received =
    opening === null ? null : cents(opening) + receipts - refunds;
  const remaining =
    received === null || booking.total === null
      ? null
      : cents(booking.total) - received;
  return {
    extraReceived:
      booking.payments
        .filter((p) => p.allocation === "extra")
        .reduce(
          (sum, p) => sum + (p.kind === "refund" ? -1 : 1) * cents(p.amount),
          0,
        ) / 100,
    openingReceived: opening,
    recordedReceived: receipts / 100,
    refunds: refunds / 100,
    depositReceived: deposit / 100,
    received: received === null ? null : received / 100,
    remaining: remaining === null ? null : Math.max(0, remaining) / 100,
    credit: remaining === null ? null : Math.max(0, -remaining) / 100,
    status:
      received === null || booking.total === null
        ? "unknown"
        : remaining! < 0
          ? "overpaid"
          : remaining === 0
            ? "paid"
            : received === 0
              ? "unpaid"
              : "partial",
  } as const;
}
