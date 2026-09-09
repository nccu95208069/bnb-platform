import type {ExpenseShare} from './expense-spread.ts';
export type ExpenseAdvance = {type:'self'|'account'|'other'; name:string; account_id?:string};
export const EXPENSE_CATEGORIES = { laundry:'備品送洗', utilities:'水電瓦斯', cable:'第四台', internet:'網路費', cleaning:'打掃清潔', supplies:'備品採購', repairs:'修繕維護', rent:'租金', small_items:'小物雜支', other:'其他花費' };
export const INCOME_CATEGORIES = { lodging:'住宿收入', breakfast:'早餐費', overtime:'超時／延退費', extra_guest:'加人／加床', partner:'合作廠商收入', other:'其他收入' };
export const METHODS = { cash:'現金', bank_transfer:'匯款', credit_card:'信用卡', ota:'OTA 代收', other:'其他' };
export type FinanceKind = 'income'|'expense';
export type FinanceEntry = { id:string; property_id:string; kind:FinanceKind; category:string; amount_cents:number; date:string; description:string; method:keyof typeof METHODS; stage?:string; source:'manual'|'calendar'; actor:string; created_at:string; status:'active'|'void'; expense_spread?:ExpenseShare[]; advanced_by?:ExpenseAdvance; void_reason?:string; void_at?:string; void_actor?:string; order_id?:string; order_key?:string; platform?:string; allocations?:{order_id:string;amount_cents:number}[]; recurrence_id?:string; occurrence?:string };
export type FinanceReport = { advance_accounts?:{id:string;name:string}[]; properties:{id:string;name:string}[]; property_id:string; year:number; version:number; entries:FinanceEntry[]; updated_at:string; versions:Record<string,number>; projection_version:string; orders:FinanceOrder[]; recurring:RecurringExpense[]; due:DueExpense[]; payout_rules:PayoutRule[]; excluded_orders:number };
export const categoryLabel=(entry:Pick<FinanceEntry,'kind'|'category'>)=>((entry.kind==='income'?INCOME_CATEGORIES:EXPENSE_CATEGORIES) as Record<string,string>)[entry.category]??'未分類';
export function summarize(entries:FinanceEntry[],month:string) {
  const active=entries.filter(e=>e.status==='active');
  const selected=active.filter(e=>e.date.startsWith(month));
  const sum=(kind:FinanceKind)=>selected.filter(e=>e.kind===kind).reduce((s,e)=>s+e.amount_cents,0);
  const income=sum('income'),expense=sum('expense');
  const shares=active.filter(e=>e.kind==='expense').flatMap(e=>(e.expense_spread??[{month:e.date.slice(0,7),amount_cents:e.amount_cents}]).map(a=>({...a,category:e.category})));
  const allocatedExpense=shares.filter(a=>a.month===month).reduce((s,a)=>s+a.amount_cents,0);
  return {income,expense,allocatedExpense,net:income-expense,ota:selected.filter(e=>e.kind==='income'&&e.method==='ota').reduce((s,e)=>s+e.amount_cents,0),
    monthly:Array.from({length:12},(_,i)=>({month:i+1,expense:shares.filter(e=>e.month===`${month.slice(0,4)}-${String(i+1).padStart(2,'0')}`).reduce((s,e)=>s+e.amount_cents,0)})),
    categories:Object.entries(EXPENSE_CATEGORIES).map(([id,label])=>({id,label,amount:shares.filter(e=>e.month===month&&e.category===id).reduce((s,e)=>s+e.amount_cents,0)})).filter(c=>c.amount>0).sort((a,b)=>b.amount-a.amount)};
}

export const PLATFORMS:Record<string,string>={direct:'LINE／電話／直訂',agoda:'Agoda',ctrip:'Trip.com',owljourney:'奧丁丁',booking:'Booking.com',airbnb:'Airbnb',other:'其他'};
export type FinanceOrder={id:string;calendar_id:string;platform:string;rooms:string[];check_in:string;check_out:string;total:number;received:number;receivable:number;eligible_date:string|null;source_paid:boolean;credit:number;source_version:string};
export type RecurringExpense={id:string;year:number;category:string;amount_cents:number;description:string;method:FinanceEntry['method'];start:string;end:string|null;day:number;created_at:string;actor:string;stopped_at?:string;stopped_by?:string};
export type DueExpense={id:string;rule_id:string;year:number;date:string;category:string;amount_cents:number;description:string;method:FinanceEntry['method']};
export type PayoutRule={platform:string;mode:'manual'|'monthly';day:number;offset:number;updated_at?:string};
export const taipeiDate=(now=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
export function recurrenceDue(rules:RecurringExpense[],entries:FinanceEntry[],year:number,asof=taipeiDate()):DueExpense[]{
 const paid=new Set(entries.filter(e=>e.status==='active'&&e.recurrence_id).map(e=>`${e.recurrence_id}:${e.occurrence}`));
 return rules.flatMap(r=>Array.from({length:12},(_,i)=>{const month=`${year}-${String(i+1).padStart(2,'0')}`;const day=Math.min(r.day,new Date(Date.UTC(year,i+1,0)).getUTCDate());const date=`${month}-${String(day).padStart(2,'0')}`;return {id:`${r.id}:${date}`,rule_id:r.id,year,date,category:r.category,amount_cents:r.amount_cents,description:r.description,method:r.method};}).filter(d=>d.date>=r.start&&(!r.end||d.date<=r.end)&&(!r.stopped_at||d.date<=r.stopped_at.slice(0,10))&&d.date<=asof&&!paid.has(d.id)));
}
// Stay-month order amounts are split into actual receipts and outstanding balances.
// Unallocated service income is counted in its actual receipt month, once only.
export function revenueSummary(orders:FinanceOrder[],entries:FinanceEntry[],month:string){
 const selected=orders.filter(o=>o.check_in.startsWith(month));
 const extra=entries.filter(e=>e.status==='active'&&e.kind==='income'&&e.method!=='ota'&&!e.allocations?.length&&(!e.order_key||e.category!=='lodging')&&e.date.startsWith(month)).reduce((s,e)=>s+e.amount_cents,0);
 const received=selected.reduce((s,o)=>s+Math.min(o.received,o.total),0)+extra;
 const receivable=selected.reduce((s,o)=>s+o.receivable,0);
 return {received,receivable,total:received+receivable};
}
