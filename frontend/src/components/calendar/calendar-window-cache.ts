import { ApiError } from '@/lib/api-client';
import type { CalendarResponse } from './calendar-types';
import { combinedCalendarWindows, validCalendarResponse } from './calendar-retention';

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
  const existing = state.pending.get(key);
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
    const priorVersion = state.windows.values().next().value?.data.source?.private_snapshot_version;
    const nextVersion = response.source?.private_snapshot_version;
    if (state.foregroundKey !== key && (!state.windows.size || priorVersion !== nextVersion)) return null;
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
