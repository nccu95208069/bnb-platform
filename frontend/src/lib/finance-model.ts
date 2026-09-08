export const EXPENSE_CATEGORIES = { laundry:'備品送洗', utilities:'水電瓦斯', cable:'第四台', internet:'網路費', cleaning:'打掃清潔', supplies:'備品採購', repairs:'修繕維護', rent:'租金', small_items:'小物雜支', other:'其他花費' };
export const INCOME_CATEGORIES = { lodging:'住宿收入', breakfast:'早餐費', overtime:'超時／延退費', extra_guest:'加人／加床', partner:'合作廠商收入', other:'其他收入' };
export const METHODS = { cash:'現金', bank_transfer:'匯款', credit_card:'信用卡', ota:'OTA 代收', other:'其他' };
export type FinanceKind = 'income'|'expense';
export type FinanceEntry = { id:string; property_id:string; kind:FinanceKind; category:string; amount_cents:number; date:string; description:string; method:keyof typeof METHODS; stage?:string; source:'manual'|'calendar'; actor:string; created_at:string; status:'active'|'void'; void_reason?:string; void_at?:string; void_actor?:string; order_id?:string };
export type FinanceReport = { properties:{id:string;name:string}[]; property_id:string; year:number; version:number; entries:FinanceEntry[]; updated_at:string };
export const categoryLabel=(entry:Pick<FinanceEntry,'kind'|'category'>)=>((entry.kind==='income'?INCOME_CATEGORIES:EXPENSE_CATEGORIES) as Record<string,string>)[entry.category]??'未分類';
export function summarize(entries:FinanceEntry[],month:string) {
  const active=entries.filter(e=>e.status==='active');
  const selected=active.filter(e=>e.date.startsWith(month));
  const sum=(kind:FinanceKind)=>selected.filter(e=>e.kind===kind).reduce((s,e)=>s+e.amount_cents,0);
  const income=sum('income'),expense=sum('expense');
  return {income,expense,net:income-expense,ota:selected.filter(e=>e.kind==='income'&&e.method==='ota').reduce((s,e)=>s+e.amount_cents,0),
    monthly:Array.from({length:12},(_,i)=>({month:i+1,expense:active.filter(e=>e.kind==='expense'&&e.date.startsWith(`${month.slice(0,4)}-${String(i+1).padStart(2,'0')}`)).reduce((s,e)=>s+e.amount_cents,0)})),
    categories:Object.entries(EXPENSE_CATEGORIES).map(([id,label])=>({id,label,amount:selected.filter(e=>e.kind==='expense'&&e.category===id).reduce((s,e)=>s+e.amount_cents,0)})).filter(c=>c.amount>0).sort((a,b)=>b.amount-a.amount)};
}
