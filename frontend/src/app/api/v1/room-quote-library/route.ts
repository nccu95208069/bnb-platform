import { gunzipSync } from 'node:zlib';
import { NextRequest, NextResponse } from 'next/server';
import { quoteAuthorized } from '@/lib/room-quote';
import { roomQuoteLibrary } from '@/lib/room-quote-library';
import { redisCommand } from '@/lib/workspace-auth/store';
import { PRICING_KEY, validatePricingSnapshot } from '@/lib/pricing-snapshot';
import { readBookingSnapshot } from '@/lib/booking-sources/snapshot';
import { SWEETFUN_SOURCE } from '@/lib/booking-sources/config';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store',Vary:'Authorization'};
export async function GET(request:NextRequest) {
  if(!quoteAuthorized(request.headers.get('authorization'))) return NextResponse.json({code:'QUOTE_UNAUTHORIZED'},{status:401,headers});
  try {
    const [raw,bookings]=await Promise.all([redisCommand(['GET',PRICING_KEY]),readBookingSnapshot(SWEETFUN_SOURCE)]);
    if(typeof raw!=='string'||!raw.startsWith('gz1:')||!bookings) throw Error('unavailable');
    const prices=validatePricingSnapshot(JSON.parse(gunzipSync(Buffer.from(raw.slice(4),'base64'),{maxOutputLength:4*1024*1024}).toString('utf8')));
    const result=roomQuoteLibrary(bookings,prices);
    if(request.nextUrl.searchParams.get('version')===result.version) return NextResponse.json({...result,cells:[],unchanged:true},{headers});
    return NextResponse.json({...result,unchanged:false},{headers});
  } catch {return NextResponse.json({code:'QUOTE_LIBRARY_UNAVAILABLE'},{status:503,headers});}
}
