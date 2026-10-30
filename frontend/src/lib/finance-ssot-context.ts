import {financeGeneralOnly} from './finance-history-policy.ts';
import {readBookingSnapshot} from './booking-sources/snapshot';
import type {SheetSourceDefinition} from './booking-sources/config';
import {ironGateFinanceConfig,readDirectFinance,
  applyFinanceAmountCorrections} from './booking-sources/iron-gate-finance.server.ts';
import {ironGateSsotFinanceConfig,readSsotLedger,readSsotLedgerSnapshot,readSsotCatalog,
  readSsotHistoricalSettlements,
  type SsotEvent} from './booking-sources/iron-gate-ssot-finance.server.ts';
import type {Principal} from './workspace-auth/types';
import {projectOrders,projectionVersion,projectSsotBookingBalances} from './finance-projection';
import {applyHistoricalSettlements} from './finance-ssot-settlement';
import {readSsotBookings} from './booking-sources/iron-gate-ssot-bookings.server.ts';
import {recurrenceDue,taipeiDate,type FinanceEntry,type FinanceOrder,
  type PaymentAccount,type PayoutRule,type RecurringExpense,
  EXPENSE_CATEGORIES,METHODS,roomCollectionForOrder} from './finance-model';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY=/^\d{4}-\d{2}-\d{2}$/;
const object=(v:unknown):v is Record<string,unknown>=>
  !!v&&typeof v==='object'&&!Array.isArray(v);
const fail=():never=>{throw Error('FINANCE_SSOT_READBACK_MISMATCH');};
const date=(v:unknown):string=>typeof v==='string'&&DAY.test(v)?v:fail();
const cents=(v:unknown):number=>{
  const n=typeof v==='string'&&/^[-]?[0-9]+$/.test(v)?Number(v):v;
  return Number.isSafeInteger(n)?Number(n):fail();
};

type Catalog={accounts:unknown[];categories:unknown[];recurring:unknown[];
  payout:unknown[];links:unknown[]};

export function currentEvents(events:SsotEvent[]){
  const selected=new Map<string,SsotEvent>();
  for(const event of events){
    if(!UUID.test(event.document_id)||!UUID.test(event.id)||
      event.event_kind==='reversal')continue;
    const prior=selected.get(event.document_id);
    if(!prior||Number(event.revision_version)>Number(prior.revision_version))
      selected.set(event.document_id,event);
  }
  for(const event of selected.values()){
    if(event.document_status==='active'&&
      Number(event.revision_version)!==Number(event.current_version)&&
      !(event.source_system==='sweetfun_card'&&
        Number(event.revision_version)<Number(event.current_version)))fail();
    if(event.document_status==='void'&&
      Number(event.revision_version)!==Number(event.current_version)-1)fail();
  }
  return [...selected.values()];
}

/** A gross room price is not an outstanding balance when the payer is unclear. */
export function reviewUncertainReceivables(orders:FinanceOrder[],events:SsotEvent[]){
  const mixedBookingIds=new Set(currentEvents(events)
    .filter(event=>event.document_status==='active'&&
      ['ota_guest_payment_observed','ota_payout'].includes(event.event_kind))
    .flatMap(event=>event.booking_allocations.map(a=>a.booking_id)));
  return orders.map(order=>{
    const uncertain=order.receivable_review_required||order.platform!=='direct'||
      (order.booking_id!=null&&mixedBookingIds.has(order.booking_id));
    return uncertain?{...order,receivable:0,receivable_review_required:true}:order;
  });
}

