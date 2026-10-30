"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api-client';
import { CALENDAR_DEVICE_CACHE_EVENT, loadCalendarDeviceWindows, saveCalendarDeviceWindow,
  type CalendarDeviceScope, type CalendarDeviceWindow } from '@/lib/calendar-device-cache';
import type { AvailabilityQuery, AvailabilityResult } from '@/lib/availability';
import { availabilityVersion, selectAvailabilityWindow, validAvailabilityWindow } from './availability-window-cache';
import { containsRange, rangesCover, sixMonthPrefetchRanges, type CalendarRange } from './calendar-prefetch';
import { useCalendarPreloadAnchor } from './use-calendar-preload-anchor';

type Input = {
  query: AvailabilityQuery; property: string; scope: string; reload: number; preload: boolean;
  read: (query: AvailabilityQuery) => Promise<AvailabilityResult>;
  onProperties: (properties: NonNullable<AvailabilityResult['properties']>) => void;
  onAccessLost: () => void;
  deviceScope?: CalendarDeviceScope | null;
};
type State = {
  scope: string; reload: number; revoked: boolean; epoch: number;
  foreground: CalendarRange; windows: Map<string, AvailabilityResult>;
  pending: Map<string, { range: CalendarRange; promise: Promise<AvailabilityResult | null> }>;
  failures: Map<string, string>;
};
const keyFor = ({ start, end }: CalendarRange) => `${start}:${end}`;
const createState = (scope: string, reload: number, foreground: CalendarRange): State => ({
  scope, reload, foreground, revoked: false, epoch: 0, windows: new Map(), pending: new Map(), failures: new Map(),
});

