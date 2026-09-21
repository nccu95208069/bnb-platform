/** Device drafts only. No guest identifiers or booking rows leave this projection. */
import { createHash } from 'node:crypto';
import type { BookingSourceSnapshot } from './booking-sources/sweetfun-sheet';
import type { PricingSnapshot } from './pricing-snapshot.ts';
import { PRICING_ROOMS } from './pricing-snapshot.ts';

export function roomQuoteLibrary(bookings: BookingSourceSnapshot, prices: PricingSnapshot, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const checked = Date.parse(bookings.source.sync?.last_checked_at ?? '');
  const healthy = bookings.source.sync?.status === 'healthy' && now.getTime()-checked >= -30_000 && now.getTime()-checked <= 300_000;
  const cells = prices.cells.filter(c => c.date >= today && Date.parse(c.date)-Date.parse(today) <= 365*86400000 && PRICING_ROOMS.includes(c.room)).map(c => {
    const occupied = bookings.bookings.filter(b => b.room_number===c.room && b.reservation_status!=='cancelled' && b.check_in<=c.date && b.check_out>c.date);
    const price = c.channels.direct;
    const age = now.getTime()-Date.parse(c.observed_at ?? prices.observed_at);
    let state: 'unsold'|'sold'|'blocked'|'unknown' = 'unknown';
    if (healthy && occupied.length===1 && !occupied[0].source_conflict) state='sold';
    else if (healthy && occupied.length===0 && age>=-30_000 && age<=7*86400000) {
      if(c.stock?.is_lock) state='blocked';
      else if(c.stock?.count && Number.isSafeInteger(price) && Number(price)>0) state='unsold';
    }
    return {date:c.date,room:c.room,state,price:state==='unsold'?price:null};
  }).sort((a,b)=>a.date.localeCompare(b.date)||a.room.localeCompare(b.room));
  // Content-derived version is stable across reads. Source timestamps remain metadata.
  const version=createHash('sha256').update(JSON.stringify(cells)).digest('hex');
  return {schema:1,property_id:'sweetfun',channel:'direct',preview_only:true,version,
    observed_at:prices.observed_at,inventory_checked_at:bookings.source.sync?.last_checked_at ?? null,
    cells};
}
