import type { CalendarReadEvent } from './booking-sources/calendar-reader';

type CalendarReadPhase = 'auth' | 'source' | 'payment';

// Fixed metric names and durations only: no user, property, cookie or error data.
export function calendarServerTiming(now: () => number = () => performance.now()) {
  const started = now();
  const durations: Record<CalendarReadPhase, number> = { auth: 0, source: 0, payment: 0 };
  return {
    async measure<T>(phase: CalendarReadPhase, read: () => Promise<T>): Promise<T> {
      const began = now();
      try { return await read(); }
      finally { durations[phase] += Math.max(0, now() - began); }
    },
    recordReadEvent(event: Pick<CalendarReadEvent, 'phase' | 'duration_ms'>) {
      // Sheet enrichment is bounded by its reader, outside the provider promise.
      // Capture the completed/expired stage so a still-pending provider does not
      // incorrectly report zero, or later add a second duration after timeout.
      if (event.phase === 'payments' && Number.isFinite(event.duration_ms))
        durations.payment += Math.max(0, event.duration_ms);
    },
    apply(headers: Headers) {
      const metrics = { ...durations, total: Math.max(0, now() - started) };
      headers.set('Server-Timing', Object.entries(metrics)
        .map(([name, duration]) => `${name};dur=${duration.toFixed(1)}`).join(', '));
    },
  };
}
export type CalendarServerTiming = ReturnType<typeof calendarServerTiming>;
