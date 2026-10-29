"use client";
import {useT} from "@/components/i18n/language-provider";
import type { CalendarBooking } from './calendar-types';
import { PAYMENT_LABELS } from './calendar-utils';
import { paymentStateForReview } from './calendar-utils';
const styles={paid:'bg-emerald-50 text-emerald-800 border-emerald-600',deposit:'bg-amber-50 text-amber-900 border-amber-600',unpaid:'bg-rose-50 text-rose-800 border-rose-600',unknown:'bg-slate-100 text-slate-700 border-slate-400'};
const symbols={paid:'✓',deposit:'訂',unpaid:'未',unknown:'?'};
export function PaymentBadge({booking,compact=false}:{booking:CalendarBooking;compact?:boolean}) {
  const uiText=useT();
  if(booking.legacy_settlement_status){
    const review=booking.legacy_settlement_status==='review_required';
    const label=review?'歷史付款狀態需重新核對':'切換前已結清（收款明細未核實）';
    return <span title={uiText(label)} aria-label={uiText(label)}
      className={`payment-badge inline-flex shrink-0 items-center justify-center rounded-sm border px-0.5 text-[0.5625rem] leading-3 font-semibold ${review?'border-amber-600 bg-amber-50 text-amber-900':'border-teal-700 bg-teal-50 text-teal-900'}`}>
      {compact?review?'核':'前':uiText(review?'需重新核對':'切換前結清')}
    </span>;
  }
  const status=paymentStateForReview(booking);
  if(!status||status==='unknown')return null;
  return <span title={uiText(PAYMENT_LABELS[status])} aria-label={uiText(PAYMENT_LABELS[status])} className={`payment-badge inline-flex shrink-0 items-center justify-center rounded-sm border px-0.5 text-[0.5625rem] leading-3 font-semibold ${styles[status]}`}>{compact?symbols[status]:uiText(PAYMENT_LABELS[status])}</span>;
}
