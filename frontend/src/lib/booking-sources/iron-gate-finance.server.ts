import { checkedAmountBreakdown, type SourceAmountBreakdown } from '../source-amount-reconciliation.ts';
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
  const entries: FinanceEntry[] = [], orders: FinanceOrder[] = [], replacedOrderIds: string[] = [];
  const ids = new Set<string>(), eventIds = new Set<string>();
  const roomNames = new Map(Object.entries(config.calendar.roomIds).map(([name, id]) => [id, name]));
  for (const value of raw.bookings as unknown[]) {
    if (!object(value) || !UUID.test(String(value.id)) || ids.has(String(value.id))) invalid();
    const booking = value as Record<string, unknown>;
    const card = booking.source === 'external' && booking.cardManaged === true;
    const aliases = card ? booking.legacyAliases : [];
    if (card && (!Array.isArray(aliases) || aliases.length < 2 || aliases.length > 20 ||
      aliases.some(alias => typeof alias !== 'string' || !/^(?:SF-[a-f0-9]{20}|IG-[0-9a-f-]{36}|[0-9a-f-]{36})$/.test(alias)))) invalid();
    const checked = checkPaymentBooking(booking, config, String(booking.id), card);
    const identity = card ? aliases as string[] : [`IG-${checked.bookingId}`, checked.bookingId];
    if (card) replacedOrderIds.push(...identity);
    ids.add(checked.bookingId);
    const id = `IG-${checked.bookingId}`, orderKey = ledgerKey('sweetfun', id);
    // Conflicting identity is a blocking incident, never an amount/date heuristic.
    if (legacyEntries.some(entry => entry.status === 'active' &&
      (identity.some(alias => entry.order_key === ledgerKey('sweetfun', alias)) || identity.includes(entry.order_id ?? '') ||
        entry.allocations?.some(allocation => identity.includes(allocation.order_id)))))
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
      status: checked.status as 'held' | 'confirmed' | 'cancelled', platform: card ? 'booking' : 'direct', rooms: [...rooms].sort(),
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
        description: `${card ? 'Booking 刷卡' : event.kind === 'received' ? '直訂收款' : '直訂退款'} · ${event.evidenceRef}`,
        method: event.method ?? 'other', source: 'iron_gate', actor: event.actorId,
        created_at: event.recordedAt, status: 'active', order_id: id, order_key: orderKey,
        platform: card ? 'booking' : 'direct', iron_gate_booking_id: checked.bookingId, payment_event_id: event.id,
        ...(event.refundOfEventId ? { refund_of_event_id: event.refundOfEventId } : {}) });
    }
  }
  const amountReconciliations = checkedFinanceCorrections(raw.sourceAmountReconciliations ?? [], config);
  return { entries, orders, replacedOrderIds, amountReconciliations, revision: revision as string };
}

export async function readDirectFinance(principal: Principal, config: ManualConfig,
  legacyEntries: FinanceEntry[], send: typeof fetch = fetch) {
  const raw = await callIronGate(config, principal, 'GET',
    `/v1/properties/${config.grant.propertyId}/finance/direct-snapshot`, null, null,
    send, ['finance:ledger'], ['money'], 2_100_000);
  return projectDirectFinance(raw, config, legacyEntries);
}


type FinanceCorrection = SourceAmountBreakdown & {bookingId:string;version:number;status:string;orderId:string;room:string};
export function checkedFinanceCorrections(raw: unknown, config: ManualConfig): FinanceCorrection[] {
  if (!Array.isArray(raw) || raw.length > 5000) return invalid();
  const rows = raw.map(value => {
    if (!object(value) || !UUID.test(String(value.bookingId)) ||
      !['confirmed','cancelled'].includes(String(value.status))) return invalid();
    const amount = checkedAmountBreakdown(value, Number(value.netCents), Number(value.version));
    const property = config.calendar.propertyKey ?? 'sweetfun';
    if ((amount.schema === 1 ? 'sweetfun' : amount.sourceProperty) !== property) return invalid();
    const room = Object.entries(config.calendar.roomIds).find(([,id]) => id === amount.roomId)?.[0];
    if (!room) return invalid();
    const orderId = `SF-${createHash('sha256').update(
      `${property}-operations-sheet-v1:order:ungrouped:${amount.sourceOrderRef.slice(2)}`).digest('hex').slice(0,20)}`;
    return {...amount,bookingId:String(value.bookingId),version:Number(value.version),status:String(value.status),orderId,room};
  });
  if (new Set(rows.map(r => r.bookingId)).size !== rows.length ||
    new Set(rows.map(r => r.orderId)).size !== rows.length) return invalid();
  const fields = ['groupOriginalCents','groupGrossCents','groupHostFeeCents','groupNetCents',
    'groupTaxCents','groupGuestFeeCents','groupGuestPaidCents','externalOrderNo','checkIn','checkOut'] as const;
  for (const groupId of new Set(rows.map(r => r.groupId))) {
    const group=rows.filter(r => r.groupId===groupId), first=group[0];
    const sharedFields=first.schema===2?fields.filter(k=>k!=='checkIn'&&k!=='checkOut'):fields;
    const occupied=new Set<string>();
    for(const row of group) for(let day=Date.parse(row.checkIn);day<Date.parse(row.checkOut);day+=86400000){
      const key=`${row.roomId}:${day}`;if(occupied.has(key))return invalid();occupied.add(key);
    }
    if (group.length!==first.groupSize || group.some(r=>r.schema!==first.schema||r.sourceProperty!==first.sourceProperty||r.groupSize!==first.groupSize) ||
      group.some(r => sharedFields.some(k => r[k]!==first[k])) ||
      group.reduce((s,r)=>s+r.originalTotalCents,0)!==first.groupOriginalCents ||
      group.reduce((s,r)=>s+r.grossCents,0)!==first.groupGrossCents ||
      group.reduce((s,r)=>s+r.hostFeeCents,0)!==first.groupHostFeeCents ||
      group.reduce((s,r)=>s+r.netCents,0)!==first.groupNetCents) return invalid();
  }
  return rows;
}

export function applyFinanceAmountCorrections(orders: FinanceOrder[], corrections: FinanceCorrection[]) {
  for (const correction of corrections) {
    const matches=orders.filter(o => o.id===correction.orderId);
    const order=matches[0];
    if (matches.length!==1 || order.source || order.platform!=='airbnb' ||
      order.rooms.length!==1 || order.rooms[0]!==correction.room ||
      order.check_in!==correction.checkIn || order.check_out!==correction.checkOut ||
      order.total!==correction.originalTotalCents) return invalid();
    order.total=correction.netCents;
    order.status=correction.status as 'confirmed'|'cancelled';
    order.receivable=order.status==='cancelled'?0:Math.max(0,order.total-order.received);
    order.credit=Math.max(0,order.received-(order.status==='cancelled'?0:order.total));
    order.source_version=`${correction.bookingId}:${correction.version}`;
    order.amount_reconciliation=correction;
  }
}