function orderMap(orders:FinanceOrder[],catalog:Catalog){
  const byBooking=new Map<string,string>();
  const historical=new Map<string,string>();
  const byOrder=new Map(orders.map(order=>[order.id,order]));
  for(const order of orders){
    const id=order.booking_id??order.amount_reconciliation?.bookingId;
    if(id){
      const old=byBooking.get(id);
      if(old&&old!==order.id)fail();
      byBooking.set(id,order.id);
    }
  }
  for(const value of catalog.links){
    const row=object(value)?value:fail();
    if(!UUID.test(String(row.booking_id))||
      !UUID.test(String(row.source_instance_id))||
      typeof row.source_order_key!=='string'||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(row.source_order_key)||
      !Number.isSafeInteger(Number(row.verified_booking_version))||
      Number(row.verified_booking_version)<1||
      !/^[0-9a-f]{64}$/.test(String(row.source_snapshot_hash)))fail();
    const sourceOrderKey=String(row.source_order_key);
    const order=byOrder.get(sourceOrderKey);
    if(!order){
      // A canceled imported booking is absent from current orders, but its
      // verified source link still identifies historical cash allocations.
      // LINE refreshes this link per booking version. All such keys refer to
      // the same booking, so use its UUID as the stable historical display ID.
      const key=`${row.source_instance_id}:${row.booking_id}`;
      const versioned=sourceOrderKey.startsWith(`${row.booking_id}:v`)&&
        /^[1-9][0-9]*$/.test(sourceOrderKey.slice(`${row.booking_id}:v`.length));
      if(versioned&&Number(sourceOrderKey.slice(`${row.booking_id}:v`.length))!==
        Number(row.verified_booking_version))fail();
      const historicalId=versioned?String(row.booking_id):sourceOrderKey;
      const old=historical.get(key);
      if(old&&old!==historicalId)fail();
      historical.set(key,historicalId);
      continue;
    }
    const id=String(row.booking_id),old=byBooking.get(id);
    if(old&&old!==order.id)fail();
    byBooking.set(id,order.id);
  }
  return {byBooking,historical};
}
function attachLinks(orders:FinanceOrder[],catalog:Catalog){
  for(const value of catalog.links){
    const row=object(value)?value:fail();
    const order=orders.find(o=>o.id===row.source_order_key);
    if(!order)continue;
    if(!UUID.test(String(row.booking_id))||
      !/^[0-9a-f]{64}$/.test(String(row.source_snapshot_hash))||
      !Number.isSafeInteger(Number(row.verified_booking_version)))fail();
    if(order.booking_id&&order.booking_id!==row.booking_id)fail();
    order.booking_id=String(row.booking_id);
    order.ssot_booking_version=Number(row.verified_booking_version);
    order.ssot_source_snapshot_hash=String(row.source_snapshot_hash);
  }
}

export function entriesFromLedger(events:SsotEvent[],property:string,
  orders:FinanceOrder[],catalog:Catalog):FinanceEntry[]{
  const mapping=orderMap(orders,catalog);
  return currentEvents(events).flatMap(event=>{
    if(event.event_kind==='ota_guest_payment_observed')return [];
    const kind:FinanceEntry['kind']=['expense_paid','processor_fee_paid'].includes(event.event_kind)?
      'expense':event.event_kind==='property_refund'?'refund':'income';
    if(!['expense','refund','income'].includes(kind))return fail();
    const amount=cents(event.amount_cents),day=date(event.cash_on??event.effective_on);
    if(amount<=0||!Array.isArray(event.booking_allocations)||
      !Array.isArray(event.expense_attributions))fail();
    const allocations=event.booking_allocations.map(a=>{
      const orderId=mapping.byBooking.get(a.booking_id)??
        mapping.historical.get(`${event.source_instance_id}:${a.booking_id}`)??fail();
      if(cents(a.amount_cents)<=0||
        !['room','deposit','extra','ota_payout','expense'].includes(a.allocation_kind))fail();
      return {order_id:orderId,amount_cents:cents(a.amount_cents),
        allocation_kind:a.allocation_kind as 'room'|'deposit'|'extra'|'ota_payout'|'expense'};
    });
    const sourceRecord=event.source_record_id;
    const recurrence=/^os-recurring:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/i.exec(sourceRecord);
    // A platform payout is cash received by the property. Only a guest-paid
    // observation is non-cash, and those events are omitted above.
    const method=(event.payment_method_code??'other') as FinanceEntry['method'];
    if(!(method in METHODS))fail();
    const category=event.category_code??(kind==='expense'?'other':
      event.event_kind==='ota_payout'?'lodging':
      event.receipt_purpose==='room'||event.receipt_purpose==='deposit'?'lodging':'other');
    const spread=event.expense_attributions.map(a=>({month:date(a.month).slice(0,7),
      amount_cents:cents(a.amount_cents)}));
    const account=event.payment_account_ref?catalog.accounts.find(value=>
      object(value)&&value.code===event.payment_account_ref):null;
    const paymentAccount=object(account)&&
      ['card','bank'].includes(String(account.kind))&&
      typeof account.last_digits==='string'&&
      typeof account.display_name==='string'?{
        id:event.payment_account_ref!,name:account.display_name,
        method:account.kind==='card'?'credit_card' as const:'bank_transfer' as const,
        last_digits:account.last_digits}:undefined;
    const advancedBy=event.advanced_by_kind&&event.advanced_by_label?{
      type:event.advanced_by_kind,name:event.advanced_by_label,
      ...(event.advanced_by_kind==='account'?{account_id:event.advanced_by_ref??undefined}:{})
    }:undefined;
    const entry:FinanceEntry={id:event.document_id,property_id:property,kind,
      category,amount_cents:amount,date:day,description:event.safe_description??
        (kind==='expense'?'支出':kind==='refund'?'退款':'收入'),
      method,stage:event.receipt_purpose??undefined,source:'iron_gate',
      actor:event.actor_ref,created_at:event.created_at,
      status:event.document_status,
      order_id:allocations.length===1?allocations[0].order_id:undefined,
      allocations:allocations.length?allocations:undefined,
      ...(event.booking_allocations.length===1&&
        ['iron_gate_native','sweetfun_card'].includes(event.source_system)?
        {iron_gate_booking_id:event.booking_allocations[0].booking_id}:{}),
      ...(allocations.length===1?{platform:orders.find(o=>o.id===allocations[0].order_id)?.platform}:{}),
      expense_spread:spread.length?spread:undefined,
      payment_account:paymentAccount,advanced_by:advancedBy,
      payment_event_id:event.id,ledger_year:Number(day.slice(0,4)),
      refund_of_event_id:event.related_receipt_event_id??undefined,
      ...(recurrence?{recurrence_id:recurrence[1],occurrence:recurrence[2]}:{}),
      ssot_source_record_id:sourceRecord,
      ssot_source_system:event.source_system,
      ssot_document_version:Number(event.current_version),
      ssot_event_kind:event.event_kind,
      ssot_evidence_level:event.evidence_level,
      ssot_evidence_ref:event.evidence_ref??undefined,
      ...(event.document_status==='void'&&event.current_reason_note?
        {void_reason:event.current_reason_note}:{})};
    return [entry];
  });
}

