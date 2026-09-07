import type { AvailabilityQuery, AvailabilityResult, InventoryState, RoomNight } from './availability';
import type { BookingSourceSnapshot } from './booking-sources/sweetfun-sheet';
import { PRICING_ROOMS, type PricingSnapshot } from './pricing-snapshot';

const nextDay = (d: string) => new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0,10);
export function liveAvailability(query: AvailabilityQuery, bookings: BookingSourceSnapshot, prices: PricingSnapshot | null, now = new Date()): AvailabilityResult {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year:'numeric',month:'2-digit',day:'2-digit' }).format(now);
  const rooms = query.rooms.length ? query.rooms : PRICING_ROOMS;
  const priceMap = new Map(prices?.cells.map(c => [`${c.date}|${c.room}`, c]));
  const counts: Record<InventoryState, number> = {available:0,sold:0,held:0,blocked:0,maintenance:0,unknown:0,conflict:0,past:0};
  const cells: RoomNight[] = [];
  const healthy = bookings.source.sync?.status === 'healthy';
  const freshStock = !!prices && now.getTime() - Date.parse(prices.observed_at) < 15 * 60000;
  for (let date = query.start; date < query.end; date = nextDay(date)) for (const room of rooms) {
    const occupied = bookings.bookings.filter(b => b.room_number === room && b.reservation_status !== 'cancelled' && b.check_in <= date && b.check_out > date);
    const p = priceMap.get(`${date}|${room}`);
    let state: InventoryState = date < today ? 'past' : occupied.some(b => b.source_conflict) ? 'conflict' : occupied.length ? 'sold' : !healthy ? 'unknown' : 'available';
    // Sheet absence is an unsold observation, not a promise that all channels are open.
    if (state === 'available' && p?.stock?.is_lock) state = 'blocked';
    else if (state === 'available' && p?.stock?.count === 0) state = 'unknown';
    const reason = {available:'訂房表尚無訂單；接單前仍須確認通路庫存與住宿限制。',sold:'訂房表已有訂單',past:'已過去的房晚',conflict:'訂房表有衝突，需先確認',unknown:'訂房表同步或通路庫存待確認',blocked:'OwlNest 最近一次觀測為封房，重新開放前請再次確認',held:'暫留',maintenance:'維修'}[state];
    const stalePrice = !!prices && now.getTime() - Date.parse(prices.observed_at) > 4 * 86400000;
    cells.push({date,room,state,reason,sales_probability:p?.sales_probability ?? null,sellable_units:null,minimum_nights:0,max_guests:0,
      inventory_observed_at:bookings.source.sync?.last_checked_at ?? bookings.source.observed_at,
      freshness:healthy ? 'sheet_unsold_not_booking_confirmation' : 'stale',
      pricing: { current_price:p?.channels[query.channel] ?? null, base_price:p?.rack_price ?? null,
        suggested_price:null,guest_pay_price:null,currency:'TWD',channel:query.channel,
        policy:!p ? 'price_missing' : stalePrice ? 'stale_snapshot' : 'observed_snapshot',eligible:false,exclusion:null,
        baseline_version:p?.baseline_version ?? '',price_version:prices?.version ?? '',plan_version:'',
        limits:`${p?.daytype ?? ''}；${freshStock ? '含近期庫存觀測' : '庫存觀測需重新確認'}；未含客人促銷、加人與住宿限制`,
        observed_at:prices?.observed_at ?? '',source:'bnb-pricing / OwlNest readback',suggestion_source:'none' },
    });
    counts[state]++;
  }
  return {status:'read_only',mode:'live_sheet_pricing_snapshot',snapshot_id:`${bookings.source.snapshot_version}:${prices?.version ?? 'missing'}`,asof:today,query,property_id:'sweetfun',rooms,cells,counts,price_hidden:false,continuous_windows:[],
    source_notice: prices ? `訂房表持續同步。房價讀取於 ${new Date(prices.observed_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})}；此為通路系統價，非客人促銷後實付。房價由定價專案發布快照更新，尚非即時連線。` : '訂房表持續同步；價格來源尚未發布，請勿據此報價。'};
}
