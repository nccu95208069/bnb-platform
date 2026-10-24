"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import type { CalendarProperty, CalendarResponse } from './calendar-types';
import { combinedCalendarWindows, hasCalendarCoverage, retainedCalendar, validCalendarResponse } from './calendar-retention';

type Input = {
  start: string; end: string; scope: string; reload: number;
  visibleStart?: string; visibleEnd?: string;
  prefetch?: { start: string; end: string }[];
  read: (start: string, end: string) => Promise<CalendarResponse>;
  onProperties: (properties: CalendarProperty[]) => void;
  onAccessLost: () => void;
};
type WindowState = { scope: string; reload: number;
  windows: Map<string, { data: CalendarResponse; at: number }>;
  pending: Map<string, Promise<CalendarResponse>> };

function readWindow(state: WindowState, from: string, to: string,
  read: Input['read']): Promise<CalendarResponse> {
  const key = `${from}:${to}`;
  const existing = state.pending.get(key);
  if (existing) return existing;
  const request = read(from, to);
  state.pending.set(key, request);
  void request.then(() => { if (state.pending.get(key) === request) state.pending.delete(key); },
    () => { if (state.pending.get(key) === request) state.pending.delete(key); });
  return request;
}

// Private data is retained only in this mounted view and only for the exact access scope.
export function useCalendarData({ start, end, visibleStart = start, visibleEnd = end, scope, reload, prefetch = [], read, onProperties, onAccessLost }: Input) {
  const [loaded, setLoaded] = useState<{ scope: string; data: CalendarResponse } | null>(null);
  const cache = useRef<WindowState>({
    scope, reload, windows: new Map(), pending: new Map(),
  });
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const requestKey = JSON.stringify([scope, start, end, reload]);
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const data = useMemo(() => retainedCalendar(loaded?.scope === scope ? loaded.data : null, failed), [loaded, scope, failed]);
  // Effects start after the first render for a new date range. Derive pending
  // from the requested range so an uncovered range never flashes as a failure.
  const pending = settledKey !== requestKey;
  const covered = hasCalendarCoverage(data, visibleStart, visibleEnd);
  const loading = pending && !covered;
  const refreshing = pending && covered;
  const mainCovered = hasCalendarCoverage(data, start, end);
  const prefetchKey = JSON.stringify(prefetch.map(({ start: from, end: to }) => [from, to]));

  useEffect(() => {
    cache.current = { scope, reload: -1, windows: new Map(), pending: new Map() };
    setLoaded(null); setLastLoadedAt(null); setFailed(false); setError(null);
    setSettledKey(null);
  }, [scope]);

  useEffect(() => {
    let active = true;
    setSettledKey(null);
    void (async () => {
      try {
        const state = cache.current;
        const force = state.reload !== reload;
        if (force) state.pending.clear();
        state.reload = reload;
        const key = `${start}:${end}`;
        // Iron Gate windows share an inventory version. Keep adjacent years in
        // memory until a scheduled reload observes a new version; a time-only
        // eviction would stall scrolling even when nothing changed.
        const fresh = [...state.windows.values()].filter(item =>
          item.data.source?.private_snapshot_version || Date.now() - item.at < 120_000);
        const cached = combinedCalendarWindows(fresh.map(item => item.data), start, end);
        if (!force && cached && hasCalendarCoverage(cached, start, end)) {
          setLoaded({ scope, data: cached }); setFailed(false); setError(null);
          setSettledKey(requestKey); return;
        }
        const response = await readWindow(state, start, end, read);
        if (!active) return;
        if (!validCalendarResponse(response, start, end)) throw Error('收到的日曆資料不完整，保留上次資料。');
        const priorVersion = state.windows.values().next().value?.data.source?.private_snapshot_version;
        const nextVersion = response.source?.private_snapshot_version;
        if (priorVersion !== nextVersion) state.windows.clear();
        state.windows.delete(key);
        state.windows.set(key, { data: response, at: Date.now() });
        while (state.windows.size > 7) state.windows.delete(state.windows.keys().next().value!);
        const combined = combinedCalendarWindows([...state.windows.values()].map(item => item.data), start, end) ?? response;
        setLoaded({ scope, data: combined }); setFailed(false); setError(null);
        setLastLoadedAt(new Date()); setSettledKey(requestKey); onProperties(response.properties);
      } catch (cause) {
        if (!active) return;
        setFailed(true);
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
          cache.current.windows.clear();
          setLoaded(null); setLastLoadedAt(null); onAccessLost();
        }
        setError(cause instanceof Error ? cause.message : '無法讀取訂單日曆');
        setSettledKey(requestKey);
      }
    })();
    return () => { active = false; };
  }, [start, end, scope, reload, requestKey, read, onProperties, onAccessLost]);

  useEffect(() => {
    if (settledKey !== requestKey || !mainCovered || failed || !data?.source?.private_snapshot_version) return;
    let active = true;
    void (async () => {
      const state = cache.current;
      if (state.scope !== scope || state.reload !== reload) return;
      const ranges = (JSON.parse(prefetchKey) as [string, string][]).filter(([from, to]) => {
        const cached = combinedCalendarWindows([...state.windows.values()].map(item => item.data), from, to);
        return !hasCalendarCoverage(cached, from, to);
      });
      // Both adjacent years start together so either scroll direction is warm.
      const results = await Promise.allSettled(ranges.map(async ([from, to]) => ({
        from, to, response: await readWindow(state, from, to, read),
      })));
      if (!active || state !== cache.current || state.reload !== reload) return;
      for (const result of results) {
        if (result.status === 'rejected') {
          const cause = result.reason;
          if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
            state.windows.clear(); setLoaded(null); setLastLoadedAt(null);
            setFailed(true); setError(cause.message); onAccessLost(); return;
          }
          continue;
        }
        const { from, to, response } = result.value;
        if (!validCalendarResponse(response, from, to) ||
          response.source?.private_snapshot_version !== data.source?.private_snapshot_version) continue;
        const key = `${from}:${to}`;
        state.windows.delete(key);
        state.windows.set(key, { data: response, at: Date.now() });
      }
      while (state.windows.size > 7) state.windows.delete(state.windows.keys().next().value!);
      const combined = combinedCalendarWindows([...state.windows.values()].map(item => item.data), start, end);
      if (combined) setLoaded({ scope, data: combined });
    })();
    return () => { active = false; };
  }, [prefetchKey, settledKey, requestKey, mainCovered, failed, data?.source?.private_snapshot_version, scope, reload, start, end, read, onAccessLost]);
  return { data, loading, refreshing, error: pending ? null : error, requestFailed: failed, lastLoadedAt };
}
