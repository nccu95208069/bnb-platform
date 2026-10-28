import {createHash} from 'node:crypto';
import type {Principal,Member} from './workspace-auth/types';
import {applyFinance} from './finance-store.ts';
import {validateFinanceLinks} from './finance-projection.ts';
import type {FinanceEntry,FinanceOrder} from './finance-model';
import {EXPENSE_CATEGORIES,INCOME_CATEGORIES,taipeiDate} from './finance-model.ts';
import type {ssotFinanceContext} from './finance-ssot-context';
import {sealFinancePreview,type ConfirmedFinancePreview} from './finance-ssot-preview.server.ts';
import {ironGateSsotFinanceConfig,submitSsotFinanceCommand,
  submitSsotPlan,readSsotCatalog,readSsotReceipt,
  previewSsotFinanceCommand} from './booking-sources/iron-gate-ssot-finance.server.ts';

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
  const {ssot_preview_proof:_proof,ssot_preview_token:_token,...intent}=input;
  void _proof;void _token;
  return createHash('sha256').update(canonical({actorId,property,input:intent})).digest('hex');
}

/** An accepted receipt takes priority over a now-stale OS projection. */
export async function resumeSsotFinance(input:Record<string,unknown>,actor:Principal,
  property:string,read:typeof readSsotReceipt=readSsotReceipt,
  config:ReturnType<typeof ironGateSsotFinanceConfig>=ironGateSsotFinanceConfig(property)){
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
    if(!order||!UUID.test(order.booking_id??'')||
      !Number.isSafeInteger(order.ssot_booking_version)||
      Number(order.ssot_booking_version)<1||
      (order.source==='iron_gate'?!order.ssot_command_eligible:
        !/^[0-9a-f]{64}$/.test(order.ssot_source_snapshot_hash??'')))
      throw Error('SOURCE_MAPPING_REVIEW_REQUIRED');
    return {booking_id:order.booking_id!,
      expected_booking_version:order.ssot_booking_version!,
      ...(order.source==='iron_gate'?{}:{source_order_key:order.id,
        source_snapshot_hash:order.ssot_source_snapshot_hash!}),
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
  kind:'income'|'expense',code:string,label:string,
  config:ReturnType<typeof ironGateSsotFinanceConfig>){
  const found=report.ssot_catalog.categories.find(value=>
    object(value)&&value.kind===kind&&value.code===code&&value.status==='active');
  if(found)return;
  const key=hashUuid(`finance-category:${requestId}:${kind}:${code}`);
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

function assertSsotInput(input:Record<string,unknown>,report:Report,
  property:string,year:number){
  const requestId=String(input.request_id??'');
  if(!UUID.test(requestId)||input.property_id!==property||input.year!==year||
    typeof input.projection_version!=='string'||
    input.projection_version!==report.projection_version||
    input.expected_version!==0)throw Error('VERSION_CONFLICT');
  return requestId;
}

function prepareMoneyAction(input:Record<string,unknown>,report:Report,
  actor:Principal,property:string,year:number,members:Member[],originHash:string){
  const requestId=String(input.request_id);
  const action=String(input.action??'');
  if(!['create','update_expense','void'].includes(action))throw Error('INVALID_INPUT');
  const old=action==='create'?null:report.entries.find(e=>e.id===input.entry_id);
  if(action!=='create'&&(!old||old.ssot_source_system!=='os_manual'||
    !old.ssot_source_record_id||!Number.isSafeInteger(old.ssot_document_version)))
    throw Error('SOURCE_MAPPING_REVIEW_REQUIRED');
  if(action==='update_expense'&&old?.kind!=='expense')throw Error('INVALID_INPUT');
  if(action==='create')validateFinanceLinks(input,report.orders,report.entries,
    report.recurring,year,report.asof,{ssot:true});
  const draft={...report.state,entries:report.entries.map(e=>e.id===old?.id?
    {...e,source:'manual' as const}:e)};
  const validated=applyFinance(draft,input,actor,property,year,undefined,members,
    report.payment_accounts,report.payout_rules);
  const entry=validated.state.entries.find(e=>e.id===
    (action==='create'?validated.entry_id:old?.id));
  if(!entry)throw Error('INVALID_INPUT');
  if(action==='void'){
    const reason=String(input.reason??'').trim();
    return {entry,command:{request_key:requestId,origin_request_hash:originHash,
      source_record_id:old!.ssot_source_record_id!,
      source_version:String(old!.ssot_document_version!+1),
      expected_version:old!.ssot_document_version,action:'void',
      reason_code:'os_operator_void',reason_note:reason,
      booking_guards:bookingGuardsForVoid(old!,report.orders)}};
  }
  return {entry,command:moneyCommand({...entry,
    ssot_source_record_id:old?.ssot_source_record_id,
    ssot_document_version:old?.ssot_document_version},input,report,requestId,
    originHash,action==='create'?'create':'amend')};
}

function preparePlanAction(input:Record<string,unknown>,report:Report,
  actor:Principal,property:string,year:number,members:Member[],
  requestId:string,originHash:string){
  const validated=applyFinance(report.state,input,actor,property,year,undefined,
    members,report.payment_accounts,report.payout_rules);
  const action=String(input.action??'');
  if(action==='payment_account_create'){
    const kind=input.method==='credit_card'?'card':'bank';
    const name=String(input.name??'').trim()||
      `${kind==='card'?'信用卡':'銀行帳戶'} · ${String(input.last_digits)}`;
    return {suffix:'accounts' as const,
      command:{request_key:requestId,origin_request_hash:originHash,
        code:sourceId(requestId),display_name:name,kind,
        last_digits:String(input.last_digits)},
      lines:[`新增付款帳戶：${name}`,`末碼：${String(input.last_digits)}`]};
  }
  if(action==='recurring_create'||action==='recurring_stop'){
    const rule=action==='recurring_create'?
      validated.state.recurring?.find(r=>r.id===validated.entry_id):
      report.recurring.find(r=>r.id===input.rule_id);
    if(!rule)throw Error('INVALID_INPUT');
    const stop=action==='recurring_stop';
    if(stop&&(!rule.ssot_source_record_id||!rule.ssot_version))
      throw Error('SOURCE_MAPPING_REVIEW_REQUIRED');
    const end=stop?(taipeiDate()>rule.start?taipeiDate():rule.start):rule.end;
    return {suffix:'recurring-rules' as const,
      command:{request_key:requestId,origin_request_hash:originHash,
        source_record_id:stop?rule.ssot_source_record_id:sourceId(requestId),
        version:stop?rule.ssot_version!+1:1,cadence:'monthly',
        start_on:rule.start,end_on:end,next_due_on:stop?null:dueDate(rule.start,rule.day),
        status:stop?'ended':'active',category_code:rule.category,
        amount_cents:rule.amount_cents,safe_description:rule.description,
        payment_method_code:rule.method,due_day:rule.day},
      ...(stop?{}:{category:{kind:'expense' as const,code:rule.category,
        label:rule.category_name??EXPENSE_CATEGORIES[
          rule.category as keyof typeof EXPENSE_CATEGORIES]??rule.category}}),
      lines:stop?['停止循環支出',`金額：${amountLabel(rule.amount_cents)}`,
        `說明：${previewLine(rule.description)||rule.category_name||rule.category}`]:
        ['新增每月循環支出',`金額：${amountLabel(rule.amount_cents)}`,
          `分類：${rule.category_name??rule.category}`,`開始：${rule.start}`,
          `結束：${rule.end??'未設定'}`,`每月 ${rule.day} 日到期`,
          `說明：${previewLine(rule.description)||'（無）'}`]};
  }
  if(action==='payout_rule'){
    const rule=validated.state.payout_rules?.find(r=>r.platform===input.platform);
    if(!rule)throw Error('INVALID_INPUT');
    const prior=report.payout_rules.find(r=>r.platform===rule.platform);
    return {suffix:'payout-rules' as const,
      command:{request_key:requestId,origin_request_hash:originHash,
        platform:rule.platform,version:(prior?.ssot_version??0)+1,
        mode:rule.mode==='monthly'?'fixed_day':'manual',
        ...(rule.mode==='monthly'?{day:rule.day,offset_months:rule.offset}:{}),
        status:'active'},
      lines:[`更新 ${rule.platform} 平台入帳規則`,
        rule.mode==='monthly'?`退房後 ${rule.offset} 個月的 ${rule.day} 日`:'手動登記']};
  }
  throw Error('INVALID_INPUT');
}

const linkedCommand=(command:Record<string,unknown>)=>
  (Array.isArray(command.booking_allocations)&&command.booking_allocations.length>0)||
  (Array.isArray(command.booking_guards)&&command.booking_guards.length>0);
const amountLabel=(cents:number)=>`NT$${(cents/100).toLocaleString('zh-TW')}`;
const previewLine=(value:string)=>value.replace(/[\x00-\x1f\x7f]/g,' ').trim();

/** Read-only preview. No category, plan, or money write occurs before confirmation. */
export async function previewSsotOsFinance(input:Record<string,unknown>,report:Report,
  actor:Principal,property:string,year:number,members:Member[]=[],
  preview:typeof previewSsotFinanceCommand=previewSsotFinanceCommand,
  config:ReturnType<typeof ironGateSsotFinanceConfig>=ironGateSsotFinanceConfig(property)){
  const requestId=assertSsotInput(input,report,property,year);
  const action=String(input.action??'');
  const originHash=osFinanceOriginHash(input,actor.id,property);
  if(['create','update_expense','void'].includes(action)){
    const prepared=prepareMoneyAction(input,report,actor,property,year,members,
      originHash);
    const linked=linkedCommand(prepared.command);
    const exact=linked?await preview(config,actor,prepared.command,requestId):null;
    const token=exact?.command.preview_token;
    if(linked&&(typeof token!=='string'||!token))
      throw Error('FINANCE_SSOT_READBACK_MISMATCH');
    const confirmed:Record<string,unknown>=exact?.command??prepared.command;
    if(confirmed.request_key!==requestId||confirmed.origin_request_hash!==originHash||
      confirmed.action!==prepared.command.action)
      throw Error('FINANCE_SSOT_READBACK_MISMATCH');
    const bookingLinks=(prepared.entry.allocations??[]).map(row=>({
      order_id:row.order_id,amount_cents:row.amount_cents}));
    const lines=[action==='void'?'作廢紀錄':action==='update_expense'?'更正支出':
      prepared.entry.kind==='expense'?'新增支出':'新增收入',
      `金額：${amountLabel(prepared.entry.amount_cents)}`,
      `日期：${prepared.entry.date}`,
      `分類：${prepared.entry.category_name??prepared.entry.category}`,
      `說明：${previewLine(prepared.entry.description)||'（無）'}`,
      ...bookingLinks.map(row=>`訂單 ${row.order_id}：${amountLabel(row.amount_cents)}`),
      ...(action==='void'?[`作廢原因：${previewLine(String(input.reason??''))}`]:[])];
    const previewProof=sealFinancePreview({actor_id:actor.id,property_id:property,
      request_id:requestId,origin_hash:originHash,
      projection_version:String(input.projection_version),action,
      draft_command:prepared.command,confirmed_command:confirmed,
      ...(action==='void'?{}:{category:{kind:prepared.entry.kind==='expense'?
        'expense' as const:'income' as const,
        code:prepared.entry.category,label:prepared.entry.kind==='expense'?
          prepared.entry.category_name??EXPENSE_CATEGORIES[
            prepared.entry.category as keyof typeof EXPENSE_CATEGORIES]??
            prepared.entry.category:
          INCOME_CATEGORIES[
            prepared.entry.category as keyof typeof INCOME_CATEGORIES]??
            prepared.entry.category}})},
    config.calendar.proofSecret);
    return {request_id:requestId,action,kind:prepared.entry.kind,
      amount_cents:prepared.entry.amount_cents,date:prepared.entry.date,
      description:prepared.entry.description,
      booking_count:Array.isArray(exact?.bookings)?exact.bookings.length:0,
      lines,preview_proof:previewProof};
  }
  // Plan endpoints have no Iron Gate preview API. The same OS validation
  // prepares an exact command for the local confirmation summary.
  const plan=preparePlanAction(input,report,actor,property,year,members,
    requestId,originHash);
  const previewProof=sealFinancePreview({actor_id:actor.id,property_id:property,
    request_id:requestId,origin_hash:originHash,
    projection_version:String(input.projection_version),action,
    plan_suffix:plan.suffix,plan_command:plan.command,
    ...('category' in plan?{category:plan.category}:{})},
  config.calendar.proofSecret);
  return {request_id:requestId,action,kind:'plan',amount_cents:null,
    date:null,description:null,booking_count:0,lines:plan.lines,
    preview_proof:previewProof};
}

export async function applySsotFinance(input:Record<string,unknown>,report:Report,
  actor:Principal,property:string,year:number,members:Member[]=[],
  originHash=osFinanceOriginHash(input,actor.id,property),
  confirmedPreview?:ConfirmedFinancePreview,
  config:ReturnType<typeof ironGateSsotFinanceConfig>=ironGateSsotFinanceConfig(property)){
  void members;
  const requestId=String(input.request_id??'');
  if(!UUID.test(requestId)||input.property_id!==property||input.year!==year||
    input.expected_version!==0)throw Error('INVALID_INPUT');
  if(!confirmedPreview||confirmedPreview.origin_hash!==originHash)
    throw Error('FINANCE_PREVIEW_REQUIRED');
  const action=String(input.action??'');
  if(action==='create'||action==='update_expense'||action==='void'){
    if(!object(confirmedPreview.draft_command)||
      !object(confirmedPreview.confirmed_command))
      throw Error('FINANCE_PREVIEW_REQUIRED');
    const command=confirmedPreview.confirmed_command;
    if(command.request_key!==requestId||command.origin_request_hash!==originHash||
      command.action!==(action==='update_expense'?'amend':action)||
      confirmedPreview.draft_command.request_key!==requestId||
      (linkedCommand(confirmedPreview.draft_command)&&
        typeof command.preview_token!=='string'))
      throw Error('FINANCE_PREVIEW_REQUIRED');
    if(action==='void'){
      const receipt=await submitSsotFinanceCommand(config,actor,command,requestId,
        fetch,{repreviewOnConflict:false});
      return {verified:true,entry_id:String(input.entry_id),version:0,receipt};
    }
    const category=confirmedPreview.category;
    if(!category||!['income','expense'].includes(category.kind)||
      typeof category.code!=='string'||typeof category.label!=='string'||
      command.category_code!==category.code)
      throw Error('FINANCE_PREVIEW_REQUIRED');
    await ensureCategory(report,actor,requestId,category.kind,
      category.code,category.label,config);
    const receipt=await submitSsotFinanceCommand(config,actor,command,requestId,
      fetch,{repreviewOnConflict:false});
    return {verified:true,entry_id:receipt.document_id,version:0,receipt};
  }
  const suffix=action==='payment_account_create'?'accounts':
    action==='recurring_create'||action==='recurring_stop'?'recurring-rules':
      action==='payout_rule'?'payout-rules':null;
  if(!suffix||confirmedPreview.plan_suffix!==suffix||
    !object(confirmedPreview.plan_command)||
    confirmedPreview.plan_command.request_key!==requestId||
    confirmedPreview.plan_command.origin_request_hash!==originHash)
    throw Error('FINANCE_PREVIEW_REQUIRED');
  if(action==='recurring_create'){
    const category=confirmedPreview.category;
    if(!category||category.kind!=='expense'||
      confirmedPreview.plan_command.category_code!==category.code)
      throw Error('FINANCE_PREVIEW_REQUIRED');
    await ensureCategory(report,actor,requestId,category.kind,
      category.code,category.label,config);
  }
  const receipt=await submitSsotPlan(config,actor,suffix,
    confirmedPreview.plan_command,requestId);
  const entryId=suffix==='accounts'?receipt.account_code:
    suffix==='recurring-rules'?receipt.rule_id:receipt.platform;
  return {verified:true,entry_id:entryId,version:0,receipt};
}
