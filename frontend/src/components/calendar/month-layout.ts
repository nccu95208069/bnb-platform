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

export const MAX_MONTH_WEEK_DENSITY = 6;
export const DEFAULT_MONTH_WEEK_DENSITY = 3;

// Left is spacious, right is compact. The first stop occupies at least 62%
// of the scroll viewport, so only about one or two weeks fit at a time.
const WEEK_HEIGHT_FRACTIONS = [0.62, 0.53, 0.44, 0.36, 0.29, 0.22, 0.16] as const;

export function normalizeMonthWeekDensity(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(MAX_MONTH_WEEK_DENSITY, Math.max(0, value))
    : DEFAULT_MONTH_WEEK_DENSITY;
}

export function restoredMonthWeekDensity(saved: {
  monthWeekAuto?: unknown;
  monthWeekDensity?: unknown;
  monthWeekSpacing?: unknown;
} | undefined): { automatic: boolean; density: number } {
  // Before the separate Auto control, zero meant automatic and six meant all.
  const legacySpacing = typeof saved?.monthWeekSpacing === "number" && Number.isInteger(saved.monthWeekSpacing)
    ? Math.min(6, Math.max(0, saved.monthWeekSpacing))
    : 0;
  return {
    automatic: typeof saved?.monthWeekAuto === "boolean" ? saved.monthWeekAuto : legacySpacing === 0,
    density: saved?.monthWeekDensity === undefined
      ? legacySpacing > 0 ? 6 - legacySpacing : DEFAULT_MONTH_WEEK_DENSITY
      : normalizeMonthWeekDensity(saved.monthWeekDensity),
  };
}

export function manualMonthWeekMinHeight(viewportHeight: number, density: number): number {
  return Math.ceil(viewportHeight * WEEK_HEIGHT_FRACTIONS[normalizeMonthWeekDensity(density)]);
}

export function unsoldMonthRoomLimits(automatic: boolean, density: number): { mobile: number; desktop: number } {
  if (automatic) return { mobile: 2, desktop: 3 };
  const level = normalizeMonthWeekDensity(density);
  const mobile = [Infinity, 8, 6, 4, 3, 2, 1];
  const desktop = [Infinity, 9, 7, 5, 4, 3, 2];
  return { mobile: mobile[level], desktop: desktop[level] };
}

// The date, booking, and overflow rows scale with the root font preference,
// so lane capacity must use the same multiplier as their explicit pixel sizes.
export function fitMonthWeekLanes(weekHeight: number, laneCount: number, fontScale = 1, twoLine = false): number {
  const laneHeight = (twoLine ? 34 : 20) * fontScale;
  const withoutOverflow = Math.max(0, Math.floor((weekHeight - 24 * fontScale) / laneHeight));
  if (laneCount <= withoutOverflow) return laneCount;
  return Math.max(1, Math.floor((weekHeight - 40 * fontScale) / laneHeight));
}

export function monthWeekHeightForDensity({
  baseWeekHeight,
  viewportHeight,
  laneCount,
  fontScale,
  twoLine,
  automatic,
  density,
}: {
  baseWeekHeight: number;
  viewportHeight: number;
  laneCount: number;
  fontScale: number;
  twoLine: boolean;
  automatic: boolean;
  density: number;
}): number {
  const minimum = twoLine ? laneCount > 2 ? 110 : laneCount === 2 ? 94 : 60 : 60;
  const automaticHeight = Math.max(baseWeekHeight, minimum * fontScale);
  if (automatic) return automaticHeight;
  const rowHeight = twoLine ? 34 : 20;
  const level = normalizeMonthWeekDensity(density);
  const minimumVisibleHeight = Math.ceil((laneCount > 1 ? 40 + rowHeight : 24 + rowHeight) * fontScale) + 1;
  const allLanesHeight = Math.ceil((24 + laneCount * rowHeight) * fontScale) + 1;
  return Math.max(
    60 * fontScale,
    manualMonthWeekMinHeight(viewportHeight, level),
    laneCount > 0 ? minimumVisibleHeight : 0,
    level === 0 ? allLanesHeight : 0,
  );
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
