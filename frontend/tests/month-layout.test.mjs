import test from 'node:test';
import assert from 'node:assert/strict';
import { fitMonthWeekLanes, layoutMonthWeek, monthBookingFontSize, monthBookingTwoLine, monthWeekHeightForSpacing, normalizeMonthWeekSpacing, unsoldMonthRoomLimits } from '../src/components/calendar/month-layout.ts';
const days = ['2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-13','2026-11-14','2026-11-15'];
const stay = (id, room, start, end) => ({id, property_name:'Test', room_number:room, check_in:start, check_out:end});
test('tall week cells use all available booking rows instead of stopping at two', () => {
 assert.equal(fitMonthWeekLanes(144, 6), 6);
 assert.equal(fitMonthWeekLanes(164, 7), 7);
 assert.equal(fitMonthWeekLanes(140, 8), 5);
});
test('reserve the more-bookings row only when something is actually hidden', () => {
 assert.equal(fitMonthWeekLanes(124, 5), 5);
 assert.equal(fitMonthWeekLanes(123, 5), 4);
 assert.equal(fitMonthWeekLanes(124, 6), 4);
 assert.equal(fitMonthWeekLanes(124, 0), 0);
});
test('each supported week height shows the maximum number of rows that fits', () => {
 for (let height = 60; height <= 240; height++) {
  for (let lanes = 1; lanes <= 15; lanes++) {
   const shown = fitMonthWeekLanes(height, lanes);
   const used = 24 + shown * 20 + (shown < lanes ? 16 : 0);
   assert.ok(used <= height, `${height}px: ${shown}/${lanes} rows must fit`);
   if (shown < lanes) {
    const next = 24 + (shown + 1) * 20 + (shown + 1 < lanes ? 16 : 0);
    assert.ok(next > height, `${height}px: another booking row should not fit`);
   }
  }
 }
});
test('larger calendar text reserves taller rows instead of clipping bookings', () => {
 assert.equal(fitMonthWeekLanes(124, 6, 1), 4);
 assert.equal(fitMonthWeekLanes(124, 6, 1.3), 2);
 assert.equal(fitMonthWeekLanes(161.2, 6, 1.3), 4);
});
test('booking labels have distinct pixel sizes at the minimum and maximum display settings', () => {
 assert.equal(monthBookingFontSize(0.85), 8.5);
 assert.equal(monthBookingFontSize(1.3), 13);
 assert.equal(monthBookingFontSize(1.3, true), 14.3);
});
test('mobile booking labels switch to two lines at 115% while desktop stays compact', () => {
 assert.equal(monthBookingTwoLine(1.1), false);
 assert.equal(monthBookingTwoLine(1.15), true);
 assert.equal(monthBookingTwoLine(1.3), true);
 assert.equal(monthBookingTwoLine(1.3, true), false);
});
test('two-line week capacity reserves space for a second text row and overflow', () => {
 const scale = 1.3;
 const weekHeight = 110 * scale;
 assert.equal(fitMonthWeekLanes(weekHeight, 2, scale, true), 2);
 assert.equal(fitMonthWeekLanes(weekHeight, 5, scale, true), 2);
 for (let lanes = 1; lanes <= 12; lanes++) {
  const shown = fitMonthWeekLanes(weekHeight, lanes, scale, true);
  const used = (24 + shown * 34 + (shown < lanes ? 16 : 0)) * scale;
  assert.ok(used <= weekHeight, `${shown}/${lanes} two-line rows must fit`);
 }
});
test('week-spacing slider reveals additional bookings and its final stop removes overflow', () => {
 for (const twoLine of [false, true]) {
  const scale = twoLine ? 1.3 : 1;
  const laneCount = 12;
  const baseHeight = 110 * scale;
  const visible = Array.from({length: 7}, (_, spacing) => {
   const height = monthWeekHeightForSpacing(baseHeight, laneCount, scale, twoLine, spacing);
   return fitMonthWeekLanes(height, laneCount, scale, twoLine);
  });
  for (let step = 1; step < 6; step++) {
   assert.equal(visible[step], visible[0] + step, `step ${step} should reveal one more booking row`);
  }
  assert.equal(visible[6], laneCount, 'the final setting must show every booking');
 }
});
test('stored week spacing is bounded before it affects layout', () => {
 assert.equal(normalizeMonthWeekSpacing(undefined), 0);
 assert.equal(normalizeMonthWeekSpacing('6'), 0);
 assert.equal(normalizeMonthWeekSpacing(-8), 0);
 assert.equal(normalizeMonthWeekSpacing(100), 6);
});
test('the same spacing control reveals unsold room cards on mobile and desktop', () => {
 assert.deepEqual(unsoldMonthRoomLimits(0), {mobile:2,desktop:3});
 assert.deepEqual(unsoldMonthRoomLimits(2), {mobile:4,desktop:5});
 assert.deepEqual(unsoldMonthRoomLimits(6), {mobile:Infinity,desktop:Infinity});
});
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