export function readCatalog(catalog:Catalog,property:string){
  const accounts:PaymentAccount[]=catalog.accounts.flatMap(value=>{
    if(!object(value)||!['bank','card'].includes(String(value.kind))||
      typeof value.code!=='string'||typeof value.display_name!=='string'||
      typeof value.last_digits!=='string')return [];
    return [{id:value.code,property_id:property,
      method:value.kind==='card'?'credit_card':'bank_transfer',
      last_digits:value.last_digits,name:value.display_name,
      created_at:'',actor_id:''} as PaymentAccount];
  });
  const categories:Record<string,string>={...EXPENSE_CATEGORIES};
  for(const value of catalog.categories){
    const row=object(value)?value:fail();
    if(typeof row.code!=='string'||typeof row.label!=='string'||
      !['income','expense'].includes(String(row.kind)))fail();
    if(row.status==='active'&&row.kind==='expense')
      categories[String(row.code)]=String(row.label);
  }
  const recurring:RecurringExpense[]=catalog.recurring.map(value=>{
    const row=object(value)?value:fail();
    if(row.cadence!=='monthly'||!['active','ended'].includes(String(row.status))||
      !UUID.test(String(row.id))||
      !Number.isSafeInteger(Number(row.due_day))||
      cents(row.amount_cents)<=0||!DAY.test(String(row.start_on))||
      !(String(row.payment_method_code) in METHODS))fail();
    return {id:String(row.id),year:Number(String(row.start_on).slice(0,4)),
      category:String(row.category_code),amount_cents:cents(row.amount_cents),
      description:String(row.safe_description??''),
      method:String(row.payment_method_code) as FinanceEntry['method'],
      start:date(row.start_on),end:row.end_on?date(row.end_on):null,
      day:Number(row.due_day),created_at:'',actor:'',
      ssot_source_record_id:String(row.source_record_id),
      ssot_version:Number(row.version),
      ...(row.status==='ended'?{stopped_at:date(row.end_on??row.start_on)}:{})};
  });
  const payout:PayoutRule[]=catalog.payout.filter(value=>
    object(value)&&value.status==='active').map(value=>{
    const row=object(value)?value:fail();
    if(typeof row.platform!=='string')fail();
    if(row.mode==='manual')return {platform:String(row.platform),mode:'manual',day:10,
      offset:1,ssot_version:Number(row.version)};
    if(row.mode==='fixed_day'&&Number.isInteger(row.day)&&
      Number.isInteger(row.offset_months))return {platform:String(row.platform),
      mode:'monthly',day:Number(row.day),offset:Number(row.offset_months),
      ssot_version:Number(row.version)};
    return fail();
  });
  return {accounts,categories,recurring,payout};
}

