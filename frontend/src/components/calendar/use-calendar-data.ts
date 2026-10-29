"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CalendarProperty, CalendarResponse } from './calendar-types';
import { hasCalendarCoverage, retainedCalendar } from './calendar-retention';
import { cachedCalendarWindow, calendarWindowKey, createCalendarWindowState, readCalendarWindow } from './calendar-window-cache';

type Input = {
  start: string; end: string; scope: string; reload: number;
  visibleStart?: string; visibleEnd?: string;
  prefetch?: { start: string; end: string }[];
  read: (start: string, end: string) => Promise<CalendarResponse>;
  onProperties: (properties: CalendarProperty[]) => void;
  onAccessLost: () => void;
};
type LoadResult = { scope: string; data: CalendarResponse | null; failed: boolean;
  error: string | null; lastLoadedAt: Date | null; settledKey: string | null };

// Private data is retained only in this mounted view and only for the exact access scope.
export function useCalendarData({ start, end, visibleStart = start, visibleEnd = end, scope, reload, prefetch = [], read, onProperties, onAccessLost }: Input) {
  const [result, setResult] = useState<LoadResult>({ scope, data: null, failed: false,
    error: null, lastLoadedAt: null, settledKey: null });
  // Discard the old result on the scope-changing render itself. Merely hiding
  // it would resurrect that private snapshot if the caller switched back.
  if (result.scope !== scope) setResult({ scope, data: null, failed: false,
    error: null, lastLoadedAt: null, settledKey: null });
  const cache = useRef(createCalendarWindowState(scope, reload));
  const mounted = useRef(false);
  const scopedResult = result.scope === scope ? result : null;
  const failed = scopedResult?.failed ?? false;
  const error = scopedResult?.error ?? null;
  const lastLoadedAt = scopedResult?.lastLoadedAt ?? null;
  const requestKey = JSON.stringify([scope, start, end, reload]);
  const settledKey = scopedResult?.settledKey ?? null;
  const data = useMemo(() => retainedCalendar(scopedResult?.data ?? null, failed), [scopedResult, failed]);
  // Effects start after the first render for a new date range. Derive pending
  // from the requested range so an uncovered range never flashes as a failure.
  const pending = settledKey !== requestKey;
  const covered = hasCalendarCoverage(data, visibleStart, visibleEnd);
  const loading = pending && !covered;
  const refreshing = pending && covered;
  const mainCovered = hasCalendarCoverage(data, start, end);
  const hasSource = !!data?.source;
  const sourceVersion = data?.source?.private_snapshot_version;
  const prefetchKey = JSON.stringify(prefetch.map(({ start: from, end: to }) => [from, to]));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cache.current.windows.clear(); cache.current.pending.clear();
    };
  }, []);

  useEffect(() => {
    cache.current = createCalendarWindowState(scope, -1);
  }, [scope]);

  useEffect(() => {
    let active = true;
    const force = cache.current.reload !== reload;
    if (force) cache.current = createCalendarWindowState(scope, reload);
    const state = cache.current;
    state.foregroundKey = calendarWindowKey(start, end);
    state.requestKey = requestKey;
    const current = () => mounted.current && cache.current === state;
    const accessLost = (cause: Error) => {
      setResult({ scope, data: null, lastLoadedAt: null, failed: true,
        error: cause.message, settledKey: state.requestKey });
      onAccessLost();
    };
    void Promise.resolve().then(async () => {
      if (!active || !current()) return;
      try {
        const cached = cachedCalendarWindow(state, start, end);
        if (!force && cached && hasCalendarCoverage(cached, start, end)) {
          setResult(previous => ({ scope, data: cached, failed: false, error: null,
            lastLoadedAt: previous.scope === scope ? previous.lastLoadedAt : null, settledKey: requestKey }));
          return;
        }
        const response = await readCalendarWindow(state, start, end, read, current, accessLost);
        if (!active || !current() || state.revoked || !response) return;
        const combined = cachedCalendarWindow(state, start, end) ?? response;
        setResult({ scope, data: combined, failed: false, error: null,
          lastLoadedAt: new Date(), settledKey: requestKey });
        onProperties(response.properties);
      } catch (cause) {
        if (!active || !current() || state.revoked) return;
        setResult(previous => ({ scope, data: previous.scope === scope ? previous.data : null,
          lastLoadedAt: previous.scope === scope ? previous.lastLoadedAt : null,
          failed: true, error: cause instanceof Error ? cause.message : '無法讀取訂單日曆', settledKey: requestKey }));
      }
    });
    return () => { active = false; };
  }, [start, end, scope, reload, requestKey, read, onProperties, onAccessLost]);

  useEffect(() => {
    if (settledKey !== requestKey || !mainCovered || failed || !hasSource) return;
    let active = true;
    const state = cache.current;
    if (state.scope !== scope || state.reload !== reload || state.revoked) return;
    const current = () => mounted.current && cache.current === state;
    const accessLost = (cause: Error) => {
      setResult({ scope, data: null, lastLoadedAt: null, failed: true,
        error: cause.message, settledKey: state.requestKey });
      onAccessLost();
    };
    for (const [from, to] of JSON.parse(prefetchKey) as [string, string][]) {
      if (hasCalendarCoverage(cachedCalendarWindow(state, from, to), from, to)) continue;
      void readCalendarWindow(state, from, to, read, current, accessLost).then(response => {
        // The shared request has already committed its cache entry, even if the
        // viewport moved. Only the current effect may update the visible data.
        if (!active || !current() || state.revoked || !response) return;
        const combined = cachedCalendarWindow(state, start, end);
        if (combined) setResult(previous => previous.scope === scope ? { ...previous, data: combined } : previous);
      }).catch(() => { /* A neighbor failure does not hide the verified current month. */ });
    }
    return () => { active = false; };
  }, [prefetchKey, settledKey, requestKey, mainCovered, failed, hasSource, sourceVersion, scope, reload, start, end, read, onAccessLost]);
  return { data, loading, refreshing, error: pending ? null : error, requestFailed: failed, lastLoadedAt };
}
