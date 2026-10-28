import {createHash} from 'node:crypto';
import type {Principal,Member} from './workspace-auth/types';
import {applyFinance} from './finance-store';
import {validateFinanceLinks} from './finance-projection';
import type {FinanceEntry,FinanceOrder} from './finance-model';
import {EXPENSE_CATEGORIES,INCOME_CATEGORIES,taipeiDate} from './finance-model';
import type {ssotFinanceContext} from './finance-ssot-context';
import {ironGateSsotFinanceConfig,submitSsotFinanceCommand,
  submitSsotPlan,readSsotCatalog,readSsotReceipt} from './booking-sources/iron-gate-ssot-finance.server.ts';

type Report=Awaited<ReturnType<typeof ssotFinanceContext>>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=(v:unknown):v is Record<string,unknown>=>
  !!v&&typeof v==='object'&&!Array.isArray(v);
const hashUuid=(value:string)=>{
  const hex=createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
};
const sourceId=(requestId:string)=>`os-${requestId}`;

const canonical=(value:unknown):string=>Array.isArray(value)?
  `[${value.map(canonical).join(',')}]`:object(value)?
    `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:
    (JSON.stringify(value)??'null');

export function osFinanceOriginHash(input:Record<string,unknown>,actorId:string,
  property:string):string{
  return createHash('sha256').update(canonical({actorId,property,input})).digest('hex');
}

/** An accepted receipt takes priority over a now-stale OS projection. */
export async function resumeSsotFinance(input:Record<string,unknown>,actor:Principal,
  property:string,read:typeof readSsotReceipt=readSsotReceipt,
  config:ReturnType<typeof ironGateSsotFinanceConfig>=ironGateSsotFinanceConfig()){
  const key=input.request_id;
  if(typeof key!=='string'||!UUID.test(key))throw Error('INVALID_INPUT');
  const originHash=osFinanceOriginHash(input,actor.id,property);
  const receipt=await read(config,actor,key);
  if(!receipt)return {originHash,result:null};
  if(receipt.origin_request_hash!==originHash)throw Error('IDEMPOTENCY_CONFLICT');
  const entryId=receipt.document_id??receipt.account_code??receipt.rule_id??
    receipt.platform;
  if(typeof entryId!=='string'||!entryId)throw Error('FINANCE_SSOT_READBACK_MISMATCH');
  return {originHash,result:{verified:true,entry_id:entryId,version:0,receipt}};
}

function expenseAttributions(entry:FinanceEntry){
  return (entry.expense_spread??[{month:entry.date.slice(0,7),
    amount_cents:entry.amount_cents}]).filter(row=>row.amount_cents>0).map(row=>({
      month:`${row.month}-01`,amount_cents:row.amount_cents,
      allocation_policy:'os_source_exact'}));
}
function allocations(input:Record<string,unknown>,orders:FinanceOrder[]){
  if(!Array.isArray(input.allocations))return [];
  return input.allocations.map(raw=>{
    if(!object(raw)||typeof raw.order_id!=='string'||
      !Number.isSafeInteger(raw.amount_cents))throw Error('INVALID_INPUT');
    const order=orders.find(o=>o.id===raw.order_id);
    if(!order||order.source==='iron_gate'||!UUID.test(order.booking_id??'')||
      !Number.isSafeInteger(order.ssot_booking_version)||
      !/^[0-9a-f]{64}$/.test(order.ssot_source_snapshot_hash??''))
      throw Error('SOURCE_MAPPING_REVIEW_REQUIRED');
    return {booking_id:order.booking_id!,
      expected_booking_version:order.ssot_booking_version!,
      source_order_key:order.id,
      source_snapshot_hash:order.ssot_source_snapshot_hash!,
      amount_cents:raw.amount_cents,
      allocation_kind:input.stage==='deposit'?'deposit':'room'};
  });
}

export function bookingGuardsForVoid(entry:FinanceEntry,orders:FinanceOrder[]){
  return (entry.allocations??[]).map(allocation=>{
    const order=orders.find(candidate=>candidate.id===allocation.order_id);
    if(!order||!UUID.test(order.booking_id??'')||
      !Number.isSafeInteger(order.ssot_booking_version))
      throw Error('SOURCE_MAPPING_REVIEW_REQUIRED');
    return {booking_id:order.booking_id!,
      expected_booking_version:order.ssot_booking_version!};
  });
}

async function ensureCategory(report:Report,actor:Principal,requestId:string,
  kind:'income'|'expense',code:string,label:string){
  const found=report.ssot_catalog.categories.find(value=>
    object(value)&&value.kind===kind&&value.code===code&&value.status==='active');
  if(found)return;
  const key=hashUuid(`finance-category:${requestId}:${kind}:${code}`);
  const config=ironGateSsotFinanceConfig();
  const command={request_key:key,kind,code,label};
  try{await submitSsotPlan(config,actor,'categories',command,key);}
  catch(error){
    if(!(error instanceof Error)||error.message!=='CATEGORY_EXISTS')throw error;
  }
  const after=await readSsotCatalog(config,actor);
  if(!after.categories.some(value=>object(value)&&value.kind===kind&&
    value.code===code&&value.status==='active'&&value.label===label))
    throw Error('WRITE_UNCONFIRMED');
}

function expenseAdvance(entry:FinanceEntry){
  const advance=entry.advanced_by;
  if(!advance)return null;
  const ref=advance.type==='other'?`other:${createHash('sha256')
    .update(advance.name).digest('hex')}`:advance.account_id;
  if(!ref)throw Error('INVALID_INPUT');
  return {advanced_by_ref:ref,advanced_by_kind:advance.type,
    advanced_by_label:advance.name};
}

function moneyCommand(entry:FinanceEntry,input:Record<string,unknown>,
  report:Report,requestId:string,originHash:string,action:'create'|'amend'){
  const expense=entry.kind==='expense';
  if(entry.method==='ota')throw Error('SOURCE_MAPPING_REVIEW_REQUIRED');
  const eventKind=expense?'expense_paid':'property_receipt';
  const receiptPurpose=expense?null:entry.category==='lodging'?
    entry.stage==='deposit'?'deposit':'room':'other';
  const sourceRecord=action==='create'&&entry.recurrence_id&&entry.occurrence?
    `os-recurring:${entry.recurrence_id}:${entry.occurrence}`:
    action==='create'?sourceId(requestId):entry.ssot_source_record_id;
  const version=action==='create'?1:(entry.ssot_document_version??0)+1;
  if(!sourceRecord||version<1)throw Error('VERSION_CONFLICT');
  const command:Record<string,unknown>={request_key:requestId,
    origin_request_hash:originHash,
    source_record_id:sourceRecord,source_version:String(version),action,
    ...(action==='amend'?{expected_version:version-1}:{}),
    event_kind:eventKind,amount_cents:entry.amount_cents,currency:'TWD',
    effective_on:entry.date,cash_on:entry.date,service_on:entry.date,
    category_code:entry.category,
    ...(receiptPurpose?{receipt_purpose:receiptPurpose}:{}),
    payment_method_code:entry.method,
    ...(entry.payment_account?{payment_account_ref:entry.payment_account.id}:{}),
    ...(expenseAdvance(entry)??{}),
    safe_description:entry.description,evidence_level:'operator_attested',
    evidence_ref:`os:${requestId}`,
    booking_allocations:expense?[]:allocations(input,report.orders),
    expense_attributions:expense?expenseAttributions(entry):[]};
  return command;
}

function dueDate(start:string,day:number){
  const first=start.slice(0,7),candidate=`${first}-${String(Math.min(day,
    new Date(Date.UTC(Number(first.slice(0,4)),Number(first.slice(5)),0))
      .getUTCDate())).padStart(2,'0')}`;
  if(candidate>=start)return candidate;
  const next=new Date(`${first}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth()+1);
  const month=next.toISOString().slice(0,7);
  return `${month}-${String(Math.min(day,new Date(Date.UTC(next.getUTCFullYear(),
    next.getUTCMonth()+1,0)).getUTCDate())).padStart(2,'0')}`;
}

