/** Read-only quote contract. Unknown inventory/conditions are never sold-out facts. */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { BookingSourceSnapshot } from './booking-sources/sweetfun-sheet';
import type { PricingSnapshot } from './pricing-snapshot.ts';
import { PRICING_ROOMS, PRICING_CHANNELS } from './pricing-snapshot.ts';
import type { Channel } from './availability';

const DAY = 86_400_000;
export const QUOTE_TTL_MS = 60_000;
export type QuoteQuery = {start:string;end:string;rooms:string[];channel:Channel;room_type:'quad'|null};
export function parseQuoteQuery(params:URLSearchParams, now=new Date()):QuoteQuery {
  const start=params.get('start')??'', end=params.get('end')??'';
  const valid=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const channel=params.get('channel') as Channel;
  const rooms=(params.get('rooms')??'').split(',').filter(Boolean);
  const roomType=params.get('room_type');
  if(params.get('property')!=='sweetfun')throw Error('QUOTE_PROPERTY_DENIED');
  if(!valid(start)||!valid(end)||start<today||end<=start||(Date.parse(end)-Date.parse(start))/DAY>14||
     (Date.parse(start)-Date.parse(today))/DAY>365||!PRICING_CHANNELS.includes(channel)||
     rooms.some(r=>!PRICING_ROOMS.includes(r))||new Set(rooms).size!==rooms.length||
     (roomType!==null&&roomType!=='quad')||(rooms.length>0&&roomType!==null))throw Error('QUOTE_QUERY_INVALID');
  return {start,end,rooms:rooms.length?rooms:roomType==='quad'?['101','202']:PRICING_ROOMS,channel,room_type:roomType};
}
export function quoteAuthorized(header:string|null, configured=process.env.DAILI_QUOTE_TOKEN_SHA256):boolean {
  if(!configured||!/^[a-f0-9]{64}$/.test(configured)||!header?.startsWith('Bearer '))return false;
  const token=header.slice(7);
  if(token.length<32||token.length>256)return false;
  return timingSafeEqual(createHash('sha256').update(token).digest(),Buffer.from(configured,'hex'));
}
export function buildRoomQuote(query:QuoteQuery,bookings:BookingSourceSnapshot,prices:PricingSnapshot,now=new Date()) {
  const checked=bookings.source.sync?.last_checked_at;
  const healthy=bookings.source.sync?.status==='healthy'&&!!checked&&Number.isFinite(Date.parse(checked))&&
    now.getTime()-Date.parse(checked)>=-30_000&&now.getTime()-Date.parse(checked)<=5*60_000;
  if(!healthy)throw Error('QUOTE_INVENTORY_STALE');
  const map=new Map(prices.cells.map(c=>[`${c.date}|${c.room}`,c]));
  let expiresAt=now.getTime()+QUOTE_TTL_MS;
  const options=query.rooms.map(room=>{
    const nights=[];
    for(let d=Date.parse(query.start);d<Date.parse(query.end);d+=DAY){
      const date=new Date(d).toISOString().slice(0,10);
      const cell=map.get(`${date}|${room}`);
      const observed=cell?.observed_at??prices.observed_at;
      const age=now.getTime()-Date.parse(observed);
      const occupied=bookings.bookings.filter(b=>b.room_number===room&&b.reservation_status!=='cancelled'&&b.check_in<=date&&b.check_out>date);
      let state:'unsold'|'sold'|'blocked'|'unknown'='unknown';
      if(occupied.some(b=>b.source_conflict)||occupied.length>1)state='unknown';
      else if(occupied.length)state='sold';
      else if(cell&&Number.isFinite(age)&&age>=-30_000&&age<QUOTE_TTL_MS&&cell.stock){
        if(cell.stock.is_lock)state='blocked';
        else if(cell.stock.count!==null&&cell.stock.count>0)state='unsold';
      }
      const price=cell?.channels[query.channel];
      const usablePrice=Number.isSafeInteger(price)&&Number(price)>0&&Number.isFinite(age)&&age>=-30_000&&age<QUOTE_TTL_MS;
      if(state==='unsold'&&!usablePrice)state='unknown';
      if(state==='unsold')expiresAt=Math.min(expiresAt,Date.parse(observed)+QUOTE_TTL_MS);
      nights.push({date,state,price:state==='unsold'?price:null,price_observed_at:observed});
    }
    const status=nights.some(n=>n.state==='sold'||n.state==='blocked')?'unavailable':nights.some(n=>n.state==='unknown')?'unknown':'quoted';
    return {room,room_name:room==='101'?'河景四人房':room==='202'?'四人房':`${room}房`,status,
      nights,total:status==='quoted'?nights.reduce((sum,n)=>sum+Number(n.price),0):null};
  });
  return {schema:1,property_id:'sweetfun',channel:query.channel,start:query.start,end:query.end,
    checked_at:now.toISOString(),expires_at:new Date(expiresAt).toISOString(),price_version:prices.version,
    inventory_version:bookings.source.snapshot_version,options,
    availability_basis:'sheet_and_owlnest_observation',conditions_verified:false,
    operator_note:'未售房價；未含加人、促銷與住宿限制，接單前仍須確認。'};
}
