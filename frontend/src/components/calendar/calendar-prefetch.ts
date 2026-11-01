import { addMonths, fetchPeriod, startOfMonth } from './calendar-utils';

export type CalendarRange = { start: string; end: string };

// Render the current month first, then warm the following five months without
// waiting for scrolling. Two-month batches stay below the 93-day API limit,
// including the leading/trailing days of a full month grid.
export function sixMonthPrefetchRanges(anchor: string, grid = false): CalendarRange[] {
  const month = startOfMonth(anchor);
  return [[1, 3], [3, 5], [5, 6]].map(([from, to]) => {
    const start = addMonths(month, from), end = addMonths(month, to);
    return grid ? {
      start: fetchPeriod(start, 'month', true).start,
      end: fetchPeriod(addMonths(end, -1), 'month', true).end,
    } : { start, end };
  });
}

export function containsRange(outer: CalendarRange, inner: CalendarRange) {
  return outer.start <= inner.start && outer.end >= inner.end;
}

export function rangesCover(ranges: CalendarRange[], target: CalendarRange) {
  let covered = target.start;
  for (const range of [...ranges].sort((a, b) => a.start.localeCompare(b.start))) {
    if (range.start > covered) break;
    if (range.end > covered) covered = range.end;
    if (covered >= target.end) return true;
  }
  return false;
}
