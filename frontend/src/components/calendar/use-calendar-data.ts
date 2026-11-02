"use client";
import { useEffect, useMemo, useRef, useState } from 'react';
import { CALENDAR_DEVICE_CACHE_EVENT, loadCalendarDeviceWindows, saveCalendarDeviceWindow,
  type CalendarDeviceScope, type CalendarDeviceWindow } from '@/lib/calendar-device-cache';
import type { CalendarProperty, CalendarResponse } from './calendar-types';
import { combinedCalendarWindows, hasCalendarCoverage, retainedCalendar, validCalendarResponse } from './calendar-retention';
import { cachedCalendarWindow, calendarWindowKey, calendarWindowScheduled, createCalendarWindowState, readCalendarWindow } from './calendar-window-cache';

type Input = {
  start: string; end: string; scope: string; reload: number;
  visibleStart?: string; visibleEnd?: string;
  prefetch?: { start: string; end: string }[];
  read: (start: string, end: string, base?: CalendarResponse) => Promise<CalendarResponse>;
  deviceScope?: CalendarDeviceScope | null;
  onProperties: (properties: CalendarProperty[]) => void;
  onAccessLost: () => void;
};
type LoadResult = { scope: string; data: CalendarResponse | null; failed: boolean;
  error: string | null; lastLoadedAt: Date | null; settledKey: string | null };

// Private data is retained only in this mounted view and only for the exact access scope.
export function useCalendarData({ start, end, visibleStart = start, visibleEnd = end, scope, reload, prefetch = [], read, onProperties, onAccessLost, deviceScope = null }: Input) {
  const [result, setResult] = useState<LoadResult>({ scope, data: null, failed: false,
    error: null, lastLoadedAt: null, settledKey: null });
  // Discard the old result on the scope-changing render itself. Merely hiding
  // it would resurrect that private snapshot if the caller switched back.
  if (result.scope !== scope) setResult({ scope, data: null, failed: false,
    error: null, lastLoadedAt: null, settledKey: null });
  const cache = useRef(createCalendarWindowState(scope, reload));
  const [saved, setSaved] = useState<{ key: string; windows: CalendarDeviceWindow<CalendarResponse>[] }>({ key: '', windows: [] });
  const savedRef = useRef(saved);
  const deviceLoad = useRef<{ key: string; promise: Promise<CalendarDeviceWindow<CalendarResponse>[]> }>({ key: '', promise: Promise.resolve([]) });
  savedRef.current = saved;
  const deviceKey = deviceScope ? JSON.stringify([deviceScope.key, deviceScope.generation]) : '';
  const savedWindows = deviceKey && saved.key === deviceKey ? saved.windows : [];
  const mounted = useRef(false);
  const scopedResult = result.scope === scope ? result : null;
  const failed = scopedResult?.failed ?? false;
  const error = scopedResult?.error ?? null;
  const requestKey = JSON.stringify([scope, start, end, reload]);
  const settledKey = scopedResult?.settledKey ?? null;
  const liveData = useMemo(() => retainedCalendar(scopedResult?.data ?? null, failed), [scopedResult, failed]);
  const deviceData = combinedCalendarWindows(savedWindows.map(item => item.data), visibleStart, visibleEnd);
  const fromDeviceCache = !hasCalendarCoverage(liveData, visibleStart, visibleEnd) && !!deviceData;
  const data = fromDeviceCache ? retainedCalendar(deviceData, true) : liveData;
  const deviceSavedAt = fromDeviceCache ? Math.min(...savedWindows.filter(item =>
    item.start < visibleEnd && item.end > visibleStart).map(item => item.savedAt)) : null;
  const lastLoadedAt = deviceSavedAt ? new Date(deviceSavedAt) : scopedResult?.lastLoadedAt ?? null;
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
    let active = true;
    if (deviceScope) {
      const promise = loadCalendarDeviceWindows(deviceScope, 'bookings', '', validCalendarResponse);
      deviceLoad.current = { key: deviceKey, promise };
      void promise.then(windows => {
      if (active) setSaved({ key: deviceKey, windows: windows.sort((a, b) => a.savedAt - b.savedAt) });
      });
    }
    return () => { active = false; };
  }, [deviceKey, deviceScope]);

  useEffect(() => {
    const clear = () => {
      savedRef.current = { key: '', windows: [] }; setSaved(savedRef.current);
      cache.current.revoked = true; cache.current.windows.clear(); cache.current.pending.clear();
      setResult({ scope, data: null, failed: true, error: '請重新確認登入狀態。', lastLoadedAt: null, settledKey: null });
    };
    window.addEventListener(CALENDAR_DEVICE_CACHE_EVENT, clear);
    return () => window.removeEventListener(CALENDAR_DEVICE_CACHE_EVENT, clear);
  }, [scope, onAccessLost]);

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
        const readWithBase = async (from: string, to: string) => {
          const windows = deviceKey && deviceLoad.current.key === deviceKey ? await Promise.race([
            deviceLoad.current.promise, new Promise<CalendarDeviceWindow<CalendarResponse>[]>(resolve => setTimeout(() => resolve([]), 120)),
          ]) : [];
          const base = windows.find(item => item.start === from && item.end === to)?.data;
          const response = await read(from, to, base);
          if (current() && !state.revoked && validCalendarResponse(response, from, to))
            void saveCalendarDeviceWindow(deviceScope, 'bookings', '', { start: from, end: to, data: response }, validCalendarResponse);
          return response;
        };
        const response = await readCalendarWindow(state, start, end, readWithBase, current, accessLost);
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
  }, [start, end, scope, reload, requestKey, read, onProperties, onAccessLost, deviceKey, deviceScope]);

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
      if (hasCalendarCoverage(cachedCalendarWindow(state, from, to), from, to) || calendarWindowScheduled(state, from, to)) continue;
      const readWithBase = async (first: string, last: string) => {
        const windows = deviceKey && deviceLoad.current.key === deviceKey ? await Promise.race([
          deviceLoad.current.promise, new Promise<CalendarDeviceWindow<CalendarResponse>[]>(resolve => setTimeout(() => resolve([]), 120)),
        ]) : [];
        const base = windows.find(item => item.start === first && item.end === last)?.data;
        const response = await read(first, last, base);
        if (current() && !state.revoked && validCalendarResponse(response, first, last))
          void saveCalendarDeviceWindow(deviceScope, 'bookings', '', { start: first, end: last, data: response }, validCalendarResponse);
        return response;
      };
      void readCalendarWindow(state, from, to, readWithBase, current, accessLost).then(response => {
        // The shared request has already committed its cache entry, even if the
        // viewport moved. Only the current effect may update the visible data.
        if (!active || !current() || state.revoked || !response) return;
        const combined = cachedCalendarWindow(state, start, end);
        if (combined) setResult(previous => previous.scope === scope ? { ...previous, data: combined } : previous);
      }).catch(() => { /* A neighbor failure does not hide the verified current month. */ });
    }
    return () => { active = false; };
  }, [prefetchKey, settledKey, requestKey, mainCovered, failed, hasSource, sourceVersion, scope, reload, start, end, read, onAccessLost, deviceKey, deviceScope]);
  return { data, loading, refreshing, error: pending ? null : error, requestFailed: failed, lastLoadedAt, fromDeviceCache };
}
