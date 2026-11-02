import test from 'node:test';
import assert from 'node:assert/strict';
import {coalesceContiguousBookings} from '../src/components/calendar/calendar-utils.ts';
const row=(name,start,end)=>({id:start,property_id:'test',order_id:'same-order',room_id:'test-102',platform:'ctrip',reservation_status:'confirmed',guest_name:name,guest_name_kind:'real',check_in:start,check_out:end,room_rate:100,payments:[],audit_log:[]});
test('IG annotation on either night preserves name and all source remarks',()=>{
 for(const names of [['Sample Guest(IG)','Sample Guest'],['Sample Guest','Sample Guest(IG)']]){
 const [stay]=coalesceContiguousBookings([row(names[0],'2026-12-09','2026-12-10'),row(names[1],'2026-12-10','2026-12-11')]);
 assert.equal(stay.guest_name_kind,'real');assert.equal(stay.room_rate,200);assert.equal(stay.guest_remarks[0].label,'IG聯繫');assert.deepEqual(stay.guest_name_sources,names);
 }
 const [different]=coalesceContiguousBookings([row('Sample A','2026-12-09','2026-12-10'),row('Sample B','2026-12-10','2026-12-11')]);
 assert.equal(different.guest_name_kind,'missing');assert.equal(different.guest_name_sources.length,2);
});
