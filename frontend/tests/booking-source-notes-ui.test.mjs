import test from 'node:test';
import assert from 'node:assert/strict';
import {BookingSourceNotes} from '../src/components/calendar/booking-source-notes.tsx';
import {coalesceContiguousBookings} from '../src/components/calendar/calendar-utils.ts';
import {mount} from './helpers/customer-dom.mjs';

const note=(text,room='101',date='2026-10-06',out='2026-10-07')=>({text,room_number:room,check_in:date,check_out:out});
const booking={id:'a',property_id:'sweetfun',property_name:'Synthetic',order_id:'order-1',room_id:'room-101',room_number:'101',platform:'direct',reservation_status:'confirmed',check_in:'2026-10-06',check_out:'2026-10-07',source_read_only:true,room_rate:2000,source_notes:[],source_notes_unconfirmed:false};
const props=(value,segments=[])=>({booking:value,orderSegments:segments,viewPrices:true});

test('full main Sheet text preserves newlines and long content as plain text',async t=>{
 const text='晚到請保留房間\n不用加床\n<script>test()</script>\n'+'完整備註'.repeat(300);
 await mount(t,BookingSourceNotes,props({...booking,source_notes:[note(text)]}));
 const section=document.querySelector('section[aria-label="主表備註"]');assert.ok(section);
 const paragraph=[...section.querySelectorAll('p')].find(p=>p.textContent===text);
 assert.ok(paragraph);assert.ok(paragraph.classList.contains('whitespace-pre-wrap'));
 assert.equal(section.querySelector('script'),null);assert.match(section.textContent,/101 · 2026-10-06–2026-10-07/);
});
test('coalesced nights and other rooms retain all distinct notes while repeated text appears once',async t=>{
 const segments=coalesceContiguousBookings([
  {...booking,source_notes:[note('晚到')]},
  {...booking,id:'b',check_in:'2026-10-07',check_out:'2026-10-08',source_notes:[note('晚到','101','2026-10-07','2026-10-08')]},
  {...booking,id:'c',room_id:'room-102',room_number:'102',source_notes:[note('要收據','102')]},
 ]);
 assert.equal(segments.length,2);assert.equal(segments[0].source_notes.length,2);
 await mount(t,BookingSourceNotes,props(segments[0],[...segments,{...booking,property_id:'offland',source_notes:[note('other property')]},{...booking,order_id:'other-order',source_notes:[note('other order')]}]));
 const content=document.body.textContent;
 assert.equal(content.split('晚到').length-1,1);assert.match(content,/要收據/);assert.match(content,/2026-10-07–2026-10-08/);assert.match(content,/102/);
 assert.doesNotMatch(content,/other property|other order|待主表同步確認/);
});
test('verified blank notes have an explicit empty state',async t=>{
 await mount(t,BookingSourceNotes,props(booking));assert.match(document.body.textContent,/主表未填寫備註/);assert.doesNotMatch(document.body.textContent,/待主表同步確認/);
});
test('partial source mismatch retains matched notes with a sync message instead of claiming no notes',async t=>{
 const segments=coalesceContiguousBookings([{...booking,source_notes:[note('已核對備註')]},{...booking,id:'b',check_in:'2026-10-07',check_out:'2026-10-08',source_notes:[],source_notes_unconfirmed:true}]);
 await mount(t,BookingSourceNotes,props(segments[0],segments));
 assert.match(document.body.textContent,/已核對備註/);assert.match(document.body.textContent,/部分備註待主表同步確認/);assert.doesNotMatch(document.body.textContent,/主表未填寫備註/);
});
test('hidden-price viewers cannot render raw main Sheet notes',async t=>{
 await mount(t,BookingSourceNotes,{...props({...booking,source_notes:[note('收款 12345')]}),viewPrices:false});
 assert.equal(document.querySelector('section'),null);assert.doesNotMatch(document.body.textContent,/12345/);
});
