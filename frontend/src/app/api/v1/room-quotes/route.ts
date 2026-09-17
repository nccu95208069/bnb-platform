import { gunzipSync } from 'node:zlib';
import { NextRequest, NextResponse } from 'next/server';
import { redisCommand } from '@/lib/workspace-auth/store';
import { readBookingSnapshot } from '@/lib/booking-sources/snapshot';
import { SWEETFUN_SOURCE } from '@/lib/booking-sources/config';
import { PRICING_KEY, validatePricingSnapshot } from '@/lib/pricing-snapshot';
import { readOwlNest, refreshedSnapshot } from '@/lib/owlnest-refresh';
import { buildRoomQuote, parseQuoteQuery, quoteAuthorized } from '@/lib/room-quote';

export const runtime='nodejs';
export const maxDuration=40;
const headers={'Cache-Control':'private, no-store',Vary:'Authorization'};
export async function GET(request:NextRequest){
  const reply=(body:unknown,status=200)=>NextResponse.json(body,{status,headers});
  // Independent read-only integration credential: no browser session or Redis access leaves OS.
  if(!quoteAuthorized(request.headers.get('authorization')))return reply({code:'QUOTE_UNAUTHORIZED'},401);
  try{
    const query=parseQuoteQuery(request.nextUrl.searchParams);
    const raw=await redisCommand(['GET',PRICING_KEY]);
    if(typeof raw!=='string'||!raw.startsWith('gz1:'))throw Error('QUOTE_PRICE_UNAVAILABLE');
    const prior=validatePricingSnapshot(JSON.parse(gunzipSync(Buffer.from(raw.slice(4),'base64'),{maxOutputLength:4*1024*1024}).toString('utf8')));
    // Only the requested nights are read from OwlNest. Never publishes or changes rates/inventory.
    const live=await readOwlNest(query.start,query.end);
    const now=new Date();
    const prices=refreshedSnapshot(live,prior,query.start,query.end,now.toISOString());
    // Read bookings AFTER the external read so a reservation arriving meanwhile wins.
    const bookings=await readBookingSnapshot(SWEETFUN_SOURCE);
    if(!bookings)throw Error('QUOTE_INVENTORY_STALE');
    return reply(buildRoomQuote(query,bookings,prices,new Date()));
  }catch(error){
    const code=error instanceof Error?error.message:'';
    const allowed=['QUOTE_PROPERTY_DENIED','QUOTE_QUERY_INVALID','QUOTE_PRICE_UNAVAILABLE','QUOTE_INVENTORY_STALE','OWLNEST_AUTH_EXPIRED','OWLNEST_NOT_CONFIGURED'];
    return reply({code:allowed.includes(code)?code:'QUOTE_SOURCE_UNAVAILABLE'},code==='QUOTE_PROPERTY_DENIED'?403:code==='QUOTE_QUERY_INVALID'?400:503);
  }
}
