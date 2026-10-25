import { createHash } from 'node:crypto';
import type { Principal } from '../workspace-auth/types';
import type { FinanceEntry, FinanceOrder } from '../finance-model';
import { taipeiDate } from '../finance-model.ts';
import { ledgerKey } from '../os-payments.ts';
import { ironGateCalendarConfig } from './iron-gate-calendar.server.ts';
import { callIronGate, type ManualConfig, type Grant } from './iron-gate-manual.server.ts';
import { checkPaymentBooking } from './iron-gate-manual-payment.server.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => { throw Error('IRON_GATE_FINANCE_INCOMPLETE'); };

export function ironGateFinanceConfig(env: NodeJS.ProcessEnv = process.env): ManualConfig {
  try {
    if (env.IRON_GATE_SWEETFUN_FINANCE_ENABLED !== 'true' || env.CALENDAR_SOURCE !== 'sheet_snapshot') throw Error();
    const calendar = ironGateCalendarConfig(env);
    const grant = JSON.parse(env.IRON_GATE_SWEETFUN_FINANCE_GRANT ?? 'null');
    if (!object(grant) || Object.keys(grant).sort().join(',') !==
      'clientId,credentialId,propertyId,token,workspaceId' ||
      !UUID.test(String(grant.credentialId)) || !UUID.test(String(grant.clientId)) ||
      grant.propertyId !== calendar.grant.propertyId || grant.workspaceId !== calendar.grant.workspaceId ||
      typeof grant.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(grant.token) ||
      calendar.expectedAuthorityEpoch < 1) throw Error();
    return { calendar, grant: grant as Grant };
  } catch { throw Error('IRON_GATE_FINANCE_UNAVAILABLE'); }
}

export function projectDirectFinance(raw: Record<string, unknown>, config: ManualConfig,
  legacyEntries: FinanceEntry[]) {
  const { revision, ...snapshot } = raw;
  if (raw.schema !== 1 || raw.propertyId !== config.grant.propertyId ||
    raw.workspaceId !== config.grant.workspaceId || raw.authorityEpoch !== config.calendar.expectedAuthorityEpoch ||
    !Number.isSafeInteger(raw.inventoryVersion) || Number(raw.inventoryVersion) < 0 ||
    !Array.isArray(raw.bookings) || raw.bookings.length > 5000 ||
    typeof revision !== 'string' || revision !== createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')) invalid();
  const entries: FinanceEntry[] = [], orders: FinanceOrder[] = [];
  const ids = new Set<string>(), eventIds = new Set<string>();
  const roomNames = new Map(Object.entries(config.calendar.roomIds).map(([name, id]) => [id, name]));
  for (const value of raw.bookings as unknown[]) {
    if (!object(value) || !UUID.test(String(value.id)) || ids.has(String(value.id))) invalid();
    const booking = value as Record<string, unknown>;
    const checked = checkPaymentBooking(booking, config, String(booking.id));
    ids.add(checked.bookingId);
    const id = `IG-${checked.bookingId}`, orderKey = ledgerKey('sweetfun', id);
    // Conflicting identity is a blocking incident, never an amount/date heuristic.
    if (legacyEntries.some(entry => entry.status === 'active' &&
      (entry.order_key === orderKey || entry.order_id === id || entry.order_id === checked.bookingId ||
        entry.allocations?.some(allocation => [id, checked.bookingId].includes(allocation.order_id)))))
      throw Error('IRON_GATE_LEGACY_LEDGER_CONFLICT');
    if (checked.totalCents === null || !Array.isArray(booking.stays) || !booking.stays.length || booking.stays.length > 32) invalid();
    const stays = booking.stays as Record<string, unknown>[];
    const rooms = new Set<string>(), occupied = new Set<string>();
    for (const stay of stays) {
      if (!object(stay) || !Array.isArray(stay.roomIds) || !stay.roomIds.length || stay.roomIds.length > 6 ||
        typeof stay.checkIn !== 'string' || typeof stay.checkOut !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(stay.checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(stay.checkOut) ||
        !Number.isFinite(Date.parse(stay.checkIn)) || !Number.isFinite(Date.parse(stay.checkOut)) ||
        new Date(stay.checkIn).toISOString().slice(0, 10) !== stay.checkIn ||
        new Date(stay.checkOut).toISOString().slice(0, 10) !== stay.checkOut ||
        stay.checkOut <= stay.checkIn) invalid();
      const first = Date.parse(String(stay.checkIn)), end = Date.parse(String(stay.checkOut));
      if ((end - first) / 86_400_000 > 366) invalid();
      for (const roomId of stay.roomIds as unknown[]) {
        const name = roomNames.get(String(roomId));
        if (!name) invalid();
        rooms.add(name!);
        for (let night = first; night < end; night += 86_400_000) {
          const key = `${roomId}:${night}`;
          if (occupied.has(key) || occupied.size >= 4096) invalid();
          occupied.add(key);
        }
      }
    }
    const checkIn = stays.map(stay => String(stay.checkIn)).sort()[0];
    const checkOut = stays.map(stay => String(stay.checkOut)).sort().at(-1)!;
    orders.push({ id, calendar_id: id, booking_id: checked.bookingId, source: 'iron_gate',
      status: checked.status as 'held' | 'confirmed' | 'cancelled', platform: 'direct', rooms: [...rooms].sort(),
      check_in: checkIn, check_out: checkOut, total: checked.totalCents!, received: checked.netReceivedCents,
      receivable: checked.status !== 'confirmed' ? 0 : Math.max(0, checked.totalCents! - checked.netReceivedCents),
      credit: Math.max(0, checked.netReceivedCents - (checked.status === 'cancelled' ? 0 : checked.totalCents!)),
      eligible_date: null, source_paid: checked.netReceivedCents >= checked.totalCents!,
      source_version: `${checked.bookingId}:${checked.version}` });
    for (const event of checked.events) {
      if (eventIds.has(event.id)) invalid();
      eventIds.add(event.id);
      entries.push({ id: `iron-gate:${config.grant.propertyId}:${event.id}`, property_id: 'sweetfun',
        kind: event.kind === 'received' ? 'income' : 'refund', category: 'lodging',
        amount_cents: event.amountCents, date: taipeiDate(new Date(event.occurredAt)),
        description: `${event.kind === 'received' ? '直訂收款' : '直訂退款'} · ${event.evidenceRef}`,
        method: event.method ?? 'other', source: 'iron_gate', actor: event.actorId,
        created_at: event.recordedAt, status: 'active', order_id: id, order_key: orderKey,
        platform: 'direct', iron_gate_booking_id: checked.bookingId, payment_event_id: event.id,
        ...(event.refundOfEventId ? { refund_of_event_id: event.refundOfEventId } : {}) });
    }
  }
  return { entries, orders, revision: revision as string };
}

export async function readDirectFinance(principal: Principal, config: ManualConfig,
  legacyEntries: FinanceEntry[], send: typeof fetch = fetch) {
  const raw = await callIronGate(config, principal, 'GET',
    `/v1/properties/${config.grant.propertyId}/finance/direct-snapshot`, null, null,
    send, ['finance:ledger'], ['money'], 2_100_000);
  return projectDirectFinance(raw, config, legacyEntries);
}
