"use client";
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import type { CalendarProperty, CalendarResponse } from './calendar-types';
import { hasCalendarCoverage, retainedCalendar, validCalendarResponse } from './calendar-retention';

type Input = {
  start: string; end: string; scope: string; reload: number;
  read: (start: string, end: string) => Promise<CalendarResponse>;
  onProperties: (properties: CalendarProperty[]) => void;
  onAccessLost: () => void;
};

// Private data is retained only in this mounted view and only for the exact access scope.
export function useCalendarData({ start, end, scope, reload, read, onProperties, onAccessLost }: Input) {
  const [loaded, setLoaded] = useState<{ scope: string; data: CalendarResponse } | null>(null);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const requestKey = JSON.stringify([scope, start, end, reload]);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const data = useMemo(() => retainedCalendar(loaded?.scope === scope ? loaded.data : null, failed), [loaded, scope, failed]);
  // Effects start after the first render for a new date range. Derive pending
  // from the requested range so an uncovered range never flashes as a failure.
  const pending = settledKey !== requestKey;
  const covered = hasCalendarCoverage(data, start, end);
  const loading = pending && !covered;
  const refreshing = pending && covered;

  useEffect(() => {
    setLoaded(null); setLastLoadedAt(null); setFailed(false); setError(null);
    setSettledKey(null);
  }, [scope]);

  useEffect(() => {
    let active = true;
    setSettledKey(null);
    void (async () => {
      try {
        const response = await read(start, end);
        if (!active) return;
        if (!validCalendarResponse(response, start, end)) throw Error('收到的日曆資料不完整，保留上次資料。');
        setLoaded({ scope, data: response }); setFailed(false); setError(null);
        setLastLoadedAt(new Date()); setSettledKey(requestKey); onProperties(response.properties);
      } catch (cause) {
        if (!active) return;
        setFailed(true);
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
          setLoaded(null); setLastLoadedAt(null); onAccessLost();
        }
        setError(cause instanceof Error ? cause.message : '無法讀取訂單日曆');
        setSettledKey(requestKey);
      }
    })();
    return () => { active = false; };
  }, [start, end, scope, reload, requestKey, read, onProperties, onAccessLost]);
  return { data, loading, refreshing, error: pending ? null : error, requestFailed: failed, lastLoadedAt };
}
