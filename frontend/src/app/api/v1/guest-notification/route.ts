import {NextRequest,NextResponse} from 'next/server';
import {principalFor} from '@/lib/workspace-auth/session';
import {allowedProperty} from '@/lib/workspace-auth/projection';
import {privateHeaders,sameOrigin,inputBody} from '@/lib/workspace-auth/http';
import {activeSources} from '@/lib/booking-sources/config';
import {readBookingSnapshot} from '@/lib/booking-sources/snapshot';
import {ironGateCalendarConfig,readSweetfunIronGateNotificationOrder} from '@/lib/booking-sources/iron-gate-calendar.server';
import {RedisWorkspaceStore} from '@/lib/workspace-auth/store';
import {canNotify,notificationOrderId,notificationStates,setNotification} from '@/lib/guest-notification';
const reply=(data:unknown,status=200)=>NextResponse.json(data,{status,headers:privateHeaders});
function failure(error:unknown){const code=error instanceof Error?error.message:'';return reply({code:['UNAUTHORIZED','FORBIDDEN','NOT_FOUND','INVALID_INPUT','VERSION_CONFLICT','RATE_LIMITED'].includes(code)?code:'UNAVAILABLE'},({UNAUTHORIZED:401,FORBIDDEN:403,NOT_FOUND:404,INVALID_INPUT:400,VERSION_CONFLICT:409,RATE_LIMITED:429} as Record<string,number>)[code]??503);}
async function context(request:NextRequest,property:unknown,write=false){
 const actor=await principalFor(request);if(!actor)throw Error('UNAUTHORIZED');
 if(typeof property!=='string'||!allowedProperty(actor,property)||(write&&!canNotify(actor)))throw Error('FORBIDDEN');
 const source=activeSources().find(s=>s.property.id===property);if(!source)throw Error('FORBIDDEN');
 return {actor,source};
}
export async function GET(request:NextRequest){try{const {actor,source}=await context(request,request.nextUrl.searchParams.get('property'));return reply({states:await notificationStates(source.property.id),can_write:canNotify(actor)});}catch(e){return failure(e);}}
export async function POST(request:NextRequest){try{
 sameOrigin(request);const input=await inputBody(request),{actor,source}=await context(request,input.property_id,true);
 if(typeof input.order_id!=='string'||!notificationOrderId(input.order_id)||typeof input.notified!=='boolean'||!Number.isSafeInteger(input.expected_version)||input.expected_version<0||typeof input.request_id!=='string'||! /^[a-f0-9-]{36}$/.test(input.request_id))throw Error('INVALID_INPUT');
 await new RedisWorkspaceStore().limit(`guest-notification:${actor.id}`,120,3600);
 const ironGate=source.property.id==='sweetfun'&&process.env.IRON_GATE_SWEETFUN_CALENDAR_ENABLED==='true';
 if(ironGate){
  if(typeof input.ig_booking_id!=='string'||!input.ig_booking_id.startsWith('IG-')||
    !notificationOrderId(input.ig_booking_id))throw Error('INVALID_INPUT');
  try{
   const expected=await readSweetfunIronGateNotificationOrder(input.ig_booking_id.slice(3),actor,ironGateCalendarConfig());
   if(input.order_id!==expected)throw Error('NOT_FOUND');
  }catch(error){if(error instanceof Error&&error.message==='IRON_GATE_NOTIFICATION_SOURCE_INVALID')throw Error('NOT_FOUND');throw error;}
 }else{
  if(input.order_id.startsWith('IG-'))throw Error('NOT_FOUND');
  const snapshot=await readBookingSnapshot(source);
  if(!snapshot?.bookings.some(b=>b.order_id===input.order_id&&b.property_id===source.property.id&&b.reservation_status!=='cancelled'))throw Error('NOT_FOUND');
 }
 return reply({state:await setNotification(source.property.id,input.order_id,input.notified,input.expected_version,input.request_id,actor)});
 }catch(e){return failure(e);}}
