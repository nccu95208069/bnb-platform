import { bookingsOverlap, staysOf } from "./domain.ts";
import { holdPhase, occupiesInventory } from "./hold-state.ts";
import type { OrderTag, Property, WorkspaceView } from "./types.ts";
export type OrderQuery = {
  q?: string;
  property?: string;
  room?: string;
  platform?: string;
  dateKind?: string;
  from?: string;
  to?: string;
  missingDate?: string;
  status?: string;
  attention?: string;
  page?: string;
};
export const tagsFor = (property: Property): OrderTag[] =>
  property.tags ?? [
    { id: "receipt", name: "收據", short: "收", color: "blue" },
    { id: "travel", name: "國旅", short: "旅", color: "orange" },
    { id: "pet", name: "寵物", short: "寵", color: "purple" },
    { id: "baby", name: "嬰兒用品", short: "嬰", color: "green" },
    { id: "late", name: "晚到", short: "晚", color: "slate" },
  ];
export const normalizedSearch = (value: string) =>
  value.normalize("NFKC").trim().toLocaleLowerCase("zh-TW");
export function stayCounts(booking: WorkspaceView["bookings"][number]) {
  const nights = new Set<string>(),
    roomNights = new Set<string>();
  for (const stay of staysOf(booking))
    for (
      let at = Date.parse(stay.checkIn);
      at < Date.parse(stay.checkOut);
      at += 86400000
    ) {
      const date = new Date(at).toISOString().slice(0, 10);
      nights.add(date);
      for (const room of stay.roomIds) roomNights.add(`${room}:${date}`);
    }
  return { nights: nights.size, roomNights: roomNights.size };
}
export function orderIssues(
  data: WorkspaceView,
  booking: WorkspaceView["bookings"][number],
) {
  const issues: string[] = [];
  if (!booking.guestName) issues.push("姓名未填");
  if (
    occupiesInventory(booking) &&
    data.bookings.some(
      (b) =>
        b.id !== booking.id &&
        b.propertyId === booking.propertyId &&
        occupiesInventory(b) &&
        bookingsOverlap(booking, b),
    )
  )
    issues.push("房晚重疊");
  if (holdPhase(booking) === "awaiting_owner") issues.push("保留到期，等待延長或釋出");
  if (booking.hold?.latePaymentReview) issues.push("釋出後收到款項，需人工處理");
  return issues;
}
function validDate(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value >= "2000-01-01" &&
    value <= "2100-12-31" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}
