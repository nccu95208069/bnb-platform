import type {FinanceAuditEvent} from './finance-audit.ts';
export type PaymentAccount={id:string;property_id:string;method:'credit_card'|'bank_transfer';last_digits:string;name:string;created_at:string;actor_id:string};
import type {ExpenseShare} from './expense-spread.ts';
export type ExpenseAdvance = {type:'self'|'account'|'other'; name:string; account_id?:string};
export const EXPENSE_CATEGORIES = { laundry:'備品送洗', water:'水費', electricity:'電費', gas:'瓦斯費', utilities:'水電瓦斯（舊分類）', cable:'第四台', internet:'網路費', cleaning:'打掃清潔', supplies:'備品採購', repairs:'修繕維護', rent:'租金', small_items:'小物雜支', other:'其他花費' };
export const INCOME_CATEGORIES = { lodging:'住宿收入', breakfast:'早餐費', overtime:'超時／延退費', extra_guest:'加人／加床', partner:'合作廠商收入', other:'其他收入' };
export const METHODS = { cash:'現金', bank_transfer:'匯款', credit_card:'信用卡', ota:'OTA 代收', other:'其他' };
export type FinanceKind = 'income'|'expense';
export type FinanceEntry = { audit_event?:FinanceAuditEvent; id:string; ledger_year?:number; updated_at?:string; updated_by?:string; history?:{at:string;actor:string;actor_id:string;before:Omit<FinanceEntry,'history'>}[]; property_id:string; kind:FinanceKind|'refund'; category:string;category_name?:string; amount_cents:number; date:string; description:string; method:keyof typeof METHODS; stage?:string; source:'manual'|'calendar'|'iron_gate'; iron_gate_booking_id?:string; payment_event_id?:string; refund_of_event_id?:string; actor:string; created_at:string; status:'active'|'void'; payment_account?:Pick<PaymentAccount,'id'|'name'|'method'|'last_digits'>; expense_spread?:ExpenseShare[]; advanced_by?:ExpenseAdvance; void_reason?:string; void_at?:string; void_actor?:string; order_id?:string; order_key?:string; platform?:string; allocations?:{order_id:string;amount_cents:number;allocation_kind?:'room'|'deposit'|'extra'|'ota_payout'|'expense'}[]; recurrence_id?:string; occurrence?:string; ssot_source_record_id?:string; ssot_source_system?:string; ssot_document_version?:number; ssot_event_kind?:string; ssot_evidence_level?:string; ssot_evidence_ref?:string };
/** Only lodging and OTA payout allocations contribute to a booking's room collections. */
export function roomCollectionForOrder(entry:FinanceEntry,orderId:string){
 if(entry.allocations?.length)return entry.allocations.filter(a=>a.order_id===orderId&&
   (a.allocation_kind===undefined?entry.category==='lodging':
     ['room','deposit','ota_payout'].includes(a.allocation_kind)))
   .reduce((sum,a)=>sum+a.amount_cents,0);
 return entry.order_id===orderId&&entry.category==='lodging'?entry.amount_cents:0;
}
export type FinanceReport = { ssot_enabled?:boolean; iron_gate_revision?:string|null; iron_gate_direct_excluded?:boolean; payment_accounts?:PaymentAccount[]; expense_categories?:Record<string,string>; advance_accounts?:{id:string;name:string}[]; properties:{id:string;name:string}[]; property_id:string; year:number; version:number; entries:FinanceEntry[]; updated_at:string; versions:Record<string,number>; projection_version:string; orders:FinanceOrder[]; recurring:RecurringExpense[]; due:DueExpense[]; payout_rules:PayoutRule[]; excluded_orders:number };
export const categoryLabel=(entry:Pick<FinanceEntry,'kind'|'category'|'category_name'>)=>entry.kind==='refund'?'住宿退款':entry.category_name??((entry.kind==='income'?INCOME_CATEGORIES:EXPENSE_CATEGORIES) as Record<string,string>)[entry.category]??'未分類';
export function summarize(entries:FinanceEntry[],month:string) {
  const active=entries.filter(e=>e.status==='active');
  const selected=active.filter(e=>e.date.startsWith(month));
  const sum=(kind:FinanceEntry['kind'])=>selected.filter(e=>e.kind===kind).reduce((s,e)=>s+e.amount_cents,0);
  const income=sum('income'),expense=sum('expense'),refund=sum('refund');
  const shares=active.filter(e=>e.kind==='expense').flatMap(e=>(e.expense_spread??[{month:e.date.slice(0,7),amount_cents:e.amount_cents}]).map(a=>({...a,category:e.category})));
  const allocatedExpense=shares.filter(a=>a.month===month).reduce((s,a)=>s+a.amount_cents,0);
  return {income,expense,refund,allocatedExpense,net:income-refund-expense,ota:selected.filter(e=>e.kind==='income'&&e.method==='ota').reduce((s,e)=>s+e.amount_cents,0),
    monthly:Array.from({length:12},(_,i)=>({month:i+1,expense:shares.filter(e=>e.month===`${month.slice(0,4)}-${String(i+1).padStart(2,'0')}`).reduce((s,e)=>s+e.amount_cents,0)})),
    categories:Object.entries(expenseCategories(entries)).map(([id,label])=>({id,label,amount:shares.filter(e=>e.month===month&&e.category===id).reduce((s,e)=>s+e.amount_cents,0)})).filter(c=>c.amount>0).sort((a,b)=>b.amount-a.amount)};
}

