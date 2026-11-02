import test from 'node:test';
import assert from 'node:assert/strict';
import { fitMonthWeekLanes, layoutMonthWeek, manualMonthWeekMinHeight, monthBookingFontSize, monthBookingTwoLine, monthWeekHeightForDensity, monthWeekPresentation, normalizeMonthWeekDensity, restoredMonthWeekDensity, unsoldMonthRoomLimits } from '../src/components/calendar/month-layout.ts';
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
test('manual slider runs from a one-to-two-week spacious view to a compact view', () => {
 for (const twoLine of [false, true]) {
  const scale = twoLine ? 1.3 : 1;
  const laneCount = 12;
  const baseHeight = 110 * scale;
  const heights = Array.from({length: 7}, (_, density) => monthWeekHeightForDensity({
   baseWeekHeight:baseHeight, viewportHeight:520, laneCount, fontScale:scale, twoLine, automatic:false, density,
  }));
  assert.ok(heights[0] >= 520 * 0.62, 'the loosest week should fill most of the viewport');
  assert.equal(fitMonthWeekLanes(heights[0], laneCount, scale, twoLine), laneCount);
  for (let step = 1; step < heights.length; step++) {
   assert.ok(heights[step] <= heights[step-1], `moving right to step ${step} must not grow the week`);
  }
  assert.ok(heights[6] < heights[0]);
  assert.ok(fitMonthWeekLanes(heights[6], laneCount, scale, twoLine) < laneCount);
 }
});
test('automatic week height retains the prior viewport-based layout', () => {
 const height = monthWeekHeightForDensity({baseWeekHeight:140, viewportHeight:520, laneCount:12, fontScale:1, twoLine:false, automatic:true, density:0});
 assert.equal(height,140);
});
test('spacious weeks wrap booking details without hiding previously visible bookings', () => {
 const base = {baseWeekHeight:110, viewportHeight:520, fontScale:1, desktop:true, automatic:false};
 const roomy = monthWeekPresentation({...base,laneCount:12,density:0});
 assert.equal(roomy.twoLine,true);
 assert.equal(roomy.visibleLanes,12);
 assert.ok(roomy.height >= 520 * 0.62);
 const uncrowded = monthWeekPresentation({...base,laneCount:2,density:1});
 assert.equal(uncrowded.twoLine,true);
 assert.equal(uncrowded.visibleLanes,2);
 const crowded = monthWeekPresentation({...base,laneCount:12,density:1});
 assert.equal(crowded.twoLine,false);
 assert.equal(crowded.visibleLanes,fitMonthWeekLanes(crowded.height,12));
 const compact = monthWeekPresentation({...base,laneCount:12,density:6});
 assert.equal(compact.twoLine,false);
});
test('automatic wrapping keeps the existing large-text mobile behavior', () => {
 const base = {baseWeekHeight:110,viewportHeight:520,laneCount:6,automatic:true,density:0};
 assert.equal(monthWeekPresentation({...base,fontScale:1,desktop:true}).twoLine,false);
 assert.equal(monthWeekPresentation({...base,fontScale:1.3,desktop:false}).twoLine,true);
});
test('roomy mobile weeks show two-line cards without hiding bookings', () => {
 const base = {viewportHeight:900,fontScale:1,desktop:false,automatic:true,density:3};
 const roomy = monthWeekPresentation({...base,baseWeekHeight:180,laneCount:1});
 assert.deepEqual(roomy,{height:180,visibleLanes:1,twoLine:true});
 const dense = monthWeekPresentation({...base,baseWeekHeight:60,laneCount:6});
 assert.equal(dense.height,60);
 assert.equal(dense.visibleLanes,1);
 assert.equal(dense.twoLine,false);
 const desktop = monthWeekPresentation({...base,baseWeekHeight:180,laneCount:1,desktop:true});
 assert.equal(desktop.twoLine,false);
});
test('stored density is bounded and previous spacing preferences migrate', () => {
 assert.equal(normalizeMonthWeekDensity(undefined),3);
 assert.equal(normalizeMonthWeekDensity('6'),3);
 assert.equal(normalizeMonthWeekDensity(-8),0);
 assert.equal(normalizeMonthWeekDensity(100),6);
 assert.deepEqual(restoredMonthWeekDensity(undefined),{automatic:true,density:3});
 assert.deepEqual(restoredMonthWeekDensity({monthWeekSpacing:0}),{automatic:true,density:3});
 assert.deepEqual(restoredMonthWeekDensity({monthWeekSpacing:6}),{automatic:false,density:0});
 assert.deepEqual(restoredMonthWeekDensity({monthWeekSpacing:1}),{automatic:false,density:5});
 assert.deepEqual(restoredMonthWeekDensity({monthWeekAuto:true,monthWeekDensity:6}),{automatic:true,density:6});
});
test('manual density changes unsold room capacity and minimum week height', () => {
 assert.deepEqual(unsoldMonthRoomLimits(true,0), {mobile:2,desktop:3});
 assert.deepEqual(unsoldMonthRoomLimits(false,0), {mobile:Infinity,desktop:Infinity});
 assert.deepEqual(unsoldMonthRoomLimits(false,3), {mobile:4,desktop:5});
 assert.deepEqual(unsoldMonthRoomLimits(false,6), {mobile:1,desktop:2});
 assert.equal(manualMonthWeekMinHeight(520,0),323);
 assert.equal(manualMonthWeekMinHeight(520,6),84);
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