// One request owner supplies both the summary and every month panel. No month
// panel waits for IntersectionObserver or runs an independent network request.
export function useAvailabilityData({ query, property, scope, reload, preload, read, onProperties, onAccessLost, deviceScope = null }: Input) {
  const cache = useRef(createState(scope, reload, query));
  const mounted = useRef(false);
  const [revision, setRevision] = useState(0);
  const [retryKey, forceRetry] = useState(0);
  const [saved, setSaved] = useState<{ key: string; windows: CalendarDeviceWindow<AvailabilityResult>[] }>({ key: '', windows: [] });
  const currentScope = JSON.stringify([scope, property, query.channel, query.rooms, query.demo_cycle]);
  const prefetchAnchor = useCalendarPreloadAnchor(query.start, JSON.stringify([currentScope, reload, retryKey]));
  const deviceQuery = JSON.stringify([query.channel, query.rooms, query.demo_cycle]);
  const deviceKey = deviceScope ? JSON.stringify([deviceScope.key, deviceScope.generation, deviceQuery]) : '';
  const savedWindows = deviceKey && saved.key === deviceKey ? saved.windows : [];
  const stateMatches = cache.current.scope === currentScope && cache.current.reload === reload;
  const currentWindows = stateMatches && !cache.current.revoked ? [...cache.current.windows.values()] : [];
  const liveData = selectAvailabilityWindow(currentWindows, query);
  const cachedData = selectAvailabilityWindow(savedWindows.map(item => item.data), query);
  const fromDeviceCache = !liveData && !!cachedData;
  const data = liveData ?? cachedData;
  const deviceSavedAt = fromDeviceCache ? Math.min(...savedWindows.filter(item =>
    item.start < query.end && item.end > query.start).map(item => item.savedAt)) : null;
  const error = stateMatches ? [...cache.current.failures].find(([failed]) => {
    const [start, end] = failed.split(':'); return containsRange({ start, end }, query);
  })?.[1] ?? '' : '';
  const prefetchKey = JSON.stringify(preload ? sixMonthPrefetchRanges(prefetchAnchor) : []);

  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false; cache.current.windows.clear(); cache.current.pending.clear();
  }; }, []);

  useEffect(() => {
    let active = true;
    const validate = (value: unknown, start: string, end: string): value is AvailabilityResult =>
      validAvailabilityWindow(value, { ...query, start, end }, property);
    if (deviceScope) void loadCalendarDeviceWindows(deviceScope, 'availability', deviceQuery, validate).then(windows => {
      if (active) setSaved({ key: deviceKey, windows: windows.sort((a, b) => a.savedAt - b.savedAt) });
    });
    return () => { active = false; };
  // Dates do not change the property/room/channel identity of stored windows.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceKey, deviceScope, deviceQuery, property]);

  useEffect(() => {
    const clear = () => {
      setSaved({ key: '', windows: [] });
      cache.current.revoked = true; cache.current.windows.clear(); cache.current.pending.clear();
    };
    window.addEventListener(CALENDAR_DEVICE_CACHE_EVENT, clear);
    return () => window.removeEventListener(CALENDAR_DEVICE_CACHE_EVENT, clear);
  }, [query, onAccessLost]);

  useEffect(() => {
    if (cache.current.scope !== currentScope || cache.current.reload !== reload)
      cache.current = createState(currentScope, reload, query);
    const state = cache.current;
    state.foreground = query;
    if (state.revoked) return;
    const current = () => mounted.current && cache.current === state;
    const notify = () => { if (current()) setRevision(value => value + 1); };
    const load = (range: CalendarRange): Promise<AvailabilityResult | null> => {
      const rangeKey = keyFor(range);
      const cached = selectAvailabilityWindow([...state.windows.values()], range);
      if (cached) return Promise.resolve(cached);
      const pending = [...state.pending.values()].find(item => containsRange(item.range, range));
      if (pending) return pending.promise;
      const epoch = state.epoch;
      const requested = { ...query, ...range };
      const request = Promise.resolve().then(() => read(requested)).then(result => {
        if (!current() || state.revoked || epoch !== state.epoch) return null;
        if (!validAvailabilityWindow(result, requested, property)) throw Error('收到的房況資料不完整，請重新查核。');
        const foreground = containsRange(range, state.foreground);
        const prior = state.windows.values().next().value;
        if (prior && availabilityVersion(prior) !== availabilityVersion(result)) {
          if (!foreground) return null;
          state.windows.clear(); state.pending.clear(); state.epoch++;
        }
        state.windows.delete(rangeKey); state.windows.set(rangeKey, result);
        const validate = (value: unknown, start: string, end: string): value is AvailabilityResult =>
          validAvailabilityWindow(value, { ...query, start, end }, property);
        void saveCalendarDeviceWindow(deviceScope, 'availability', deviceQuery,
          { ...range, data: result }, validate);
        state.failures.delete(rangeKey);
        while (state.windows.size > 7) state.windows.delete(state.windows.keys().next().value!);
        if (result.properties) onProperties(result.properties);
        notify();
        return result;
      }).catch(cause => {
        if (!current() || state.revoked || epoch !== state.epoch) return null;
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
          state.revoked = true; state.windows.clear(); state.pending.clear();
          onAccessLost();
        }
        state.failures.set(rangeKey, cause instanceof Error ? cause.message : '無法讀取房況');
        notify();
        return null;
      }).finally(() => {
        if (state.pending.get(rangeKey)?.promise === request) state.pending.delete(rangeKey);
      });
      state.pending.set(rangeKey, { range, promise: request });
      return request;
    };
    // Keep current month ahead of optional batches, then start all three bands
    // as soon as its result is verified, without waiting for any scroll event.
    void load(query).then(result => {
      if (!current() || state.revoked || !result) return;
      for (const range of JSON.parse(prefetchKey) as CalendarRange[]) {
        if (rangesCover([
          ...[...state.windows.values()].map(value => value.query),
          ...[...state.pending.values()].map(value => value.range),
        ], range) || state.failures.has(keyFor(range))) continue;
        void load(range);
      }
    });
  // Completion rerenders consumers; range and generation changes own fetching.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScope, reload, retryKey, query.start, query.end, prefetchKey, read, onProperties, onAccessLost, deviceKey, deviceScope]);

  const retry = useCallback(() => {
    cache.current.failures.clear();
    // A new generation also prevents old pending results from restoring data.
    cache.current = createState('', -1, query);
    forceRetry(value => value + 1);
  }, [query]);
  const month = (start: string, end: string) => {
    const fresh = selectAvailabilityWindow(currentWindows, { start, end });
    const cached = selectAvailabilityWindow(savedWindows.map(item => item.data), { start, end });
    return {
    data: fresh ?? cached,
    savedAt: !fresh && cached ? Math.min(...savedWindows.filter(item => item.start < end && item.end > start).map(item => item.savedAt)) : null,
    error: stateMatches ? [...cache.current.failures].find(([failed]) => {
      const [from, to] = failed.split(':'); return from <= start && to >= end;
    })?.[1] ?? '' : '',
  }; };
  void revision;
  return { data, loading: !data && !error, refreshing: !!data && !liveData && !error,
    error, month, retry, fromDeviceCache, deviceSavedAt };
}
