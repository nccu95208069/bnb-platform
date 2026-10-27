import type {ManualConfig} from './booking-sources/iron-gate-manual.server';

const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Read-only service credential for the five-minute scanner. */
export async function readFinanceSheetLedger(config:ManualConfig,token:string,
  send:typeof fetch=fetch):Promise<unknown[]>{
  if(!TOKEN.test(token)||!UUID.test(config.grant.propertyId))
    throw Error('SHEET_SCAN_CONFIG_INVALID');
  const origin=new URL(config.calendar.baseUrl);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||
    origin.hash||origin.pathname!=='/')throw Error('SHEET_SCAN_CONFIG_INVALID');
  const result:unknown[]=[];
  const ids=new Set<string>();
  let cursor:string|null=null;
  for(let page=0;page<200;page++){
    const url=new URL(`/v1/properties/${config.grant.propertyId}/finance/ledger`,origin);
    url.searchParams.set('limit','100');
    if(cursor)url.searchParams.set('cursor',cursor);
    let response:Response;
    try{response=await send(url.toString(),{method:'GET',headers:{
      authorization:`Bearer ${token}`},redirect:'error',cache:'no-store',
      signal:AbortSignal.timeout(8_000)});}
    catch{throw Error('SHEET_LEDGER_UNAVAILABLE');}
    if(!response.ok)throw Error('SHEET_LEDGER_UNAVAILABLE');
    const body=await response.json() as Record<string,unknown>;
    if(!Array.isArray(body.events)||body.events.length>100)
      throw Error('SHEET_LEDGER_INVALID');
    for(const raw of body.events){
      if(!raw||typeof raw!=='object'||typeof raw.id!=='string'||
        !UUID.test(raw.id)||ids.has(raw.id))throw Error('SHEET_LEDGER_INVALID');
      ids.add(raw.id);result.push(raw);
    }
    if(body.next_cursor===null)return result;
    if(typeof body.next_cursor!=='string'||!body.next_cursor||
      body.events.length===0||body.next_cursor===cursor)
      throw Error('SHEET_LEDGER_INVALID');
    cursor=body.next_cursor;
  }
  throw Error('SHEET_LEDGER_TOO_LARGE');
}
