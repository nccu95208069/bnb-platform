import type {
  BabySupply,
  CalendarBooking,
} from "@/components/calendar/calendar-types";

const DAY_MS = 86_400_000;

export const BABY_SUPPLY_LABELS: Record<BabySupply, string> = {
  crib: "嬰兒床",
  baby_bath: "嬰兒澡盆",
  sterilizer: "消毒鍋",
  bed_rail: "床圍",
  high_chair: "兒童餐椅",
};

function utcDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

export function nightsBetween(end: string, start: string) {
  return Math.max(0, Math.round((utcDate(end).getTime() - utcDate(start).getTime()) / DAY_MS));
}

export function stayProgress(booking: CalendarBooking, date: string) {
  const totalNights = Math.max(1, nightsBetween(booking.check_out, booking.check_in));
  const nightNumber = Math.min(
    totalNights,
    Math.max(1, nightsBetween(date, booking.check_in) + 1),
  );
  return {
    totalNights,
    nightNumber,
    isArrival: date === booking.check_in,
    isFinalNight: nightNumber === totalNights,
    isContinuation: date > booking.check_in && date < booking.check_out,
  };
}

export function stayProgressLabel(booking: CalendarBooking, date: string) {
  const progress = stayProgress(booking, date);
  if (progress.totalNights === 1) return "1 晚";
  if (progress.isArrival) return `入住 · ${progress.nightNumber}/${progress.totalNights} 晚`;
  if (progress.isFinalNight) return `最後一晚 · ${progress.nightNumber}/${progress.totalNights}`;
  return `續住 · ${progress.nightNumber}/${progress.totalNights} 晚`;
}

export function serviceRequirementLabels(booking: CalendarBooking) {
  const labels: string[] = [];
  if (booking.extra_guest_count > 0) labels.push(`加人 ${booking.extra_guest_count}`);
  if (booking.extra_bed_count > 0) labels.push(`加床 ${booking.extra_bed_count}`);
  if (booking.pet_count > 0) labels.push(`寵物 ${booking.pet_count}`);
  labels.push(...booking.baby_supplies.map((supply) => BABY_SUPPLY_LABELS[supply]));
  return labels;
}

function sameStayGroup(left: CalendarBooking, right: CalendarBooking) {
  return (
    left.order_id === right.order_id &&
    left.property_id === right.property_id &&
    left.room_id === right.room_id &&
    left.platform === right.platform &&
    left.reservation_status === right.reservation_status
  );
}

export function collapseConsecutiveBookings(bookings: CalendarBooking[]) {
  const sorted = bookings
    .slice()
    .sort(
      (a, b) =>
        a.property_id.localeCompare(b.property_id) ||
        a.order_id.localeCompare(b.order_id) ||
        a.room_id.localeCompare(b.room_id) ||
        a.check_in.localeCompare(b.check_in),
    );
  const collapsed: CalendarBooking[] = [];

  for (const booking of sorted) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && sameStayGroup(previous, booking) && previous.check_out === booking.check_in) {
      const sourceIds = new Set([
        ...(previous.source_segment_ids ?? [previous.id]),
        ...(booking.source_segment_ids ?? [booking.id]),
      ]);
      previous.check_out = booking.check_out;
      previous.room_rate += booking.room_rate;
      previous.source_segment_ids = [...sourceIds];
      previous.extra_guest_count = Math.max(
        previous.extra_guest_count,
        booking.extra_guest_count,
      );
      previous.extra_bed_count = Math.max(previous.extra_bed_count, booking.extra_bed_count);
      previous.pet_count = Math.max(previous.pet_count, booking.pet_count);
      previous.baby_supplies = [
        ...new Set([...previous.baby_supplies, ...booking.baby_supplies]),
      ];
      previous.service_note = previous.service_note ?? booking.service_note;
      previous.notes = previous.notes ?? booking.notes;
      continue;
    }
    collapsed.push({
      ...booking,
      source_segment_ids: booking.source_segment_ids ?? [booking.id],
      baby_supplies: [...booking.baby_supplies],
      payments: [...booking.payments],
      audit_log: [...booking.audit_log],
    });
  }

  return collapsed;
}
