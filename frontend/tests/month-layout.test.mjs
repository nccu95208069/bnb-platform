import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutMonthWeek } from '../src/components/calendar/month-layout.ts';
const days = ['2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-13','2026-11-14','2026-11-15'];
const stay = (id, room, start, end) => ({id, property_name:'Test', room_number:room, check_in:start, check_out:end});
test('two-night stay is one segment across Saturday/Sunday', () => {
 const [s] = layoutMonthWeek([stay('a','villa',days[5],'2026-11-16')],days,'2026-11-16');
 assert.deepEqual([s.start,s.end,s.lane,s.continuesBefore,s.continuesAfter],[5,7,0,false,false]);
});
test('competing arrivals never shift a continuing stay between lanes', () => {
 const result=layoutMonthWeek([stay('long','301',days[0],days[6]),stay('early','101',days[0],days[2]),stay('late','102',days[4],days[6])],days,'2026-11-16');
 assert.equal(result.filter(s=>s.booking.id==='long').length,1);
 for(let d=0;d<7;d++) {
  const active=result.filter(s=>s.start<=d&&s.end>d);
  assert.equal(new Set(active.map(s=>s.lane)).size,active.length);
 }
});
test('week boundaries clip nights and mark continuation; checkout is exclusive', () => {
 const result=layoutMonthWeek([stay('past','101','2026-11-07',days[0]),stay('across','302','2026-11-08','2026-11-18')],days,'2026-11-16');
 assert.equal(result.length,1);
 assert.deepEqual([result[0].start,result[0].end,result[0].continuesBefore,result[0].continuesAfter],[0,7,true,true]);
});
