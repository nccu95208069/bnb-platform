import {callIronGate,type ManualConfig} from './iron-gate-manual.server.ts';
import {sweetfunCalendarPlatform} from './sweetfun-platform.ts';
import {projectionVersion} from '../finance-projection.ts';
import type {FinanceOrder} from '../finance-model';
import type {Principal} from '../workspace-auth/types';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=(v:unknown):v is Record<string,unknown>=>
  !!v&&typeof v==='object'&&!Array.isArray(v);
const fail=():never=>{throw Error('FINANCE_SSOT_BOOKING_READ_MISMATCH');};
const integer=(v:unknown,min=0):number=>
  typeof v==='number'&&Number.isSafeInteger(v)&&v>=min?v:fail();
function day(v:unknown):string{
  if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||
    !Number.isFinite(Date.parse(`${v}T00:00:00Z`))||
    new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)!==v)fail();
  return v as string;
}

/** Current bookings provide identities and versions; Sheet aliases never choose a booking. */
export function ssotBookingOrder(value:unknown,config:ManualConfig):FinanceOrder{
  if(!object(value))return fail();
  const row=value;
  if(!UUID.test(String(row.id))||row.workspaceId!==config.grant.workspaceId||
    row.propertyId!==config.grant.propertyId||
    !['held','confirmed','cancelled'].includes(String(row.status))||
    !['os','line','website','external'].includes(String(row.source))||
    typeof row.sourceReviewRequired!=='boolean'||row.currency!=='TWD'||
    typeof row.createdAt!=='string'||!/(?:Z|[+-]\d{2}:\d{2})$/.test(row.createdAt)||
    !Number.isFinite(Date.parse(row.createdAt))||
    !Array.isArray(row.stays)||!row.stays.length||row.stays.length>4096)fail();
  const version=integer(row.version,1);
  const roomNames=new Map(Object.entries(config.calendar.roomIds).map(([name,id])=>[id,name]));
  const cells=new Set<string>(),rooms=new Set<string>();
  const stays=(row.stays as unknown[]).map(value=>{
    if(!object(value)||!Array.isArray(value.roomIds)||!value.roomIds.length)return fail();
    const checkIn=day(value.checkIn),checkOut=day(value.checkOut);
    const nights=(Date.parse(checkOut)-Date.parse(checkIn))/86_400_000;
    if(nights<1||nights>366)return fail();
    for(const id of value.roomIds){
      if(typeof id!=='string'||!roomNames.has(id))fail();
      rooms.add(roomNames.get(String(id))!);
      for(let n=0;n<nights;n++){
        const cell=`${id}:${Date.parse(checkIn)+n*86_400_000}`;
        if(cells.has(cell)||cells.size>=20000)fail();
        cells.add(cell);
      }
    }
    return {checkIn,checkOut};
  });
  const amountUnknown=row.totalCents===null;
  const total=amountUnknown?0:integer(row.totalCents);
  const summary=object(row.paymentSummary)?row.paymentSummary:fail();
  const received=integer(summary.receivedCents),refunded=integer(summary.refundedCents);
  if(refunded>received||integer(summary.netReceivedCents)!==received-refunded)fail();
  if(row.sourceCalendar!=null&&!object(row.sourceCalendar))fail();
  const calendar=object(row.sourceCalendar)?row.sourceCalendar:null;
  const platform=row.source==='external'?sweetfunCalendarPlatform(calendar?.platform):'direct';
  const paymentReview=object(row.paymentReview)?row.paymentReview:null;
  // Zero canonical receipts cannot prove an imported legacy book had no money.
  // Keep historical/native payment coverage in review until separately reconciled.
  const review=amountUnknown||row.sourceReviewRequired||row.source==='external'||
    !!calendar?.sourceOrderRef||received!==0||refunded!==0||
    paymentReview?.source==='sheet_flag'||row.cardManaged===true||
    object(row.cardChargeResult)&&row.cardChargeResult.status==='done';
  const status=row.status as FinanceOrder['status'];
  return {id:`IG-${row.id}`,calendar_id:`IG-${row.id}`,booking_id:String(row.id),
    source:'iron_gate',status,ssot_booking_version:version,
    ssot_command_eligible:!review&&status==='confirmed',
    ssot_payment_coverage:review?'historical_review_required':'verified_current',
    ...(amountUnknown?{amount_review_required:true}:{}),
    ...(review?{receivable_review_required:true}:{}),
    platform,rooms:[...rooms].sort(),
    check_in:stays.map(s=>s.checkIn).sort()[0],
    check_out:stays.map(s=>s.checkOut).sort().at(-1)!,total,
    received:0,receivable:!review&&status==='confirmed'?total:0,
    credit:0,eligible_date:null,source_paid:false,
    source_version:projectionVersion([row.id,version,row.status,total,row.source,
      row.sourceReviewRequired,calendar,summary,paymentReview,stays])};
}

/** Full, bounded two-pass read. Booking versions can move without inventoryVersion. */
export async function readSsotBookings(config:ManualConfig,actor:Principal,
  send:typeof fetch=fetch){
  if(config.calendar.mode!=='authority'||config.calendar.expectedAuthorityEpoch<1||
    config.grant.propertyId!==config.calendar.grant.propertyId||
    config.grant.workspaceId!==config.calendar.grant.workspaceId)fail();
  const readConfig={...config,grant:config.calendar.grant};
  const prefix=`/v1/properties/${config.grant.propertyId}/bookings?limit=100`;
  async function scan(){
    const orders:FinanceOrder[]=[],ids=new Set<string>(),cursors=new Set<string>();
    let cursor:string|null=null,version:number|null=null;
    for(let page=0;page<200;page++){
      const raw=await callIronGate(readConfig,actor,'GET',prefix+
        (cursor?`&cursor=${encodeURIComponent(cursor)}`:''),null,null,send,
      ['booking:read'],['money','guest_name','payment_status'],2_100_000);
      if(raw.propertyId!==config.grant.propertyId||
        raw.authorityEpoch!==config.calendar.expectedAuthorityEpoch||
        raw.readOnly!==false||raw.snapshot!==null||
        !Array.isArray(raw.bookings)||raw.bookings.length>100)fail();
      const current=integer(raw.inventoryVersion);
      if(version!==null&&current!==version)fail();
      version=current;
      const rows=raw.bookings as unknown[];
      for(const value of rows){
        const order=ssotBookingOrder(value,config);
        if(ids.has(order.id))fail();
        ids.add(order.id);orders.push(order);
      }
      if(raw.nextCursor===null)return {orders,inventoryVersion:version};
      if(typeof raw.nextCursor!=='string'||!/^[A-Za-z0-9_-]{1,512}$/.test(raw.nextCursor)||
        !rows.length||cursors.has(raw.nextCursor))fail();
      cursor=String(raw.nextCursor);cursors.add(cursor);
    }
    return fail();
  }
  const before=await scan(),after=await scan();
  const revision=projectionVersion(before);
  if(revision!==projectionVersion(after))fail();
  return {...after,revision};
}
