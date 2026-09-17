import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseQuoteQuery,quoteAuthorized,buildRoomQuote} from '../src/lib/room-quote.ts';
const now=new Date('2026-09-17T15:00:00Z');
const params=()=>new URLSearchParams({property:'sweetfun',start:'2026-11-20',end:'2026-11-21',channel:'direct'});
const bookings=()=>({source:{sync:{status:'healthy',last_checked_at:now.toISOString()},snapshot_version:'test-only'},bookings:[]});
const prices=()=>({observed_at:now.toISOString(),version:'a'.repeat(20),cells:['101','102','201','202','301','302'].map(room=>({date:'2026-11-20',room,channels:{direct:2300,booking:3000},stock:{count:1,is_lock:false}}))});
test('query validates calendar dates, property, explicit channel and bounded stays',()=>{
 assert.equal(parseQuoteQuery(params(),now).rooms.length,6);
 for(const [key,value]of [['property','offland'],['channel',''],['start','2026-02-30'],['start','2026-09-16'],['end','2026-12-20'],['rooms','999'],['room_type','anything']]){
  const p=params();p.set(key,value);assert.throws(()=>parseQuoteQuery(p,now));
 }
 const p=params();p.set('room_type','quad');assert.deepEqual(parseQuoteQuery(p,now).rooms,['101','202']);
 p.set('rooms','301');assert.throws(()=>parseQuoteQuery(p,now));
});
test('credential fails closed and is verified without exposing secrets',()=>{
 const token='synthetic-test-token-not-production-123456';const digest=createHash('sha256').update(token).digest('hex');
 assert.equal(quoteAuthorized('Bearer '+token,digest),true);
 for(const h of [null,'','Bearer wrong','Basic '+token,'Bearer '+token+'x'])assert.equal(quoteAuthorized(h,digest),false);
 assert.equal(quoteAuthorized('Bearer '+token,''),false);
});
test('quoted values bind room/night/channel; sold, locked and unknown are separate',()=>{
 const b=bookings();b.bookings.push({room_number:'302',check_in:'2026-11-20',check_out:'2026-11-22',reservation_status:'confirmed'});
 const p=prices();p.cells[0].stock.is_lock=true;p.cells[1].stock.count=0;p.cells[2].stock=null;
 const result=buildRoomQuote(parseQuoteQuery(params(),now),b,p,now);
 assert.equal(result.options.find(o=>o.room==='302').status,'unavailable');
 assert.equal(result.options[0].nights[0].state,'blocked');
 assert.equal(result.options[1].status,'unknown');assert.equal(result.options[2].status,'unknown');
 assert.equal(result.options[3].total,2300);assert.equal(result.conditions_verified,false);
 assert.equal(result.options[0].total,null);
});
test('checkout is exclusive; canceled rows do not block; conflicts cannot be offered',()=>{
 const b=bookings();b.bookings.push({room_number:'101',check_in:'2026-11-19',check_out:'2026-11-20'},
 {room_number:'102',check_in:'2026-11-20',check_out:'2026-11-21',reservation_status:'cancelled'},
 {room_number:'201',check_in:'2026-11-20',check_out:'2026-11-21',source_conflict:true});
 const r=buildRoomQuote(parseQuoteQuery(params(),now),b,prices(),now);
 assert.equal(r.options[0].status,'quoted');assert.equal(r.options[1].status,'quoted');assert.equal(r.options[2].status,'unknown');
});
test('old/missing prices and stale Sheet fail closed; a fresh request cannot renew old source data',()=>{
 const p=prices();p.observed_at='2026-09-16T15:00:00Z';
 assert.ok(buildRoomQuote(parseQuoteQuery(params(),now),bookings(),p,now).options.every(o=>o.status==='unknown'));
 const b=bookings();b.source.sync.last_checked_at='2026-09-17T14:54:00Z';assert.throws(()=>buildRoomQuote(parseQuoteQuery(params(),now),b,prices(),now));
 const fresh=prices();fresh.cells[0].observed_at='2026-09-17T14:59:30Z';
 assert.equal(buildRoomQuote(parseQuoteQuery(params(),now),bookings(),fresh,now).expires_at,'2026-09-17T15:00:30.000Z');
});
test('multi-night quote requires every night; no first-night-only total',()=>{
 const q=parseQuoteQuery(params(),now);q.end='2026-11-22';
 assert.ok(buildRoomQuote(q,bookings(),prices(),now).options.every(o=>o.total===null));
 const p=prices();p.cells.push(...p.cells.map(c=>({...c,date:'2026-11-21',channels:{direct:3400}})));
 assert.ok(buildRoomQuote(q,bookings(),p,now).options.every(o=>o.total===5700));
});
