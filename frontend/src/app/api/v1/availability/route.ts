import { gunzipSync } from 'node:zlib';
import { NextRequest, NextResponse } from 'next/server';
import { principalFor } from '@/lib/workspace-auth/session';
import { allowedProperty } from '@/lib/workspace-auth/projection';
import { redisCommand } from '@/lib/workspace-auth/store';
import { readBookingSnapshot } from '@/lib/booking-sources/snapshot';
import { SWEETFUN_SOURCE, activeSources } from '@/lib/booking-sources/config';
import { PRICING_KEY, PRICING_ROOMS, PRICING_CHANNELS, validatePricingSnapshot } from '@/lib/pricing-snapshot';
import { liveAvailability } from '@/lib/live-availability';
import type { Channel } from '@/lib/availability';
const headers = {'Cache-Control':'private, no-store',Vary:'Cookie'};
export async function GET(request: NextRequest) {
  const reply = (data: unknown, status = 200) => NextResponse.json(data, {status,headers});
  try {
    const principal = await principalFor(request);
    if (!principal) return reply({detail:'請先登入並完成密碼設定。'},401);
    if (!principal.viewPrices) return reply({detail:'此帳號無法查看未售房價。'},403);
    const params = request.nextUrl.searchParams;
    const property = params.get('property') ?? 'sweetfun';
    if (!allowedProperty(principal,property)) return reply({detail:'你沒有此旅宿的權限。'},403);
    if (property !== 'sweetfun') return reply({detail:'此旅宿尚未接入定價來源。'},422);
    const start=params.get('start') ?? '', end=params.get('end') ?? '', channel=(params.get('channel') ?? 'direct') as Channel;
    const rooms=(params.get('rooms') ?? '').split(',').filter(Boolean);
    const validDay=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
    if (!validDay(start)||!validDay(end)||start>=end||(Date.parse(end)-Date.parse(start))/86400000>93||!PRICING_CHANNELS.includes(channel)||rooms.some(r=>!PRICING_ROOMS.includes(r))||new Set(rooms).size!==rooms.length) return reply({detail:'請選擇有效日期、房間與通路（最多93天）。'},400);
    const [bookings,raw]=await Promise.all([readBookingSnapshot(SWEETFUN_SOURCE),redisCommand(['GET',PRICING_KEY])]);
    if (!bookings) return reply({detail:'訂房來源暫時無法讀取。'},503);
    const prices=raw ? validatePricingSnapshot(JSON.parse(gunzipSync(Buffer.from(String(raw).slice(4),"base64"),{maxOutputLength:4*1024*1024}).toString("utf8"))) : null;
    const result = liveAvailability({start,end,channel,rooms,demo_cycle:1},bookings,prices);
    result.properties = activeSources().filter(s => allowedProperty(principal,s.property.id)).map(s => ({id:s.property.id,name:s.property.name,short_name:s.property.name,location:s.property.id === "sweetfun" ? "瑞芳" : "宜蘭五結",room_count:s.property.rooms.length,color:s.property.id === "sweetfun" ? "emerald" : "violet"}));
    return reply(result);
  } catch { return reply({detail:'房況或價格來源暫時無法讀取，請稍後重試。'},503); }
}