export function queryOrders(data: WorkspaceView, query: OrderQuery) {
  if (
    (query.property && !data.properties.some((p) => p.id === query.property)) ||
    (query.room &&
      !data.properties.some(
        (p) =>
          (!query.property || p.id === query.property) &&
          p.rooms.some((r) => r.id === query.room),
      ))
  )
    throw new Error("NOT_FOUND");
  const kind = query.dateKind || "stay";
  if (
    !["stay", "checkIn", "checkOut", "bookedAt"].includes(kind) ||
    (query.from && !validDate(query.from)) ||
    (query.to && !validDate(query.to)) ||
    (query.from && query.to && query.from > query.to) ||
    (query.q?.length ?? 0) > 200
  )
    throw new Error("INVALID_INPUT");
  if (query.status && !["confirmed", "held", "awaiting_owner", "cancelled", "all"].includes(query.status))
    throw new Error("INVALID_INPUT");
  const q = normalizedSearch(query.q || ""),
    from = query.from || "2000-01-01",
    to = query.to || "2100-12-31";
  const matches = data.bookings
    .filter((b) => {
      if (query.property && b.propertyId !== query.property) return false;
      if (query.room && !b.roomIds.includes(query.room)) return false;
      if (query.status === "awaiting_owner" ? holdPhase(b) !== "awaiting_owner" && !b.hold?.latePaymentReview : query.status !== "all" && b.status !== (query.status || "confirmed"))
        return false;
      if (
        query.platform === "__missing"
          ? !!b.platform
          : query.platform &&
            normalizedSearch(b.platform || "") !==
              normalizedSearch(query.platform)
      )
        return false;
      if (
        q &&
        ![
          b.guestName,
          b.id,
          b.notes,
          b.imported?.externalId,
          b.calendar?.externalId,
        ].some((v) => v && normalizedSearch(v).includes(q))
      )
        return false;
      if (query.attention === "true" && !orderIssues(data, b).length)
        return false;
      if (query.missingDate === "true") return !b.bookedAt;
      if (!query.from && !query.to) return true;
      if (kind === "stay")
        return staysOf(b).some(
          (s) =>
            (!query.room || s.roomIds.includes(query.room)) &&
            s.checkIn <= to &&
            s.checkOut > from,
        );
      if (kind === "bookedAt")
        return !!b.bookedAt && b.bookedAt >= from && b.bookedAt <= to;
      return staysOf(b).some(
        (s) =>
          (!query.room || s.roomIds.includes(query.room)) &&
          s[kind as "checkIn" | "checkOut"] >= from &&
          s[kind as "checkIn" | "checkOut"] <= to,
      );
    })
    .sort(
      (a, b) => a.checkIn.localeCompare(b.checkIn) || a.id.localeCompare(b.id),
    );
  const requestedPage = Number(query.page || 1);
  if (!Number.isInteger(requestedPage) || requestedPage < 1)
    throw new Error("INVALID_INPUT");
  const pageSize = 30,
    pages = Math.max(1, Math.ceil(matches.length / pageSize)),
    page = Math.min(pages, requestedPage);
  const reviewRecords = (data.reviewRecords ?? []).filter(
    (r) =>
      (!query.property || r.propertyId === query.property) &&
      (!query.room || !r.roomIds.length || r.roomIds.includes(query.room)) &&
      (!q ||
        [r.guestName, r.label, ...r.issues].some(
          (v) => v && normalizedSearch(v).includes(q),
        )),
  );
  return {
    reviewRecords: reviewRecords.slice(0, 100),
    reviewCount: reviewRecords.length,
    bookings: matches.slice((page - 1) * pageSize, page * pageSize),
    total: matches.length,
    page,
    pages,
    issues: Object.fromEntries(
      matches
        .slice((page - 1) * pageSize, page * pageSize)
        .map((b) => [b.id, orderIssues(data, b)]),
    ),
    verifiedAt: new Date().toISOString(),
  };
}
export type OrderQueryResult = ReturnType<typeof queryOrders>;

export function calendarWindow(
  data: WorkspaceView,
  query: { property?: string; month?: string },
): WorkspaceView {
  const property = data.properties.find((p) => p.id === query.property);
  if (!property) throw new Error("NOT_FOUND");
  if (!query.month || !/^(20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(query.month))
    throw new Error("INVALID_INPUT");
  const first = new Date(`${query.month}-01T00:00:00Z`),
    from = new Date(first.getTime() - first.getUTCDay() * 86400000)
      .toISOString()
      .slice(0, 10),
    to = new Date(Date.parse(from) + 42 * 86400000).toISOString().slice(0, 10);
  const overlaps = (
    b:
      | WorkspaceView["bookings"][number]
      | NonNullable<WorkspaceView["blocks"]>[number],
  ) =>
    b.propertyId === property.id &&
    staysOf(b).some((s) => s.checkIn < to && s.checkOut > from);
  return {
    ...data,
    properties: [property],
    bookings: data.bookings.filter(overlaps),
    blocks: data.blocks?.filter(overlaps),
    reviewRecords: data.reviewRecords?.filter(
      (r) => r.propertyId === property.id,
    ),
    readiness: data.readiness?.[property.id]
      ? { [property.id]: data.readiness[property.id] }
      : undefined,
  };
}
