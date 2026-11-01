import { pricingProperty } from './property-pricing.ts';
import type { AvailabilityQuery, AvailabilityResult, InventoryState, RoomNight } from './availability';
import type { BookingSourceSnapshot } from './booking-sources/sweetfun-sheet';
import type { IronGateAvailabilitySnapshot } from './booking-sources/iron-gate-calendar.server';
import type { ChannelInventory } from './calendar-changes/merge.ts';
import { type PricingSnapshot } from './pricing-snapshot';

const nextDay = (d: string) => new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0,10);
export function liveAvailability(query: AvailabilityQuery, bookings: BookingSourceSnapshot | IronGateAvailabilitySnapshot, prices: PricingSnapshot | null, now = new Date(), property = "sweetfun", inventory: ChannelInventory | null = null): AvailabilityResult {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year:'numeric',month:'2-digit',day:'2-digit' }).format(now);
  const config = pricingProperty(property);
  if (prices && prices.property_id !== property) throw Error("PRICING_PROPERTY_MISMATCH");
  const rooms = query.rooms.length ? query.rooms : config.roomNames;
  const priceMap = new Map(prices?.cells.map(c => [`${c.date}|${c.room}`, c]));
  const stockMap = new Map(inventory?.cells.map(c => [`${c.date}|${c.room}`, c]));
  const authority = 'kind' in bookings && bookings.kind === 'iron_gate' ? bookings : null;
  const sheet = authority ? null : bookings as BookingSourceSnapshot;
  if (authority && (property !== authority.property || authority.from !== query.start || authority.to !== query.end))
    throw Error('IRON_GATE_AVAILABILITY_SCOPE_MISMATCH');
  const localMap = new Map(authority?.cells.map(c => [`${c.date}|${c.room}`, c]));
  const counts: Record<InventoryState, number> = {available:0,sold:0,held:0,blocked:0,maintenance:0,unknown:0,conflict:0,past:0};
  const cells: RoomNight[] = [];
  const healthy = !!authority || sheet?.source.sync?.status === 'healthy';
  for (let date = query.start; date < query.end; date = nextDay(date)) for (const room of rooms) {
    const occupied = sheet?.bookings.filter(b => b.room_number === room && b.reservation_status !== 'cancelled' && b.reservation_status !== 'retained' && b.check_in <= date && b.check_out > date) ?? [];
    const local = localMap.get(`${date}|${room}`);
    const p = priceMap.get(`${date}|${room}`);
    const observed = p?.observed_at ?? prices?.observed_at ?? '';
    const overlay = stockMap.get(`${date}|${room}`);
    const stockAt = p?.stock_observed_at ?? observed;
    const stock = overlay && (!p?.stock || Date.parse(overlay.observed_at) >= Date.parse(stockAt)) ? overlay : p?.stock ? { ...p.stock, observed_at: stockAt } : null;
    const checkedToday = !!stock && Number.isFinite(Date.parse(stock.observed_at)) && new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date(stock.observed_at)) === today;
    const stockDisagrees = healthy && checkedToday && !!stock && (stock.count === 0 || stock.is_lock);
    const state: InventoryState = date < today ? 'past' : authority ?
      !local ? 'unknown' : local.state === 'sold' || local.state === 'held' ? local.state :
      local.state === 'blocked' ? local.protectionReasons.includes('manual_block') ? 'blocked' : 'unknown' :
      stockDisagrees ? 'unknown' : 'available' :
      occupied.some(b => b.source_conflict) ? 'conflict' : occupied.length ? 'sold' : !healthy || stockDisagrees ? 'unknown' : 'available';
    // A channel closure does not prove a booking, but it must not look available either.
    const reason = authority ? state === 'unknown' ?
      !local ? '目前房況資料不完整，請重新讀取後再確認。' : local.state === 'blocked' ?
      '此房晚仍有來源待核或房況同步保護，確認完成前不可視為可接單。' :
      '目前訂單未占房，但今日 OwlNest 庫存為 0 或鎖房；請核對後再接單。' :
      {available:'目前訂單未占房；接單前仍須確認通路庫存與住宿限制。',sold:'目前訂單已占房',
        held:'訂單暫留中',blocked:'此房晚已人工關房，重新開放前請先完成房況確認。',
        past:'已過去的房晚',conflict:'訂單房晚有衝突，需先確認'}[state] :
      stockDisagrees && state === 'unknown' ? '訂房表無單，但今日 OwlNest 庫存為 0 或鎖房；請核對後再接單。' : {available:'訂房表尚無訂單；接單前仍須確認通路庫存與住宿限制。',sold:'訂房表已有訂單',past:'已過去的房晚',conflict:'訂房表有衝突，需先確認',unknown:'訂房表同步待確認',blocked:'OwlNest 最近一次觀測為封房，重新開放前請再次確認',held:'暫留',maintenance:'維修'}[state];
    const stalePrice = !!p && now.getTime() - Date.parse(observed) > 4 * 86400000;
    cells.push({date,room,state,reason,pricing_decision:p?.pricing_decisions?.[query.channel] ?? null,channel_inventory: stock ? { count: stock.count, is_lock: stock.is_lock, observed_at: stock.observed_at, checked_today: checkedToday } : null,sales_probability:p?.sales_probability ?? null,sellable_units:null,minimum_nights:0,max_guests:0,
      inventory_observed_at:authority?.observedAt ?? sheet!.source.sync?.last_checked_at ?? sheet!.source.observed_at,
      freshness:authority ? 'iron_gate_local_inventory_not_channel_confirmation' : healthy ? 'sheet_unsold_not_booking_confirmation' : 'stale',
      pricing: { current_price:p?.channels[query.channel] ?? null, base_price:p?.rack_price ?? null,
        suggested_price:null,guest_pay_price:null,currency:'TWD',channel:query.channel,
        policy:!p ? 'price_missing' : stalePrice ? 'stale_snapshot' : 'observed_snapshot',eligible:false,exclusion:null,
        baseline_version:p?.baseline_version ?? '',price_version:prices?.version ?? '',plan_version:'',
        limits:`${p?.daytype ?? ''}；${stock ? checkedToday ? '含今日通路庫存觀測' : '通路庫存上次觀測早於今日' : '尚無通路庫存觀測'}；未含客人促銷、加人與住宿限制`,
        observed_at:observed,source:'bnb-pricing / OwlNest readback',suggestion_source:'none' },
    });
    counts[state]++;
  }
  const priceTimes = prices?.cells.map(c => c.observed_at ?? prices.observed_at).filter(t => Number.isFinite(Date.parse(t))) ?? [];
  const latestPrice = priceTimes.sort((a,b) => Date.parse(b)-Date.parse(a))[0] ?? null;
  return {pricing_observed_at:latestPrice,status:'read_only',mode:authority ? 'iron_gate_pricing_snapshot' : 'live_sheet_pricing_snapshot',snapshot_id:`${authority ? `iron_gate:${authority.authorityEpoch}:${authority.inventoryVersion}` : sheet!.source.snapshot_version}:${prices?.version ?? 'missing'}:${inventory?.version ?? 'missing'}`,asof:today,query,property_id:property,rooms,cells,counts,price_hidden:false,continuous_windows:[],
    ...(authority ? {inventory_source:{kind:'iron_gate' as const,inventory_version:authority.inventoryVersion,authority_epoch:authority.authorityEpoch,observed_at:authority.observedAt}} : {}),
    source_notice: authority ? `占房、暫留與關房以目前訂單紀錄為準；未售只表示目前未占房。待核與未完成的房況同步仍會保留保護。若今日 OwlNest 顯示零庫存或鎖房，將標成待確認；接單前仍須確認通路庫存與住宿限制。${prices ? '價格為 OwlNest 通路系統價，客人促銷後實付可能不同。' : '價格來源尚未發布，請勿據此報價。'}` : prices ? `已售以訂房表為準；表內無單只表示尚未登記。若今日 OwlNest 顯示零庫存或鎖房，將標成待確認。可按「更新 OwlNest 價格」讀取未來三個月價格；各日期的抓取時間見明細。此為 OwlNest 通路系統價，客人促銷後實付可能不同。` : '訂房表持續同步；價格來源尚未發布，請勿據此報價。'};
}
