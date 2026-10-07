import type { CalendarBooking, CalendarResponse } from '../../components/calendar/calendar-types';
import type { SheetSourceDefinition } from './config';
import type { BookingSourceSnapshot } from './sweetfun-sheet';
import { attachPrivateGuestNames } from './private-guest-names';
import { safeError } from '../sheet-monitor/runner';

type Phase = 'snapshot' | 'guest_details' | 'payments';
export type CalendarReadEvent = { property_id: string; phase: Phase; status: 'ok' | 'error'; code: string | null; http_status: number | null; duration_ms: number };
type Dependencies = {
  snapshot: (source: SheetSourceDefinition) => Promise<BookingSourceSnapshot | null>;
  details: (source: SheetSourceDefinition, signal: AbortSignal) => Promise<unknown[][]>;
  payments: (bookings: CalendarBooking[]) => Promise<CalendarBooking[]>;
  report?: (event: CalendarReadEvent) => void;
  timeoutMs?: number;
};

export function calendarReadError(error: unknown) {
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) return 'CALENDAR_READ_TIMEOUT';
  if (error instanceof Error && ['STORE_UNAVAILABLE', 'CALENDAR_SOURCES_UNAVAILABLE', 'PAYMENT_DATA_INVALID'].includes(error.message)) return error.message;
  return safeError(error);
}

// Bound each optional read. Late provider completions never mutate the returned snapshot.
async function bounded<T>(read: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new DOMException('Calendar read timed out', 'TimeoutError')); }, milliseconds);
  });
  try { return await Promise.race([read(controller.signal), timeout]); }
  finally { clearTimeout(timer!); }
}

export function unconfirmedDetails(booking: CalendarBooking): CalendarBooking {
  if (booking.source_conflict) return { ...booking, snapshot_only: true };
  return { ...booking, snapshot_only: true, guest_name: '姓名暫時無法確認', guest_name_kind: 'missing', guest_name_sources: [],
    guest_remarks: [], source_notes: [], source_notes_unconfirmed: true, external_order_no: null, owlnest_order_no: null, service_note: null };
}
export function unconfirmedPayment(booking: CalendarBooking): CalendarBooking {
  return { ...booking, snapshot_only: true, payment_unconfirmed: true, payment_status: 'unknown', payments: [], audit_log: [],
    source_payment_flag: 'unknown', source_payment_label: '付款資料暫時無法確認，請勿視為未付款' };
}

// Only authorized definitions enter this reader. A failed enrichment cannot remove occupancy.
export async function readCalendarSources(definitions: SheetSourceDefinition[], start: string, end: string, viewPrices: boolean, deps: Dependencies) {
  const sourceErrors: NonNullable<CalendarResponse['source_errors']> = [];
  const warnings: NonNullable<CalendarResponse['source_warnings']> = [];
  const snapshots: { definition: SheetSourceDefinition; snapshot: BookingSourceSnapshot }[] = [];
  async function stage<T>(definition: SheetSourceDefinition, phase: Phase, read: (signal: AbortSignal) => Promise<T>) {
    const began = Date.now();
    try {
      const result = await bounded(read, deps.timeoutMs ?? 6500);
      deps.report?.({ property_id: definition.property.id, phase, status: 'ok', code: null, http_status: null, duration_ms: Date.now() - began });
      return result;
    } catch (error) {
      const status = error && typeof error === 'object' && 'httpStatus' in error && Number.isInteger(error.httpStatus) ? Number(error.httpStatus) : null;
      deps.report?.({ property_id: definition.property.id, phase, status: 'error', code: calendarReadError(error), http_status: status, duration_ms: Date.now() - began });
      throw error;
    }
  }
  const bookings = (await Promise.all(definitions.map(async definition => {
    let snapshot: BookingSourceSnapshot;
    try {
      snapshot = await stage(definition, 'snapshot', async () => {
        const result = await deps.snapshot(definition);
        if (!result || result.schema_version !== 1 || !Array.isArray(result.bookings) || result.source.id !== definition.sourceId || result.bookings.some(b => b.property_id !== definition.property.id)) throw Error('MONITOR_STORAGE_INVALID');
        return result;
      });
    } catch {
      sourceErrors.push({ property_id: definition.property.id, label: definition.property.sourceLabel });
      return [];
    }
    snapshots.push({ definition, snapshot });
    const orders = new Set(snapshot.bookings.filter(b => b.check_in < end && b.check_out >= start).map(b => b.order_id));
    let rows = snapshot.bookings.filter(b => orders.has(b.order_id));
    const warn = (phase: 'guest_details' | 'payments' | 'snapshot') => warnings.push({ property_id: definition.property.id, label: definition.property.sourceLabel, phase });
    // Even a successful metadata read cannot make an older occupancy snapshot current.
    if (snapshot.source.sync?.status !== 'healthy') {
      rows = rows.map(b => ({ ...b, snapshot_only: true }));
      warn('snapshot');
    }
    if (rows.length) {
      try { rows = await stage(definition, 'guest_details', async signal => {
        const values = await deps.details(definition, signal);
        if (values.length < 2) throw Error('SHEET_EMPTY_SOURCE');
        return attachPrivateGuestNames(rows, values, definition);
      }); }
      catch { rows = rows.map(unconfirmedDetails); warn('guest_details'); }
      if (rows.some(b => b.source_notes_unconfirmed)) {
        const unconfirmedOrders = new Set(rows.filter(b => b.source_notes_unconfirmed).map(b => b.order_id));
        rows = rows.map(b => unconfirmedOrders.has(b.order_id) ? { ...b, snapshot_only: true } : b);
        if (!warnings.some(w => w.property_id === definition.property.id && w.phase === 'guest_details')) warn('guest_details');
      }
      if (viewPrices) {
        try { rows = await stage(definition, 'payments', () => deps.payments(rows)); }
        catch { rows = rows.map(unconfirmedPayment); warn('payments'); }
      }
    }
    return rows;
  }))).flat();
  // Preserve configured order regardless of network completion order.
  snapshots.sort((a, b) => definitions.indexOf(a.definition) - definitions.indexOf(b.definition));
  if (!snapshots.length) throw Error('CALENDAR_SOURCES_UNAVAILABLE');
  return { snapshots, bookings, errors: sourceErrors, warnings };
}
