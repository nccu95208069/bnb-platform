"use client";
import { useState } from 'react';
import { addMonths, startOfMonth } from './calendar-utils';

// Keep a completed six-month window stable while browsing inside it. Moving
// the horizon every month would fetch unused months and evict the opening one
// from the bounded device cache before the user next opens the calendar.
export function useCalendarPreloadAnchor(visibleDate: string, scope: string) {
  const month = startOfMonth(visibleDate);
  const [window, setWindow] = useState({ scope, anchor: month });
  const anchor = window.scope === scope && month >= window.anchor && month < addMonths(window.anchor, 6)
    ? window.anchor : month;
  // Scope/reload and out-of-window jumps start with the newly visible month.
  // Adjust before effects so no request is launched for the previous horizon.
  if (window.scope !== scope || window.anchor !== anchor) setWindow({ scope, anchor });
  return anchor;
}
