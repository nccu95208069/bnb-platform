import type { CalendarResponse } from '../components/calendar/calendar-types';
import { validCalendarResponse } from '../components/calendar/calendar-retention';
import { ApiError, apiClient } from './api-client';
import { applyCalendarDelta, createCalendarManifest } from './calendar-sync';

export async function readCalendarWithChanges(start: string, end: string, propertyIds: string[],
  base?: CalendarResponse): Promise<CalendarResponse> {
  const selected = propertyIds.length ? `&properties=${encodeURIComponent(propertyIds.join(','))}` : '';
  const full = async () => {
    const response = await apiClient.get<unknown>(`/bookings/calendar?start=${start}&end=${end}${selected}`);
    if (!validCalendarResponse(response, start, end))
      throw Error('收到的日曆資料不完整，保留上次資料。');
    return response;
  };
  if (!base || base.period_start !== start || base.period_end !== end || !globalThis.crypto?.subtle) return full();
  let manifest;
  try { manifest = await createCalendarManifest(base); }
  catch { return full(); }
  let delta;
  try {
    delta = await apiClient.post<unknown>('/bookings/calendar/sync', { manifest, properties: propertyIds });
  } catch (error) {
    // A rejected base can recover with one authoritative full read. Access
    // failures must reach the hook's revocation path; network errors are not retried.
    if (error instanceof ApiError && error.status === 409) return full();
    throw error;
  }
  try { return await applyCalendarDelta(base, manifest, delta); }
  catch {
    // Discard the whole invalid patch. A failed full read still leaves the
    // explicitly stale display intact, without retrying the broken base again.
    return full();
  }
}
