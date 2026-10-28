import type {CalendarBooking} from '../components/calendar/calendar-types.ts';
import type {FinanceOrder} from './finance-model.ts';

/** Imported-order payment state must come from the accepted ledger after cutover. */
export function overlaySsotCalendarPayments(bookings:CalendarBooking[],orders:FinanceOrder[]){
  const byId=new Map(orders.map(order=>[order.id,order]));
  return bookings.map(booking=>{
    if(booking.property_id!=='sweetfun'||booking.iron_gate_source==='os')return booking;
    if(booking.source_conflict||booking.reservation_status==='cancelled')return booking;
    const key=booking.payment_order_id??booking.order_id;
    const order=byId.get(key);
    if(!order||order.source==='iron_gate'||order.total<0||order.received<0)
      throw Error('FINANCE_SSOT_READBACK_MISMATCH');
    const legacy=order.legacy_settlement;
    if(legacy?.review_required)return {...booking,payment_status:'unknown' as const,
      legacy_settlement_status:'review_required' as const};
    if(legacy?.status==='settled_before_cutover_cash_details_unknown'){
      if(!order.collection_hold||order.receivable!==0||
        !order.historical_cash_detail_missing)
        throw Error('FINANCE_SSOT_READBACK_MISMATCH');
      return {...booking,payment_status:'unknown' as const,
        legacy_settlement_status:'settled_before_cutover_cash_details_unknown' as const};
    }
    if(legacy?.status==='unpaid_at_cutover'&&order.received===0&&order.receivable>0)
      return {...booking,payment_status:'unpaid' as const,
        legacy_settlement_status:undefined};
    const status:CalendarBooking['payment_status']=order.total>0&&order.received>=order.total?
      'paid':order.received>0?'deposit':'unknown';
    return {...booking,payment_status:status,legacy_settlement_status:undefined};
  });
}