export const PLATFORMS:Record<string,string>={direct:'LINE／電話／直訂',agoda:'Agoda',ctrip:'Trip.com',owljourney:'奧丁丁',booking:'Booking.com',airbnb:'Airbnb',other:'其他'};
export type LegacySettlementStatus='settled_before_cutover_cash_details_unknown'|'unpaid_at_cutover';
export type LegacySettlementDisplay={status:LegacySettlementStatus;collection_hold:boolean;
 historical_cash_detail_missing:boolean;review_required:boolean};
export type FinanceOrder={amount_reconciliation?:import('./source-amount-reconciliation').SourceAmountBreakdown & {bookingId:string;version:number};source?:'iron_gate';booking_id?:string;ssot_booking_version?:number;ssot_source_snapshot_hash?:string;receivable_review_required?:boolean;legacy_settlement?:LegacySettlementDisplay;historical_cash_detail_missing?:boolean;collection_hold?:boolean;status?:'held'|'confirmed'|'cancelled';id:string;calendar_id:string;platform:string;rooms:string[];check_in:string;check_out:string;total:number;received:number;receivable:number;eligible_date:string|null;source_paid:boolean;credit:number;source_version:string};
export type RecurringExpense={id:string;year:number;category:string;category_name?:string;amount_cents:number;description:string;method:FinanceEntry['method'];start:string;end:string|null;day:number;created_at:string;actor:string;stopped_at?:string;stopped_by?:string;ssot_source_record_id?:string;ssot_version?:number};
export type DueExpense={id:string;rule_id:string;year:number;date:string;category:string;category_name?:string;amount_cents:number;description:string;method:FinanceEntry['method']};
export type PayoutRule={platform:string;mode:'manual'|'monthly';day:number;offset:number;updated_at?:string;ssot_version?:number};
export const taipeiDate=(now=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
export function recurrenceDue(rules:RecurringExpense[],entries:FinanceEntry[],year:number,asof=taipeiDate()):DueExpense[]{
 const paid=new Set(entries.filter(e=>e.status==='active'&&e.recurrence_id).map(e=>`${e.recurrence_id}:${e.occurrence}`));
 return rules.flatMap(r=>Array.from({length:12},(_,i)=>{const month=`${year}-${String(i+1).padStart(2,'0')}`;const day=Math.min(r.day,new Date(Date.UTC(year,i+1,0)).getUTCDate());const date=`${month}-${String(day).padStart(2,'0')}`;return {id:`${r.id}:${date}`,rule_id:r.id,year,date,category:r.category,amount_cents:r.amount_cents,description:r.description,category_name:r.category_name,method:r.method};}).filter(d=>d.date>=r.start&&(!r.end||d.date<=r.end)&&(!r.stopped_at||d.date<=r.stopped_at.slice(0,10))&&d.date<=asof&&!paid.has(d.id)));
}
// Stay-month order amounts are split into actual receipts and outstanding balances.
// Unallocated service income is counted in its actual receipt month, once only.
export function revenueSummary(orders:FinanceOrder[],entries:FinanceEntry[],month:string){
 const selected=orders.filter(o=>o.status!=='held'&&o.status!=='cancelled'&&o.check_in.startsWith(month));
 const extra=entries.filter(e=>e.status==='active'&&e.kind==='income'&&
   e.method!=='ota'&&e.date.startsWith(month)).reduce((sum,e)=>{
   if(!e.allocations?.length)return sum+(!e.order_key||e.category!=='lodging'?e.amount_cents:0);
   const linked=e.allocations.reduce((amount,a)=>amount+a.amount_cents,0);
   const service=e.allocations.filter(a=>a.allocation_kind==='extra'||
     a.allocation_kind===undefined&&e.category!=='lodging')
     .reduce((amount,a)=>amount+a.amount_cents,0);
   return sum+service+Math.max(0,e.amount_cents-linked);
 },0);
 const received=selected.reduce((s,o)=>s+Math.min(o.received,o.total),0)+extra;
 const receivable=selected.reduce((s,o)=>s+o.receivable,0);
 return {received,receivable,total:received+receivable,
   review_count:selected.filter(o=>o.receivable_review_required||o.historical_cash_detail_missing).length};
}

export function expenseCategories(records:{category:string;category_name?:string}[]):Record<string,string>{return {...EXPENSE_CATEGORIES,...Object.fromEntries(records.filter(e=>e.category.startsWith('custom_')&&e.category_name).map(e=>[e.category,e.category_name!]))};}

export function expenseAmountInMonth(entry:FinanceEntry,month:string){return (entry.expense_spread??[{month:entry.date.slice(0,7),amount_cents:entry.amount_cents}]).filter(r=>r.month===month).reduce((sum,r)=>sum+r.amount_cents,0);}
export function entryInMonth(entry:FinanceEntry,month:string){return entry.kind==='expense'?(entry.expense_spread??[{month:entry.date.slice(0,7)}]).some(r=>r.month===month):entry.date.startsWith(month);}
