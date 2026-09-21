import test from 'node:test';
import assert from 'node:assert/strict';
import {roomQuoteLibrary} from '../src/lib/room-quote-library.ts';
const now=new Date('2026-09-21T01:00:00Z');
const b=()=>({source:{sync:{status:'healthy',last_checked_at:now.toISOString()}},bookings:[]});
const p=()=>({observed_at:now.toISOString(),cells:[{date:'2026-11-20',room:'101',channels:{direct:4800,booking:6000},stock:{count:1,is_lock:false}}]});
test('stable version, direct prices only; price and occupancy changes change version',()=>{
 const first=roomQuoteLibrary(b(),p(),now);assert.equal(first.preview_only,true);assert.equal(first.cells[0].price,4800);
 assert.deepEqual(Object.keys(first.cells[0]).sort(),['date','price','room','state']);
 assert.equal(roomQuoteLibrary(b(),p(),new Date(+now+1000)).version,first.version);
 const price=p();price.cells[0].channels.direct=4900;assert.notEqual(roomQuoteLibrary(b(),price,now).version,first.version);
 const booking=b();booking.bookings.push({room_number:'101',check_in:'2026-11-20',check_out:'2026-11-21',guest_name:'must-not-leak'});
 const next=roomQuoteLibrary(booking,p(),now);assert.equal(next.cells[0].state,'sold');assert.equal(next.cells[0].price,null);assert.notEqual(next.version,first.version);assert.ok(!JSON.stringify(next).includes('must-not-leak'));
});
test('stale inventory, old price, conflicts and blocked stock never become unsold',()=>{
 const booking=b();booking.source.sync.status='failed';assert.equal(roomQuoteLibrary(booking,p(),now).cells[0].state,'unknown');
 const price=p();price.observed_at='2026-09-01T00:00:00Z';assert.equal(roomQuoteLibrary(b(),price,now).cells[0].state,'unknown');
 const lock=p();lock.cells[0].stock.is_lock=true;assert.equal(roomQuoteLibrary(b(),lock,now).cells[0].state,'blocked');
 const conflict=b();conflict.bookings.push({room_number:'101',check_in:'2026-11-20',check_out:'2026-11-21',source_conflict:true});assert.equal(roomQuoteLibrary(conflict,p(),now).cells[0].state,'unknown');
});
