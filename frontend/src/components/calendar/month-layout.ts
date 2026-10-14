import type { CalendarBooking } from "./calendar-types";

export type MonthStaySegment = {
  booking: CalendarBooking;
  start: number;
  end: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
};

export function monthBookingFontSize(fontScale: number, desktop = false): number {
  return (desktop ? 11 : 10) * fontScale;
}

export function monthBookingTwoLine(fontScale: number, desktop = false): boolean {
  return !desktop && fontScale >= 1.15;
}

export const MAX_MONTH_WEEK_SPACING = 6;

export function normalizeMonthWeekSpacing(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(MAX_MONTH_WEEK_SPACING, Math.max(0, value))
    : 0;
}

export function unsoldMonthRoomLimits(spacing: number): { mobile: number; desktop: number } {
  const level = normalizeMonthWeekSpacing(spacing);
  return level === MAX_MONTH_WEEK_SPACING
    ? { mobile: Number.POSITIVE_INFINITY, desktop: Number.POSITIVE_INFINITY }
    : { mobile: 2 + level, desktop: 3 + level };
}

// The date, booking, and overflow rows scale with the root font preference,
// so lane capacity must use the same multiplier as their explicit pixel sizes.
export function fitMonthWeekLanes(weekHeight: number, laneCount: number, fontScale = 1, twoLine = false): number {
  const laneHeight = (twoLine ? 34 : 20) * fontScale;
  const withoutOverflow = Math.max(0, Math.floor((weekHeight - 24 * fontScale) / laneHeight));
  if (laneCount <= withoutOverflow) return laneCount;
  return Math.max(1, Math.floor((weekHeight - 40 * fontScale) / laneHeight));
}

// Each step makes room for one more booking lane. The last step fits every
// lane, so the overflow control disappears even on unusually busy weeks.
export function monthWeekHeightForSpacing(
  baseWeekHeight: number,
  laneCount: number,
  fontScale: number,
  twoLine: boolean,
  spacing: number,
): number {
  const minimum = twoLine ? laneCount > 2 ? 110 : laneCount === 2 ? 94 : 60 : 60;
  const automaticHeight = Math.max(baseWeekHeight, minimum * fontScale);
  const level = normalizeMonthWeekSpacing(spacing);
  if (level === 0 || laneCount === 0) return automaticHeight;
  const automaticLanes = fitMonthWeekLanes(automaticHeight, laneCount, fontScale, twoLine);
  const wantedLanes = level === MAX_MONTH_WEEK_SPACING
    ? laneCount
    : Math.min(laneCount, automaticLanes + level);
  const rowHeight = twoLine ? 34 : 20;
  const neededHeight = Math.ceil((wantedLanes < laneCount ? 40 : 24) * fontScale + wantedLanes * rowHeight * fontScale) + 1;
  return Math.max(automaticHeight, neededHeight);
}

// Allocate the entire visible stay at once, so it cannot jump vertically or
// disappear halfway through a week when other rooms arrive or depart.
export function layoutMonthWeek(bookings: CalendarBooking[], days: string[], weekEnd: string): MonthStaySegment[] {
  const occupied: boolean[][] = [];
  return bookings.filter(b => b.check_in < weekEnd && b.check_out > days[0])
    .sort((a, b) => a.property_name.localeCompare(b.property_name)
      || a.room_number.localeCompare(b.room_number)
      || a.check_in.localeCompare(b.check_in) || a.id.localeCompare(b.id))
    .map(booking => {
      const start = Math.max(0, days.findIndex(d => d >= booking.check_in));
      const endIndex = days.findIndex(d => d >= booking.check_out);
      const end = endIndex < 0 ? days.length : endIndex;
      let lane = occupied.findIndex(slots => !slots.slice(start, end).some(Boolean));
      if (lane < 0) { lane = occupied.length; occupied.push(Array(days.length).fill(false)); }
      for (let day = start; day < end; day++) occupied[lane][day] = true;
      return { booking, start, end, lane, continuesBefore: booking.check_in < days[0], continuesAfter: booking.check_out > weekEnd };
    });
}
