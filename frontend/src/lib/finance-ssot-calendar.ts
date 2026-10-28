import type {CalendarBooking} from '../components/calendar/calendar-types.ts';
import type {FinanceOrder} from './finance-model.ts';

/** Imported-order payment state must come from the accepted ledger after cutover. */
export function overlaySsotCalendarPayments(bookings:CalendarBooking[],orders:FinanceOrder[],property='sweetfun'){
  const byId=new Map(orders.map(order=>[order.id,order]));
  return bookings.map(booking=>{
    if(booking.property_id!==property)throw Error('FINANCE_SSOT_READBACK_MISMATCH');
    if(property==='sweetfun'&&booking.iron_gate_source==='os')return booking;
    if(booking.source_conflict||booking.reservation_status==='cancelled')return booking;
    const key=property==='offland'&&booking.iron_gate_booking_id?
      `IG-${booking.iron_gate_booking_id}`:booking.payment_order_id??booking.order_id;
    const order=byId.get(key);
    if(!order||(property==='sweetfun'&&order.source==='iron_gate')||order.total<0||order.received<0)
      throw Error('FINANCE_SSOT_READBACK_MISMATCH');
    if(order.receivable_review_required||order.amount_review_required)
      return {...booking,payment_status:'unknown' as const};
    const status:CalendarBooking['payment_status']=order.total>0&&order.received>=order.total?
      'paid':order.received>0?'deposit':'unknown';
    return {...booking,payment_status:status};
  });
}
