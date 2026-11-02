import type {ManualConfig} from './booking-sources/iron-gate-manual.server';

const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sequence=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const SHEET=/^[A-Za-z0-9_-]{10,128}$/;
type Identity={sourceInstanceId:string;spreadsheetId:string};

export type FinanceSheetLedgerSnapshot={events:Record<string,unknown>[];
  asOfChangeSeq:number;currentChangeSeq:number;unsequencedEventCount:number};

function ledgerUrl(config:ManualConfig,token:string){
  if(!TOKEN.test(token)||!UUID.test(config.grant.propertyId))
    throw Error('SHEET_SCAN_CONFIG_INVALID');
  const origin=new URL(config.calendar.baseUrl);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||
    origin.hash||origin.pathname!=='/')throw Error('SHEET_SCAN_CONFIG_INVALID');
  return new URL(`/v1/properties/${config.grant.propertyId}/finance/ledger`,origin);
}

async function page(config:ManualConfig,token:string,identity:Identity,
  limit:number,cursor:string|null,pin:number|null,send:typeof fetch){
  if(!UUID.test(identity.sourceInstanceId)||!SHEET.test(identity.spreadsheetId))
    throw Error('SHEET_SCAN_CONFIG_INVALID');
  const url=ledgerUrl(config,token);
  url.searchParams.set('limit',String(limit));
  if(cursor)url.searchParams.set('cursor',cursor);
  if(pin!==null)url.searchParams.set('as_of_change_seq',String(pin));
  let response:Response;
  try{response=await send(url.toString(),{method:'GET',headers:{
    authorization:`Bearer ${token}`},redirect:'error',cache:'no-store',
    signal:AbortSignal.timeout(8_000)});}
  catch{throw Error('SHEET_LEDGER_UNAVAILABLE');}
  if(!response.ok)throw Error('SHEET_LEDGER_UNAVAILABLE');
  let body:Record<string,unknown>;
  try{body=await response.json() as Record<string,unknown>;}
  catch{throw Error('SHEET_LEDGER_INVALID');}
  if(!body||typeof body!=='object'||!Array.isArray(body.events)||
    body.source_instance_id!==identity.sourceInstanceId||
    body.source_system!=='sheet_bulk'||
    body.source_sheet_ref!==identity.spreadsheetId||
    body.events.length>limit||!sequence(body.as_of_change_seq)||
    !sequence(body.current_change_seq)||
    Number(body.current_change_seq)<Number(body.as_of_change_seq)||
    !sequence(body.unsequenced_event_count)||
    (pin!==null&&body.as_of_change_seq!==pin))throw Error('SHEET_LEDGER_INVALID');
  if(Number(body.unsequenced_event_count)>0)throw Error('SHEET_LEDGER_UNSEQUENCED');
  return body as {events:Record<string,unknown>[];next_cursor:unknown;
    as_of_change_seq:number;current_change_seq:number;unsequenced_event_count:number};
}

/** Read a property-local ledger snapshot across pages at one immutable change sequence. */
export async function readFinanceSheetLedger(config:ManualConfig,token:string,
  identity:Identity,send:typeof fetch=fetch):Promise<FinanceSheetLedgerSnapshot>{
  const events:Record<string,unknown>[]=[];
  const ids=new Set<string>();
  let cursor:string|null=null,pin:number|null=null,current=0;
  for(let index=0;index<200;index++){
    const body=await page(config,token,identity,100,cursor,pin,send);
    pin??=body.as_of_change_seq;
    current=Math.max(current,body.current_change_seq);
    for(const raw of body.events){
      if(!raw||typeof raw!=='object'||Array.isArray(raw)||
        typeof raw.id!=='string'||!UUID.test(raw.id)||ids.has(raw.id)||
        !sequence(raw.change_seq)||Number(raw.change_seq)<1||
        Number(raw.change_seq)>pin)throw Error('SHEET_LEDGER_INVALID');
      ids.add(raw.id);events.push(raw);
    }
    if(body.next_cursor===null)return {events,asOfChangeSeq:pin,
      currentChangeSeq:current,unsequencedEventCount:0};
    if(typeof body.next_cursor!=='string'||!body.next_cursor||
      body.events.length===0||body.next_cursor===cursor)
      throw Error('SHEET_LEDGER_INVALID');
    cursor=body.next_cursor;
  }
  throw Error('SHEET_LEDGER_TOO_LARGE');
}

/** An unpinned head detects changes made after a pinned full scan. */
export async function readFinanceSheetLedgerHead(config:ManualConfig,token:string,
  identity:Identity,send:typeof fetch=fetch):Promise<number>{
  const body=await page(config,token,identity,1,null,null,send);
  return body.as_of_change_seq;
}
