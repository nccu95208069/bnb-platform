import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {BookingIdentity} from '../src/components/calendar/booking-identity.tsx';
import {MonthScroller} from '../src/components/calendar/calendar-views.tsx';
import {mount} from './helpers/customer-dom.mjs';
const booking={id:'synthetic-plan',order_id:'synthetic-plan',property_id:'offland',property_name:'OFFLAND',room_id:'offland-villa',room_number:'包棟',guest_name:'Synthetic Guest',guest_name_kind:'real',platform:'booking',check_in:'2026-11-04',check_out:'2026-11-05',booked_at:'2026-10-20',room_rate:6600,payment_status:'unknown',reservation_status:'confirmed',notes:null,payments:[],audit_log:[],extra_guest_count:0,extra_bed_count:0,pet_count:0,baby_supplies:[],service_note:null,source_read_only:true,source_guest_count:1,booking_plan:'four',booking_project_name:'4人小包棟(不含早餐) | 睡好飽專案'};
const rooms=[{id:'offland-villa',property_id:'offland',room_number:'包棟',label:'包棟'}];
const noop=()=>{};
test('identity cards show plan independently of guest count and unknown remains unknown',()=>{
 for(const [plan,label] of [['four','四人包棟'],['six','六人包棟'],[undefined,'方案待確認']]) {
  assert.match(renderToStaticMarkup(createElement(BookingIdentity,{booking:{...booking,booking_plan:plan}})),new RegExp(label));
 }
 assert.doesNotMatch(renderToStaticMarkup(createElement(BookingIdentity,{booking:{...booking,property_id:'sweetfun'}})),/四人包棟/);
});
test('month card has visible plan and accessible plan identity',async t=>{
 await mount(t,MonthScroller,{months:['2026-11-01'],coveredMonths:['2026-11-01'],targetMonth:'2026-11-01',bookings:[booking],rooms,properties:[],onVisibleMonthChange:noop,onSelectBooking:noop,onSelectDay:noop});
 const card=document.querySelector('[data-stay-id="synthetic-plan"]');
 assert.ok(card);assert.match(card.textContent,/四人包棟/);assert.match(card.getAttribute('aria-label'),/四人包棟/);
});
