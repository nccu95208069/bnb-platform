"use client";
import {useEffect,useState} from 'react';
import {useSearchParams} from 'next/navigation';
import Link from 'next/link';
import {categoryLabel,METHODS,taipeiDate,type FinanceEntry} from '@/lib/finance-model';

export function FinanceLegacyHistory(){
 const query=useSearchParams(),property=query.get('property')??'offland';
 const [year,setYear]=useState(Number(taipeiDate().slice(0,4))),[reload,setReload]=useState(0);
 const key=`${property}:${year}:${reload}`;
 const [result,setResult]=useState<{key:string;entries:FinanceEntry[];error:string}|null>(null);
 useEffect(()=>{const controller=new AbortController();
  fetch(`/api/v1/finance/legacy?property=${encodeURIComponent(property)}&year=${year}`,{cache:'no-store',signal:controller.signal})
   .then(async response=>{const data=await response.json();if(!response.ok)throw Error(data.detail);
    if(!controller.signal.aborted)setResult({key,entries:data.entries,error:''});})
   .catch(error=>{if(!controller.signal.aborted)setResult({key,entries:[],error:error.message});});
  return()=>controller.abort();
 },[property,year,key]);
 const loaded=result?.key===key;
 return <main className="mx-auto max-w-4xl space-y-5 p-4">
  <Link className="text-sm underline" href={`/finance/bookkeeping?property=${encodeURIComponent(property)}`}>返回新帳本</Link>
  <h1 className="text-2xl font-semibold">OS 舊帳紀錄</h1>
  <p className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">這裡保留以前在 OS 登記的原始紀錄，只供查閱，尚未與新帳或 LINE 舊帳合併核對。</p>
  <div className="flex gap-3"><label>年度 <input aria-label="舊帳年度" className="w-24 rounded border p-2" type="number" min="2020" max="2100" value={year} onChange={event=>{const next=Number(event.target.value);if(Number.isInteger(next)&&next>=2020&&next<=2100)setYear(next);}}/></label>
   <button className="rounded border px-3" onClick={()=>setReload(value=>value+1)}>重新整理</button></div>
  {!loaded?<p role="status">讀取舊帳…</p>:result.error?<p role="alert">{result.error}</p>:
   result.entries.length?<ul className="divide-y rounded-xl border bg-white px-4">{result.entries.map(entry=><li key={entry.id} className="space-y-1 py-4">
    <p className="font-semibold">{entry.kind==='expense'?'支出':entry.kind==='refund'?'退款':'收入'} · {categoryLabel(entry)} · NT${(entry.amount_cents/100).toLocaleString('zh-TW')}</p>
    <p className="text-sm">{entry.date} · {METHODS[entry.method]} · {entry.status==='void'?'已作廢':'原始紀錄'}</p>
    <p className="whitespace-pre-wrap break-words text-sm">{entry.description}</p>
   </li>)}</ul>:<p>這個年度沒有 OS 舊帳紀錄；不代表沒有其他來源的收支。</p>}
 </main>;
}
