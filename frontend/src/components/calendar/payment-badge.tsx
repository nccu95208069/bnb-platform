import type { CalendarBooking } from './calendar-types';
import { PAYMENT_LABELS } from './calendar-utils';
const styles={paid:'bg-emerald-50 text-emerald-800 border-emerald-600',deposit:'bg-amber-50 text-amber-900 border-amber-600',unpaid:'bg-rose-50 text-rose-800 border-rose-600',unknown:'bg-slate-100 text-slate-700 border-slate-400'};
const symbols={paid:'✓',deposit:'訂',unpaid:'未',unknown:'?'};
export function PaymentBadge({booking,compact=false}:{booking:CalendarBooking;compact?:boolean}) {
  if(booking.price_hidden||booking.source_conflict)return null;
  return <span title={PAYMENT_LABELS[booking.payment_status]} aria-label={PAYMENT_LABELS[booking.payment_status]} className={`payment-badge inline-flex shrink-0 items-center justify-center rounded-sm border px-0.5 text-[9px] leading-3 font-semibold ${styles[booking.payment_status]}`}>{compact?symbols[booking.payment_status]:PAYMENT_LABELS[booking.payment_status]}</span>;
}
