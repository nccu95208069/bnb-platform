import type {CalendarBooking} from '../components/calendar/calendar-types.ts';
import type {FinanceOrder} from './finance-model.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function historicalReviewPayment(booking:CalendarBooking):CalendarBooking{
  return {...booking,payment_status:'unknown',payment_review_status:undefined,
    legacy_settlement_status:undefined,payment_unconfirmed:true,
    source_payment_flag:'unknown',
    source_payment_label:'歷史收款尚未核對，請勿視為未付款'};
}

/** The current Offland finance policy always reviews external-source receipts.
 * A freshly authorized calendar snapshot already proves this source identity;
 * reading every historical ledger/catalog row cannot make that status paid.
 * Return null for native, redacted or incomplete rows so the full SSOT read is
 * still required. This shortcut never computes a balance or permits collection.
 */
export function reviewOnlyOfflandCalendarPayments(bookings:CalendarBooking[]):CalendarBooking[]|null{
  if(bookings.some(booking=>booking.property_id!=='offland'))return null;
  const versions=new Map<string,number>();
  for(const booking of bookings){
    if(booking.source_conflict)continue;
    if(booking.price_hidden||booking.reservation_status!=='confirmed'||
      booking.iron_gate_source!=='external'||
      !UUID.test(booking.iron_gate_booking_id??'')||
      !Number.isSafeInteger(booking.iron_gate_booking_version)||
      Number(booking.iron_gate_booking_version)<1||
      booking.source_booking_version!==booking.iron_gate_booking_version)return null;
    const id=booking.iron_gate_booking_id!,version=booking.iron_gate_booking_version!;
    if(versions.has(id)&&versions.get(id)!==version)return null;
    versions.set(id,version);
  }
  return bookings.map(booking=>booking.source_conflict?booking:historicalReviewPayment(booking));
}

/** Imported-order payment state must come from the accepted ledger after cutover. */
export function overlaySsotCalendarPayments(bookings:CalendarBooking[],orders:FinanceOrder[],property='sweetfun'){
  const byId=new Map(orders.map(order=>[order.id,order]));
  return bookings.map(booking=>{
    if(booking.property_id!==property)throw Error('FINANCE_SSOT_READBACK_MISMATCH');
    if(booking.reservation_status==='retained')return {...booking,payment_status:'unknown' as const};
    if(property==='sweetfun'&&booking.iron_gate_source==='os')return booking;
    if(booking.source_conflict||booking.reservation_status==='cancelled')return booking;
    const key=property==='offland'&&booking.iron_gate_booking_id?
      `IG-${booking.iron_gate_booking_id}`:booking.payment_order_id??booking.order_id;
    const order=byId.get(key);
    if(!order||(property==='sweetfun'&&order.source==='iron_gate')||order.total<0||order.received<0)
      throw Error('FINANCE_SSOT_READBACK_MISMATCH');
    // The finance ledger replaces Iron Gate's earlier Sheet/payment review for
    // this display. Leaving the old field would override payment_status in badges.
    const current={...booking,payment_review_status:undefined};
    if(property==='offland'&&
      (order.receivable_review_required||order.amount_review_required))
      return historicalReviewPayment(current);
    const legacy=order.legacy_settlement;
    if(legacy?.review_required)return {...current,payment_status:'unknown' as const,
      legacy_settlement_status:'review_required' as const};
    if(legacy?.status==='settled_before_cutover_cash_details_unknown'){
      if(!order.collection_hold||order.receivable!==0||
        !order.historical_cash_detail_missing)
        throw Error('FINANCE_SSOT_READBACK_MISMATCH');
      return {...current,payment_status:'unknown' as const,
        legacy_settlement_status:'settled_before_cutover_cash_details_unknown' as const};
    }
    if(legacy?.status==='unpaid_at_cutover'&&order.received===0&&order.receivable>0)
      return {...current,payment_status:'unpaid' as const,
        legacy_settlement_status:undefined};
    const status:CalendarBooking['payment_status']=order.total>0&&order.received>=order.total?
      'paid':order.received>0?'deposit':'unknown';
    return {...current,payment_status:status,legacy_settlement_status:undefined};
  });
}
