"use client";
import {useIntlLocale,useT} from '@/components/i18n/language-provider';
import {useEffect,useState} from 'react';
import type {OrderCheck,Receipt} from '@/lib/os-payments';
import type {PaymentAccount} from '@/lib/finance-model';
import {PAYMENT_METHOD_LABELS,PAYMENT_TYPE_LABELS,PAYMENT_LABELS,formatMoney} from '@/components/calendar/calendar-utils';
import type {PaymentMethod} from '@/components/calendar/calendar-types';
import {Button} from '@/components/ui/button';
const nowTaipei=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,16);
type Check=OrderCheck&{can_record:boolean;sheet_write_enabled:boolean;payment_accounts:PaymentAccount[];payment_status:keyof typeof PAYMENT_LABELS};
export function OsPaymentPanel({property,order,canRecord,onChange}:{property:string;order:string;canRecord:boolean;onChange:()=>void}){
 const locale=useIntlLocale(),t=useT(),money=(n:number)=>formatMoney(n,locale);
 const [check,setCheck]=useState<Check|null>(null),[error,setError]=useState(''),[reload,setReload]=useState(0);
 const [open,setOpen]=useState(false),[mode,setMode]=useState<'receipt'|'paid'>('receipt');
 const [amount,setAmount]=useState(''),[method,setMethod]=useState<PaymentMethod>('bank_transfer');
 const [account,setAccount]=useState(''),[accountName,setAccountName]=useState(''),[digits,setDigits]=useState('');
 const [at,setAt]=useState(nowTaipei),[note,setNote]=useState(''),[other,setOther]=useState(false),[confirmed,setConfirmed]=useState(false);
 const [busy,setBusy]=useState(false),[pending,setPending]=useState<Record<string,unknown>|null>(null),[success,setSuccess]=useState('');
 const [access,setAccess]=useState<'idle'|'checking'|'ready'|'error'>('idle');
 useEffect(()=>{const controller=new AbortController();fetch(`/api/v1/order-payments?property=${encodeURIComponent(property)}&order=${encodeURIComponent(order)}`,{cache:'no-store',signal:controller.signal}).then(async r=>{const data=await r.json();if(!r.ok)throw new Error(data.detail);setCheck(data);}).catch(e=>{if(e.name!=='AbortError')setError(e.message);});return ()=>controller.abort();},[property,order,reload]);
 const receipts=check?.ledger.receipts??[],pendingReceipt=receipts.find(r=>r.sheet_sync?.state==='pending');
 const roomReceived=Math.max((check?.finance_received??0)+receipts.filter(r=>r.payment_type!=='other'&&r.payment_method!=='ota').reduce((s,r)=>s+r.amount,0),receipts.filter(r=>r.payment_type!=='other').reduce((s,r)=>s+r.amount,0));
 const remaining=Math.max(0,Math.round(((check?.total??0)-roomReceived)*100)/100);
 const accounts=(check?.payment_accounts??[]).filter(a=>a.method===method),needsAccount=method==='bank_transfer'||method==='credit_card';
 async function submit(retry?:Receipt){
  if(!check)return;setBusy(true);setError('');setSuccess('');
  try{
   const input=retry?{property_id:property,order_id:order,action:'retry_sync',request_id:retry.request_id}:pending??{
    property_id:property,order_id:order,expected_version:check.ledger.version,source_version:check.source_version,request_id:crypto.randomUUID(),
    amount:mode==='paid'?0:Number(amount),payment_type:mode==='paid'?'full':other?'other':confirmed?'balance':'deposit',payment_method:mode==='paid'?'other':method,status_only:mode==='paid',
    received_at:mode==='paid'?new Date().toISOString():new Date(at+':00+08:00').toISOString(),note,settles_room:mode==='paid'||(!other&&confirmed),
    ...(mode==='receipt'&&needsAccount?(account?{payment_account_id:account}:{payment_account_name:accountName,payment_account_last_digits:digits}):{})
   };
   setPending(input);
   const r=await fetch('/api/v1/order-payments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),data=await r.json();
   if(!r.ok){if(r.status<500){setPending(null);if(r.status===409)setReload(v=>v+1);}throw new Error(data.detail);}
   if(!data.verified||(check.sheet_write_enabled&&!data.sheet_verified))throw new Error('主表同步結果尚未確認，請重試。');
   setPending(null);setOpen(false);setSuccess(check.sheet_write_enabled?'已登記，main sheet 已同步確認。':'付款已儲存並確認。');setReload(v=>v+1);onChange();
  }catch(e){setError(e instanceof Error?e.message:'連線中斷，請用原內容重試。');}finally{setBusy(false);}
 }
 async function checkAccess(){
  if(!check?.sheet_write_enabled){setAccess('ready');return;}
  setAccess('checking');setError('');
  try{const r=await fetch('/api/v1/order-payments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({property_id:property,action:'check_sheet_access'})}),data=await r.json();if(!r.ok||!data.verified)throw new Error(data.detail||'主表連線尚未確認。');setAccess('ready');}catch(e){setAccess('error');setError(e instanceof Error?e.message:'主表連線尚未確認。');}
 }
 function begin(){void checkAccess();setOpen(true);setMode('receipt');setAmount('');setMethod('bank_transfer');setAccount('');setAccountName('');setDigits('');setAt(nowTaipei());setNote('');setOther(false);setConfirmed(false);setSuccess('');setError('');}
 const field='mt-1 block w-full min-w-0 rounded border p-2';
 return <section className="space-y-3 rounded-xl border p-3" aria-label={t('OS 付款紀錄')}>
  <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{t('付款紀錄')}</h3>{check&&canRecord&&check.can_record&&!open&&!pendingReceipt&&<Button size="sm" onClick={begin}>{t('登記收款')}</Button>}</div>
  {error&&<p role="alert" className="text-sm text-red-700">{t(error)}</p>}{success&&<p role="status" className="text-sm text-green-700">{t(success)}</p>}
  {!check&&!error&&<p>{t('讀取付款紀錄…')}</p>}{!check&&error&&<Button variant="outline" onClick={()=>{setError('');setReload(v=>v+1);}}>{t('重新載入')}</Button>}
  {check&&<>
   <p className="text-sm">{t(PAYMENT_LABELS[check.payment_status])} · {t('整張訂單')} {check.rooms.join('、')} · {check.nights} {t('房晚')} · {t('房費')} {money(check.total)}</p>
   <p className="text-xs text-muted-foreground">{check.sheet_write_enabled?t('登記後同步 main sheet 的付款狀態及收款註記。'):t('付款紀錄保存在 OS。')}{t(' OTA 代收不代表已撥款到旅宿。')}</p>
   {check.source_paid&&<p className="text-xs text-muted-foreground">{t('主表已標記付清；若要補登明細，請確認沒有重複入帳。')}</p>}
   <p className="text-xs">{t('已登記房費：')}{money(roomReceived)}{t('／其他費用：')}{money(receipts.filter(r=>r.payment_type==='other').reduce((s,r)=>s+r.amount,0))}</p>
   {!!check.finance_received&&<p className="text-xs text-muted-foreground">{t('已包含財務登記的房費 ')}{money(check.finance_received)}{t('，請勿重複登記。')}</p>}
   {pendingReceipt&&!open&&<div className="space-y-2 rounded-lg bg-amber-50 p-3 text-sm"><p>{t('這筆付款已保存在 OS，main sheet 尚待同步。')}</p>{canRecord&&check.can_record&&<Button variant="outline" disabled={busy} onClick={()=>void submit(pendingReceipt)}>{busy?t('確認同步中…'):t('繼續同步主表')}</Button>}</div>}
   {open&&<form className="space-y-3 border-t pt-3" onSubmit={e=>{e.preventDefault();void submit();}}>
    <fieldset disabled={busy||!!pending} className="space-y-3 disabled:opacity-60"><legend className="sr-only">{t('登記收款')}</legend>
     <div className="grid grid-cols-2 gap-2">{(['receipt','paid'] as const).map(value=><label key={value} className={`rounded-lg border p-3 text-sm ${mode===value?'border-primary bg-primary/5':''}`}><input type="radio" name="payment-mode" value={value} checked={mode===value} onChange={()=>setMode(value)} className="mr-2" />{t(value==='receipt'?'登記本次收款':'直接標示已付清')}</label>)}</div>
     {mode==='paid'?<p className="rounded-lg bg-muted p-3 text-sm">{t('確認整張訂單、所有房晚都已付清。只更新付款狀態，不新增收款金額。')}</p>:<>
      <label className="block text-sm">{t('本次收到多少（元）')}<input required type="number" min="0.01" max="10000000" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} className={field} /></label>
      {!check.source_paid&&!other&&remaining>0&&<button type="button" className="text-sm text-primary underline" onClick={()=>{setAmount(String(remaining));setConfirmed(true);}}>{t('填入尚未登記的房費 ')}{money(remaining)}</button>}
      <div className="grid gap-3 sm:grid-cols-2">
       <label className="block text-sm">{t('收款方式')}<select value={method} onChange={e=>{setMethod(e.target.value as PaymentMethod);setAccount('');setDigits('');}} className={field}>{Object.entries(PAYMENT_METHOD_LABELS).map(([k,v])=><option key={k} value={k}>{t(v)}</option>)}</select></label>
       {needsAccount&&<label className="block text-sm">{t('收款帳戶')}<select value={account} onChange={e=>setAccount(e.target.value)} className={field}><option value="">{t('輸入其他帳戶')}</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name} · {a.last_digits}</option>)}</select></label>}
      </div>
      {needsAccount&&!account&&<div className="grid gap-3 sm:grid-cols-2"><label className="block text-sm">{t('帳戶名稱')}<input required maxLength={50} value={accountName} onChange={e=>setAccountName(e.target.value)} placeholder={t('例如：收款銀行')} className={field} /></label><label className="block text-sm">{t(method==='credit_card'?'帳號末四碼':'帳號末五碼')}<input required inputMode="numeric" pattern={method==='credit_card'?'[0-9]{4}':'[0-9]{5}'} maxLength={method==='credit_card'?4:5} value={digits} onChange={e=>setDigits(e.target.value.replace(/\D/g,''))} className={field} /></label></div>}
      <label className="block text-sm">{t('收款時間（台灣時間）')}<input required type="datetime-local" value={at} onChange={e=>setAt(e.target.value)} className={field} /></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={other} onChange={e=>{setOther(e.target.checked);setConfirmed(false);}} />{t('這是其他費用，不計入房費')}</label>
      {!other&&<label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} />{t('本次收款後，整張訂單的房費已付清（含之前付款）')}</label>}
     </>}
     <label className="block text-sm">{t('備註（選填）')}<input maxLength={500} value={note} onChange={e=>setNote(e.target.value)} className={field} /></label>
    </fieldset>
    {access==='checking'&&<p className="text-xs text-muted-foreground">{t('確認主表連線中…')}</p>}{access==='ready'&&check.sheet_write_enabled&&<p className="text-xs text-green-700">{t('main sheet 連線正常')}</p>}{access==='error'&&<Button type="button" variant="outline" onClick={()=>void checkAccess()}>{t('重新檢查主表連線')}</Button>}
    <div className="flex flex-wrap gap-2"><Button disabled={busy||(!pending&&access!=='ready')} type="submit">{busy?t('儲存並核對中…'):pending?t('重試並確認原登記'):t(check.sheet_write_enabled?'確認並同步主表':'確認登記')}</Button>{!pending&&<Button type="button" variant="outline" disabled={busy} onClick={()=>setOpen(false)}>{t('取消')}</Button>}</div>
    {pending&&!busy&&<p className="text-xs">{t('重試會核對同一筆紀錄，不會重複收款。')}</p>}
   </form>}
   {!receipts.length&&<p className="text-sm text-muted-foreground">{t('尚無收款明細。')}</p>}
   <ul className="divide-y">{[...receipts].reverse().map(r=><li key={r.id} className="space-y-1 py-2 text-sm"><div className="font-medium">{r.status_only?t('已確認房費付清'):t(PAYMENT_TYPE_LABELS[r.payment_type])+' '+money(r.amount)+' · '+t(PAYMENT_METHOD_LABELS[r.payment_method])}</div>{r.payment_account&&<p>{r.payment_account.name} · {t('末碼')} {r.payment_account.last_digits}</p>}<div className="text-xs text-muted-foreground">{new Date(r.received_at).toLocaleString(locale,{timeZone:'Asia/Taipei',hour12:false})} · {r.actor_name}</div>{r.sheet_sync&&<p className={r.sheet_sync.state==='verified'?'text-xs text-green-700':'text-xs text-amber-700'}>{t(r.sheet_sync.state==='verified'?'main sheet 已同步':'main sheet 待同步')}</p>}{r.note&&<p className="whitespace-pre-wrap break-words">{r.note}</p>}</li>)}</ul>
  </>}
 </section>;
}
