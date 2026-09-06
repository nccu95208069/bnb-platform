import type { CalendarBooking } from "./calendar-types";

export type MonthStaySegment = {
  booking: CalendarBooking;
  start: number;
  end: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
};

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