export async function applySsotFinance(input:Record<string,unknown>,report:Report,
  actor:Principal,property:string,year:number,members:Member[]=[],
  originHash=osFinanceOriginHash(input,actor.id,property)){
  const requestId=String(input.request_id??'');
  if(!UUID.test(requestId)||input.property_id!==property||input.year!==year||
    input.projection_version!==report.projection_version||
    input.expected_version!==0)throw Error('VERSION_CONFLICT');
  const config=ironGateSsotFinanceConfig();
  const action=String(input.action??'');
  if(action==='create'||action==='update_expense'||action==='void'){
    const old=action==='create'?null:report.entries.find(e=>e.id===input.entry_id);
    if(action!=='create'&&(!old||old.ssot_source_system!=='os_manual'||
      !old.ssot_source_record_id||!Number.isSafeInteger(old.ssot_document_version)))
      throw Error('SOURCE_MAPPING_REVIEW_REQUIRED');
    if(action==='update_expense'&&old?.kind!=='expense')throw Error('INVALID_INPUT');
    if(action==='create')validateFinanceLinks(input,report.orders,report.entries,
      report.recurring,year,report.asof);
    const draft={...report.state,entries:report.entries.map(e=>e.id===old?.id?
      {...e,source:'manual' as const}:e)};
    const validated=applyFinance(draft,input,actor,property,year,undefined,members,
      report.payment_accounts,report.payout_rules);
    const entry=validated.state.entries.find(e=>e.id===
      (action==='create'?validated.entry_id:old?.id));
    if(!entry)throw Error('INVALID_INPUT');
    if(action==='void'){
      const reason=String(input.reason??'').trim();
      const command={request_key:requestId,origin_request_hash:originHash,
        source_record_id:old!.ssot_source_record_id!,
        source_version:String(old!.ssot_document_version!+1),
        expected_version:old!.ssot_document_version,action:'void',
        reason_code:'os_operator_void',reason_note:reason,
        booking_guards:bookingGuardsForVoid(old!,report.orders)};
      const receipt=await submitSsotFinanceCommand(config,actor,command,requestId);
      return {verified:true,entry_id:old!.id,version:0,receipt};
    }
    if(entry.kind==='expense')await ensureCategory(report,actor,requestId,'expense',
      entry.category,entry.category_name??EXPENSE_CATEGORIES[
        entry.category as keyof typeof EXPENSE_CATEGORIES]??entry.category);
    else await ensureCategory(report,actor,requestId,'income',entry.category,
      INCOME_CATEGORIES[entry.category as keyof typeof INCOME_CATEGORIES]??entry.category);
    const command=moneyCommand({...entry,
      ssot_source_record_id:old?.ssot_source_record_id,
      ssot_document_version:old?.ssot_document_version},input,report,requestId,
      originHash,
      action==='create'?'create':'amend');
    const receipt=await submitSsotFinanceCommand(config,actor,command,requestId);
    return {verified:true,entry_id:receipt.document_id,version:0,receipt};
  }
  // Non-cash settings retain the same validation rules as the previous OS UI.
  const validated=applyFinance(report.state,input,actor,property,year,undefined,members,
    report.payment_accounts,report.payout_rules);
  if(action==='payment_account_create'){
    const kind=input.method==='credit_card'?'card':'bank';
    const name=String(input.name??'').trim()||
      `${kind==='card'?'信用卡':'銀行帳戶'} · ${String(input.last_digits)}`;
    const command={request_key:requestId,origin_request_hash:originHash,
      code:sourceId(requestId),
      display_name:name,kind,
      last_digits:String(input.last_digits)};
    const receipt=await submitSsotPlan(config,actor,'accounts',command,requestId);
    return {verified:true,entry_id:receipt.account_code,version:0,receipt};
  }
  if(action==='recurring_create'||action==='recurring_stop'){
    const rule=action==='recurring_create'?
      validated.state.recurring?.find(r=>r.id===validated.entry_id):
      report.recurring.find(r=>r.id===input.rule_id);
    if(!rule)throw Error('INVALID_INPUT');
    await ensureCategory(report,actor,requestId,'expense',rule.category,
      rule.category_name??EXPENSE_CATEGORIES[
        rule.category as keyof typeof EXPENSE_CATEGORIES]??rule.category);
    const stop=action==='recurring_stop';
    if(stop&&(!rule.ssot_source_record_id||!rule.ssot_version))
      throw Error('SOURCE_MAPPING_REVIEW_REQUIRED');
    const end=stop?(taipeiDate()>rule.start?taipeiDate():rule.start):rule.end;
    const command={request_key:requestId,origin_request_hash:originHash,
      source_record_id:stop?rule.ssot_source_record_id:sourceId(requestId),
      version:stop?rule.ssot_version!+1:1,cadence:'monthly',
      start_on:rule.start,end_on:end,next_due_on:stop?null:dueDate(rule.start,rule.day),
      status:stop?'ended':'active',category_code:rule.category,
      amount_cents:rule.amount_cents,safe_description:rule.description,
      payment_method_code:rule.method,due_day:rule.day};
    const receipt=await submitSsotPlan(config,actor,'recurring-rules',command,requestId);
    return {verified:true,entry_id:receipt.rule_id,version:0,receipt};
  }
  if(action==='payout_rule'){
    const rule=validated.state.payout_rules?.find(r=>r.platform===input.platform);
    if(!rule)throw Error('INVALID_INPUT');
    const prior=report.payout_rules.find(r=>r.platform===rule.platform);
    const command={request_key:requestId,origin_request_hash:originHash,
      platform:rule.platform,
      version:(prior?.ssot_version??0)+1,
      mode:rule.mode==='monthly'?'fixed_day':'manual',
      ...(rule.mode==='monthly'?{day:rule.day,offset_months:rule.offset}:{}),
      status:'active'};
    const receipt=await submitSsotPlan(config,actor,'payout-rules',command,requestId);
    return {verified:true,entry_id:receipt.platform,version:0,receipt};
  }
  throw Error('INVALID_INPUT');
}
