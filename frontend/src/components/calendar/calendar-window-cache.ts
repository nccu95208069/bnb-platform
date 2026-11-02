import { ApiError } from '@/lib/api-client';
import type { CalendarResponse } from './calendar-types';
import { calendarResponseVersion, combinedCalendarWindows, validCalendarResponse } from './calendar-retention';
import { containsRange, rangesCover } from './calendar-prefetch';

type CachedWindow = { data: CalendarResponse; at: number };
export type CalendarWindowState = {
  scope: string;
  reload: number;
  foregroundKey: string | null;
  requestKey: string | null;
  versionEpoch: number;
  revoked: boolean;
  windows: Map<string, CachedWindow>;
  pending: Map<string, Promise<CalendarResponse | null>>;
};

// Every scope/reload starts a new cache. Payments and guest edits may change
// without advancing inventory version, so no old window can satisfy a reload.
export function createCalendarWindowState(scope: string, reload: number): CalendarWindowState {
  return { scope, reload, foregroundKey: null, requestKey: null,
    versionEpoch: 0, revoked: false, windows: new Map(), pending: new Map() };
}

export function calendarWindowKey(start: string, end: string) {
  return `${start}:${end}`;
}

function keyRange(key: string) {
  const [start, end] = key.split(':');
  return { start, end };
}

// Navigation into a month already included in a larger pending batch shares
// that request. Shifting the six-month horizon must not re-read its overlaps.
export function calendarWindowScheduled(state: CalendarWindowState, start: string, end: string) {
  return rangesCover([
    ...[...state.windows.values()].map(({ data }) => ({ start: data.period_start, end: data.period_end })),
    ...[...state.pending.keys()].map(keyRange),
  ], { start, end });
}

export function cachedCalendarWindow(state: CalendarWindowState, start: string, end: string) {
  if (state.revoked) return null;
  const fresh = [...state.windows.values()].filter(item =>
    item.data.source?.private_snapshot_version || Date.now() - item.at < 120_000);
  return combinedCalendarWindows(fresh.map(item => item.data), start, end);
}

export function readCalendarWindow(state: CalendarWindowState, start: string, end: string,
  read: (start: string, end: string) => Promise<CalendarResponse>,
  isCurrent: () => boolean, onAccessLost: (error: ApiError) => void): Promise<CalendarResponse | null> {
  if (!isCurrent() || state.revoked) return Promise.resolve(null);
  const key = calendarWindowKey(start, end);
  const existing = state.pending.get(key) ?? [...state.pending].find(([pending]) =>
    containsRange(keyRange(pending), { start, end }))?.[1];
  if (existing) return existing;
  const epoch = state.versionEpoch;
  const current = () => isCurrent() && !state.revoked && state.versionEpoch === epoch;
  // Commit a valid result before resolving the shared promise or removing it
  // from pending. A fast neighbor never waits for the other prefetch to finish.
  const request = Promise.resolve().then(() => read(start, end)).then(response => {
    if (!current()) return null;
    if (!validCalendarResponse(response, start, end)) {
      throw Error('收到的日曆資料不完整，保留上次資料。');
    }
    const priorData = state.windows.values().next().value?.data;
    const priorVersion = priorData && calendarResponseVersion(priorData);
    const nextVersion = calendarResponseVersion(response);
    const foreground = state.foregroundKey && containsRange({ start, end }, keyRange(state.foregroundKey));
    if (!foreground && (!state.windows.size || priorVersion !== nextVersion)) return null;
    if (state.windows.size && priorVersion !== nextVersion) {
      // Only the current foreground read may advance the inventory version.
      // Pending neighbors from the old version cannot join or refill this cache.
      state.windows.clear();
      state.pending.clear();
      state.versionEpoch++;
    }
    state.windows.delete(key);
    state.windows.set(key, { data: response, at: Date.now() });
    while (state.windows.size > 7) state.windows.delete(state.windows.keys().next().value!);
    return response;
  }).catch(cause => {
    if (!current()) return null;
    if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
      state.revoked = true;
      state.windows.clear();
      state.pending.clear();
      onAccessLost(cause);
    }
    throw cause;
  }).finally(() => {
    if (state.pending.get(key) === request) state.pending.delete(key);
  });
  state.pending.set(key, request);
  return request;
}
