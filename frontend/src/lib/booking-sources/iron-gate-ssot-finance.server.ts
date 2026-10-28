import type {Principal} from '../workspace-auth/types';
import {ironGateCalendarConfig} from './iron-gate-calendar.server.ts';
import {callIronGate,type Grant,type ManualConfig} from './iron-gate-manual.server.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const sequence=(value:unknown):value is number=>
  typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const object=(value:unknown):value is Record<string,unknown>=>
  !!value&&typeof value==='object'&&!Array.isArray(value);
const canonical=(value:unknown):string=>Array.isArray(value)?
  `[${value.map(canonical).join(',')}]`:object(value)?
    `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:
    (JSON.stringify(value)??'null');

/** The OS writer is separate from the existing calendar and payment grants. */
export function ironGateSsotFinanceConfig(env:NodeJS.ProcessEnv=process.env):ManualConfig{
  try{
    if(env.OS_SWEETFUN_FINANCE_SSOT_ENABLED!=='true'||
      env.CALENDAR_SOURCE!=='sheet_snapshot')throw Error();
    const calendar=ironGateCalendarConfig(env);
    if(calendar.expectedAuthorityEpoch<1)throw Error();
    const grant=JSON.parse(env.IRON_GATE_SWEETFUN_SSOT_FINANCE_GRANT??'null');
    if(!object(grant)||Object.keys(grant).sort().join(',')!==
      'clientId,credentialId,propertyId,token,workspaceId'||
      !UUID.test(String(grant.credentialId))||!UUID.test(String(grant.clientId))||
      !TOKEN.test(String(grant.token))||
      grant.propertyId!==calendar.grant.propertyId||
      grant.workspaceId!==calendar.grant.workspaceId)throw Error();
    return {calendar,grant:grant as Grant};
  }catch{throw Error('FINANCE_SSOT_UNAVAILABLE');}
}

export type SsotEvent={
  id:string;document_id:string;revision_version:number;current_version:number;
  change_seq:number;
  document_status:'active'|'void';event_kind:string;amount_cents:number;
  cash_effect_cents:number;effective_on:string;cash_on:string|null;
  category_code:string|null;receipt_purpose:string|null;payment_method_code:string|null;
  payment_account_ref:string|null;advanced_by_ref:string|null;
  advanced_by_kind:'self'|'account'|'other'|null;advanced_by_label:string|null;
  safe_description:string|null;actor_ref:string;created_at:string;
  evidence_level:string;evidence_ref:string|null;reverses_event_id:string|null;
  related_receipt_event_id:string|null;
  source_system:string;source_record_id:string;source_instance_id:string;
  revision_action:string;source_version:string;current_reason_note:string|null;
  booking_allocations:{booking_id:string;amount_cents:number;allocation_kind:string}[];
  expense_attributions:{month:string;amount_cents:number;allocation_policy:string}[];
};

function path(config:ManualConfig,suffix:string){
  return `/v1/properties/${config.grant.propertyId}/finance/${suffix}`;
}
async function request(config:ManualConfig,actor:Principal,method:'GET'|'POST',
  suffix:string,body:unknown,key:string|null,actions:string[],send:typeof fetch){
  return callIronGate(config,actor,method,path(config,suffix),body,key,send,
    actions,['money'],2_100_000);
}
export async function readSsotLedger(config:ManualConfig,actor:Principal,
  send:typeof fetch=fetch):Promise<SsotEvent[]>{
  const events:SsotEvent[]=[];let cursor:string|null=null,pin:number|null=null;
  const seen=new Set<string>(),cursors=new Set<string>();
  for(let page=0;page<200;page++){
    const suffix=`ledger?limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`+
      `${pin!==null?`&as_of_change_seq=${pin}`:''}`;
    const result=await request(config,actor,'GET',suffix,null,null,['finance:read'],send);
    const asOf=result.as_of_change_seq,current=result.current_change_seq;
    if(!Array.isArray(result.events)||result.events.length>100||
      !sequence(asOf)||!sequence(current)||current<asOf||
      !sequence(result.unsequenced_event_count)||
      result.unsequenced_event_count!==0||
      (pin!==null&&asOf!==pin)||
      result.events.some(event=>!object(event)||!UUID.test(String(event.id))||
        !UUID.test(String(event.document_id))||seen.has(String(event.id))||
        !sequence(event.change_seq)||event.change_seq<1||event.change_seq>asOf))
      throw Error('FINANCE_SSOT_READBACK_MISMATCH');
    pin??=asOf;
    for(const event of result.events){seen.add(String(event.id));events.push(event as SsotEvent);}
    if(result.next_cursor===null)return events;
    if(typeof result.next_cursor!=='string'||!result.next_cursor||
      result.events.length===0||cursors.has(result.next_cursor))
      throw Error('FINANCE_SSOT_READBACK_MISMATCH');
    cursors.add(result.next_cursor);
    cursor=result.next_cursor;
  }
  throw Error('FINANCE_SSOT_READBACK_MISMATCH');
}
export async function readSsotCatalog(config:ManualConfig,actor:Principal,
  send:typeof fetch=fetch){
  const [accounts,categories,recurring,payout,links]=await Promise.all([
    request(config,actor,'GET','accounts',null,null,['finance:read'],send),
    request(config,actor,'GET','categories',null,null,['finance:read'],send),
    request(config,actor,'GET','recurring-rules',null,null,['finance:read'],send),
    request(config,actor,'GET','payout-rules',null,null,['finance:read'],send),
    request(config,actor,'GET','source-links',null,null,['finance:read'],send)]);
  if(!Array.isArray(accounts.accounts)||!Array.isArray(categories.categories)||
    !Array.isArray(recurring.recurring_rules)||!Array.isArray(payout.payout_rules)||
    !Array.isArray(links.source_links))
    throw Error('FINANCE_SSOT_READBACK_MISMATCH');
  return {accounts:accounts.accounts,categories:categories.categories,
    recurring:recurring.recurring_rules,payout:payout.payout_rules,
    links:links.source_links};
}

export type SsotActivity={id:string;at:string;source:'money'|'operation';
  action:string;ui_action:string;actor_ref:string;target_id:string;version:number|null;
  source_system:string|null;event_kind:string|null;amount_cents:number|null;
  safe_description:string|null;reason_note:string|null;
  before_amount_cents:number|null;before_safe_description:string|null;
  request_key:string|null;response:Record<string,unknown>|null};
export async function readSsotActivity(config:ManualConfig,actor:Principal,page:number,
  action='',query='',
  send:typeof fetch=fetch):Promise<{activities:SsotActivity[];total:number;page_size:number}>{
  if(!Number.isSafeInteger(page)||page<1||page>10000)throw Error('INVALID_INPUT');
  const result=await request(config,actor,'GET',
    `activity?page=${page}&action=${encodeURIComponent(action)}&q=${encodeURIComponent(query)}`,null,null,
    ['finance:read'],send);
  if(!Array.isArray(result.activities)||result.activities.length>30||
    typeof result.total!=='number'||!Number.isSafeInteger(result.total)||
    result.total<0||result.page_size!==30)
    throw Error('FINANCE_SSOT_READBACK_MISMATCH');
  return {activities:result.activities as SsotActivity[],
    total:result.total,page_size:30};
}

function commandAction(command:Record<string,unknown>){
  if(command.action==='amend'||command.action==='void')return 'finance:correct';
  if(command.event_kind==='property_refund')return 'finance:refund';
  if(command.event_kind==='expense_paid'||command.event_kind==='processor_fee_paid')
    return 'finance:record_expense';
  return 'finance:record_receipt';
}
function accepted(value:Record<string,unknown>,key:string){
  if(value.receipt_status!=='accepted'||value.request_key!==key)
    throw Error('FINANCE_SSOT_READBACK_MISMATCH');
  return value;
}
async function recover(config:ManualConfig,actor:Principal,key:string,send:typeof fetch){
  try{return accepted(await request(config,actor,'GET',
    `receipts/${encodeURIComponent(key)}`,null,null,['finance:read'],send),key);}
  catch{throw Error('WRITE_UNCONFIRMED');}
}

/** Check a prior OS attempt before rebuilding a command from a newer projection. */
export async function readSsotReceipt(config:ManualConfig,actor:Principal,key:string,
  send:typeof fetch=fetch):Promise<Record<string,unknown>|null>{
  if(!UUID.test(key))throw Error('INVALID_INPUT');
  try{
    return accepted(await request(config,actor,'GET',
      `receipts/${encodeURIComponent(key)}`,null,null,['finance:read'],send),key);
  }catch(error){
    if(error instanceof Error&&error.message==='REQUEST_NOT_FOUND')return null;
    throw error;
  }
}

/** A repeated request first reaches the authoritative idempotency check. */
export async function submitSsotFinanceCommand(config:ManualConfig,actor:Principal,
  command:Record<string,unknown>,key:string,send:typeof fetch=fetch,
  options:{repreviewOnConflict?:boolean}={}){
  if(command.request_key!==key||!UUID.test(key))throw Error('INVALID_INPUT');
  const action=commandAction(command);
  let response:Record<string,unknown>;
  try{
    response=await request(config,actor,'POST','commands',command,key,[action],send);
  }catch(error){
    const code=error instanceof Error?error.message:'';
    if(code==='MANUAL_RESULT_UNKNOWN')return recover(config,actor,key,send);
    if(code!=='VERSION_CONFLICT'||options.repreviewOnConflict===false||
      !(Array.isArray(command.booking_allocations)&&command.booking_allocations.length||
        Array.isArray(command.booking_guards)&&command.booking_guards.length))throw error;
    const preview=await request(config,actor,'POST','commands/preview',command,key,
      ['finance:read'],send);
    if(!object(preview.resolved_command)||typeof preview.preview_token!=='string')
      throw Error('FINANCE_SSOT_READBACK_MISMATCH');
    try{response=await request(config,actor,'POST','commands',
      {...preview.resolved_command,preview_token:preview.preview_token},key,[action],send);}
    catch(writeError){
      if(writeError instanceof Error&&writeError.message==='MANUAL_RESULT_UNKNOWN')
        return recover(config,actor,key,send);
      throw writeError;
    }
  }
  const receipt=await recover(config,actor,key,send);
  if(canonical(receipt)!==canonical(accepted(response,key)))
    throw Error('FINANCE_SSOT_READBACK_MISMATCH');
  return receipt;
}

export async function previewSsotFinanceCommand(config:ManualConfig,actor:Principal,
  command:Record<string,unknown>,key:string,send:typeof fetch=fetch){
  if(command.request_key!==key||!UUID.test(key))throw Error('INVALID_INPUT');
  const result=await request(config,actor,'POST','commands/preview',command,key,
    ['finance:read'],send);
  if(!object(result.resolved_command)||
    result.preview_token!==null&&typeof result.preview_token!=='string'||
    typeof result.source_instance_id!=='string'||
    typeof result.source_system!=='string')
    throw Error('FINANCE_SSOT_READBACK_MISMATCH');
  return {command:{...result.resolved_command,
      ...(result.preview_token?{preview_token:result.preview_token}:{})},
    bookings:result.bookings,source_instance_id:result.source_instance_id,
    source_system:result.source_system,source_sheet_ref:result.source_sheet_ref};
}

export async function submitSsotPlan(config:ManualConfig,actor:Principal,
  suffix:'accounts'|'categories'|'recurring-rules'|'payout-rules',
  command:Record<string,unknown>,key:string,send:typeof fetch=fetch){
  if(command.request_key!==key||!UUID.test(key))throw Error('INVALID_INPUT');
  let response:Record<string,unknown>;
  try{response=await request(config,actor,'POST',suffix,command,key,['finance:plan'],send);}
  catch(error){
    if(error instanceof Error&&error.message==='MANUAL_RESULT_UNKNOWN')
      return recover(config,actor,key,send);
    throw error;
  }
  const receipt=await recover(config,actor,key,send);
  if(canonical(receipt)!==canonical(accepted(response,key)))
    throw Error('FINANCE_SSOT_READBACK_MISMATCH');
  return receipt;
}