export async function ssotFinanceContext(source:SheetSourceDefinition,year:number,
  actor:Principal){
  const property=source.property.id;
  const config=ironGateSsotFinanceConfig(property);
  if(property==='offland')return offlandSsotContext(year,actor,config);
  if(property!=='sweetfun'||
    process.env.IRON_GATE_SWEETFUN_FINANCE_ENABLED!=='true')
    throw Error('FINANCE_SSOT_UNAVAILABLE');
  const [ledger,catalog,snapshot,direct]=await Promise.all([
    readSsotLedgerSnapshot(config,actor),readSsotCatalog(config,actor),
    readBookingSnapshot(source),readDirectFinance(actor,ironGateFinanceConfig(),[])]);
  const events=ledger.events;
  const settlements=await readSsotHistoricalSettlements(config,actor,ledger.asOfChangeSeq);
  if(!snapshot)throw Error('FINANCE_SSOT_UNAVAILABLE');
  const lookup=readCatalog(catalog,source.property.id);
  const {orders,excluded}=projectOrders(snapshot.bookings.filter(b=>
    !direct.replacedOrderIds.includes(b.order_id)),[],lookup.payout);
  applyFinanceAmountCorrections(orders,direct.amountReconciliations);
  if(orders.some(order=>direct.orders.some(d=>d.id===order.id)))fail();
  orders.push(...direct.orders);
  attachLinks(orders,catalog);
  const entries=entriesFromLedger(events,source.property.id,orders,catalog);
  const projected=projectOrders(snapshot.bookings.filter(b=>
    !direct.replacedOrderIds.includes(b.order_id)),entries,lookup.payout);
  applyFinanceAmountCorrections(projected.orders,direct.amountReconciliations);
  attachLinks(projected.orders,catalog);
  projected.orders.push(...direct.orders.map(order=>{
    const received=entries.filter(e=>e.status==='active'&&
      ['income','refund'].includes(e.kind)).reduce((n,e)=>n+
      (e.kind==='refund'?-1:1)*roomCollectionForOrder(e,order.id),0);
    return {...order,received,receivable:Math.max(0,order.total-received),
      credit:Math.max(0,received-order.total)};
  }));
  const financeOrders=applyHistoricalSettlements(
    reviewUncertainReceivables(projected.orders,events),settlements,source.property.id);
  const active=entries.filter(e=>e.status==='active');
  const projection=projectionVersion([snapshot.bookings.map(b=>[
    b.id,b.order_id,b.room_rate,b.check_in,b.check_out,b.platform,b.source_conflict,
    b.reservation_status]),events.map(e=>[e.id,e.document_id,e.revision_version,
    e.current_version,e.document_status]),catalog,direct.revision,settlements]);
  return {state:{version:0,entries,operations:[]},raw:null,
    entries,orders:financeOrders,recurring:lookup.recurring,
    payment_accounts:lookup.accounts,payout_rules:lookup.payout,
    expense_categories:lookup.categories,excluded_orders:Math.max(excluded,projected.excluded),
    versions:{[String(year)]:0},due:[...new Set(lookup.recurring.flatMap(rule=>
      Array.from({length:Math.max(0,year-rule.year+1)},(_,i)=>rule.year+i)))]
      .flatMap(dueYear=>recurrenceDue(lookup.recurring,active,dueYear)),
    projection_version:projection,
    iron_gate_revision:direct.revision,iron_gate_direct_excluded:false,
    audit:[],asof:taipeiDate(),ssot_events:events,ssot_catalog:catalog};
}

/** Offland reads the current authoritative booking set; no operational Sheet is involved. */
async function offlandSsotContext(year:number,actor:Principal,
 config:ReturnType<typeof ironGateSsotFinanceConfig>){
 // The shared production DB role has a tight connection limit. Keep this
 // read-only fanout to one Iron Gate request at a time for Offland.
 const events=await readSsotLedger(config,actor);
 const catalog=await readSsotCatalog(config,actor,fetch,true);
 const bookings=await readSsotBookings(config,actor);
 const lookup=readCatalog(catalog,'offland');
 const entries=entriesFromLedger(events,'offland',bookings.orders,catalog);
 const orders=reviewUncertainReceivables(projectSsotBookingBalances(bookings.orders,entries),events)
  .map(order=>financeGeneralOnly('offland')?{...order,ssot_command_eligible:false}:order);
 const active=entries.filter(entry=>entry.status==='active');
 return {state:{version:0,entries,operations:[]},raw:null,entries,orders,
  recurring:lookup.recurring,payment_accounts:lookup.accounts,payout_rules:lookup.payout,
  expense_categories:lookup.categories,
  excluded_orders:orders.filter(order=>order.amount_review_required).length,
  versions:{[String(year)]:0},
  due:[...new Set(lookup.recurring.flatMap(rule=>Array.from({length:Math.max(0,year-rule.year+1)},(_,i)=>rule.year+i)))]
   .flatMap(dueYear=>recurrenceDue(lookup.recurring,active,dueYear)),
  projection_version:projectionVersion([bookings.revision,events,catalog]),
  iron_gate_revision:bookings.revision,iron_gate_direct_excluded:false,
  audit:[],asof:taipeiDate(),ssot_events:events,ssot_catalog:catalog};
}
