"use client";
import { useEffect, useState } from 'react';
import type { OrderCheck } from '@/lib/os-payments';
import { PAYMENT_METHOD_LABELS, PAYMENT_TYPE_LABELS, PAYMENT_LABELS, formatMoney } from '@/components/calendar/calendar-utils';
import type { PaymentMethod, PaymentType } from '@/components/calendar/calendar-types';
import { Button } from '@/components/ui/button';
const nowTaipei=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,16);
type Check = OrderCheck & {can_record:boolean;payment_status:keyof typeof PAYMENT_LABELS};
export function OsPaymentPanel({property,order,canRecord,onChange}:{property:string;order:string;canRecord:boolean;onChange:()=>void}) {
  const [check,setCheck]=useState<Check|null>(null),[error,setError]=useState(''),[reload,setReload]=useState(0);
  const [type,setType]=useState<PaymentType|null>(null),[amount,setAmount]=useState(''),[method,setMethod]=useState<PaymentMethod>('bank_transfer');
  const [at,setAt]=useState(nowTaipei),[note,setNote]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[pending,setPending]=useState<Record<string,unknown>|null>(null),[success,setSuccess]=useState('');
  useEffect(()=>{const controller=new AbortController();fetch(`/api/v1/order-payments?property=${encodeURIComponent(property)}&order=${encodeURIComponent(order)}`,{cache:'no-store',signal:controller.signal}).then(async r=>{const data=await r.json();if(!r.ok)throw new Error(data.detail);setCheck(data);setError('');}).catch(e=>{if(e.name!=='AbortError')setError(e.message);});return ()=>controller.abort();},[property,order,reload]);
  async function save(){if(!check||!type)return;setBusy(true);setError('');
    const input=pending??{property_id:property,order_id:order,expected_version:check.ledger.version,source_version:check.source_version,request_id:crypto.randomUUID(),amount:Number(amount),payment_type:type,payment_method:method,received_at:new Date(at+':00+08:00').toISOString(),note,settles_room:(type==='balance'||type==='full')&&confirmed};
    setPending(input);
    try{const r=await fetch('/api/v1/order-payments',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});const data=await r.json();if(!r.ok){if(r.status<500){setPending(null);if(r.status===409){setCheck(null);setReload(v=>v+1);}}throw new Error(data.detail);}
      if(!data.verified)throw new Error('儲存結果尚未確認，請重試。');
      setPending(null);setType(null);setSuccess('付款已儲存並確認。');setReload(v=>v+1);onChange();
    }catch(e){setError(e instanceof Error?e.message:'連線中斷，請用原內容重試。');}finally{setBusy(false);}
  }
  return <section className="rounded-xl border p-3 space-y-3" aria-label="OS 付款紀錄">
    <h3 className="font-semibold">付款紀錄</h3>
    <p className="text-xs text-muted-foreground">存於 OS，不會被訂房表同步覆蓋。此處記錄客人付款，不代表 OTA 已撥款到旅宿。</p>
    {error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
    {success&&<p role="status" className="text-sm text-green-700">{success}</p>}
    {!check&&!error&&<p>讀取付款紀錄…</p>}
    {!check&&error&&<Button variant="outline" onClick={()=>setReload(v=>v+1)}>重新載入</Button>}
    {check&&<>
      <p className="text-sm">{PAYMENT_LABELS[check.payment_status]} · 整張訂單 {check.rooms.join('、')} · {check.nights} 房晚 · 房費 {formatMoney(check.total)}</p>
      {check.source_paid&&<p className="text-xs text-muted-foreground">訂房表已標記付清，歷史收款金額與時間尚未提供。</p>}
      <p className="text-xs">OS 已登記房費：{formatMoney(check.ledger.receipts.filter(r=>r.payment_type!=='other').reduce((s,r)=>s+r.amount,0))} ／ 其他費用：{formatMoney(check.ledger.receipts.filter(r=>r.payment_type==='other').reduce((s,r)=>s+r.amount,0))}</p>
      {!!check.finance_received&&<p className="text-xs">財務已登記房費：{formatMoney(check.finance_received)}（已計入付款狀態，請勿重複登記）</p>}
      {canRecord&&check.can_record&&!type&&<div className="flex flex-wrap gap-2">{(['deposit','balance','other','full'] as PaymentType[]).map(t=><Button key={t} size="sm" variant="outline" onClick={()=>{setType(t);setAmount(t==='full'?String(Math.max(0,Math.round((check.total-(check.finance_received??0)-check.ledger.receipts.filter(r=>r.payment_type!=='other').reduce((s,r)=>s+r.amount,0))*100)/100)):'');setAt(nowTaipei());setNote('');setConfirmed(false);setSuccess('');}}>登記{PAYMENT_TYPE_LABELS[t]}</Button>)}</div>}
      {type&&<form className="space-y-3 border-t pt-3" onSubmit={e=>{e.preventDefault();void save();}}>
        <h4 className="font-medium">登記{PAYMENT_TYPE_LABELS[type]}</h4>
        <fieldset disabled={busy||!!pending} className="space-y-3 disabled:opacity-60">
          <label className="block text-sm">本次實收金額（元）<input required type="number" min="0.01" max="10000000" step="0.01" value={amount} onChange={e=>setAmount(e.target.value)} className="mt-1 block w-full rounded border p-2" /></label>
          <label className="block text-sm">付款方式<select value={method} onChange={e=>setMethod(e.target.value as PaymentMethod)} className="mt-1 block w-full rounded border p-2">{Object.entries(PAYMENT_METHOD_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
          <label className="block text-sm">收款日期與時間（台灣時間）<input required type="datetime-local" value={at} onChange={e=>setAt(e.target.value)} className="mt-1 block w-full min-w-0 rounded border p-2" /></label>
          <label className="block text-sm">備註<input maxLength={500} value={note} onChange={e=>setNote(e.target.value)} className="mt-1 block w-full rounded border p-2" /></label>
          {(type==='balance'||type==='full')&&<label className="flex gap-2 text-sm"><input required type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} />確認這張訂單所有房間、所有晚數的房費已付清（含之前付款）。</label>}
          {type==='other'&&<p className="text-xs">其他費用獨立記錄，不會把房費改成已付清。</p>}
        </fieldset>
        <div className="flex gap-2"><Button disabled={busy} type="submit">{busy?'確認儲存中…':pending?'重試並確認原付款':'確認登記'}</Button>{!pending&&<Button type="button" variant="outline" disabled={busy} onClick={()=>setType(null)}>取消</Button>}</div>
        {pending&&!busy&&<p className="text-xs">結果尚未確認，重試會核對原付款，不會重複登記。</p>}
      </form>}
      {!check.ledger.receipts.length&&<p className="text-sm text-muted-foreground">OS 尚無付款明細。</p>}
      <ul className="divide-y">{[...check.ledger.receipts].reverse().map(r=><li key={r.id} className="py-2 text-sm">
        <div className="font-medium">{PAYMENT_TYPE_LABELS[r.payment_type]} {formatMoney(r.amount)} · {PAYMENT_METHOD_LABELS[r.payment_method]}</div>
        <div>收款 {new Date(r.received_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})}</div>
        <div className="text-xs text-muted-foreground">{r.actor_name} 登記於 {new Date(r.created_at).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false})}</div>
        {r.note&&<p className="whitespace-pre-wrap break-words">{r.note}</p>}
      </li>)}</ul>
    </>}
  </section>;
}
