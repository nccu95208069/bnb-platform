import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement, act} from 'react';
import {mount} from './helpers/customer-dom.mjs';
const booking={id:'synthetic-plan',order_id:'synthetic-plan',property_id:'offland',property_name:'OFFLAND',room_id:'offland-villa',room_number:'包棟',guest_name:'Synthetic Guest',guest_name_kind:'real',platform:'booking',check_in:'2026-11-04',check_out:'2026-11-05',booked_at:'2026-10-20',room_rate:6600,payment_status:'unknown',reservation_status:'confirmed',notes:null,payments:[],audit_log:[],extra_guest_count:0,extra_bed_count:0,pet_count:0,baby_supplies:[],service_note:null,source_read_only:true,source_guest_count:1,booking_plan:'four',booking_project_name:'4人小包棟(不含早餐) | 睡好飽專案'};
const rooms=[{id:'offland-villa',property_id:'offland',room_number:'包棟',label:'包棟'}];
const noop=()=>{};
test('details show original project, plan and separately labelled occupants',async t=>{
 const {root} = await mount(t,()=>null);
 const {BookingDetailsPanel} = await import("../src/components/calendar/booking-editor.tsx");
 await act(()=>root.render(createElement(BookingDetailsPanel,{booking,orderSegments:[booking],visualNights:[],rooms,permissions:{viewPrices:true,recordPayment:false,editBooking:false,cancelBooking:false},onSelectVisualNight:noop,onClose:noop,onRecordPayment:noop,onUpdateBooking:noop,onCancelBooking:noop})));
 const text=document.body.textContent;
 assert.match(text,/包棟方案/);assert.match(text,/四人包棟/);assert.match(text,/專案名稱/);assert.ok(text.includes(booking.booking_project_name));
 assert.match(text,/入住人數/);assert.match(text,/1 人/);
});
