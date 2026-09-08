"use client";
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {useRouter,useSearchParams} from 'next/navigation';
import {useT,useIntlLocale} from '@/components/i18n/language-provider';
import type {FinanceSummaryRow} from '@/lib/finance-summary';
import {PLATFORMS,METHODS,taipeiDate} from '@/lib/finance-model';
import {SummaryReceipt} from './summary-receipt';
type Report={property_id:string;properties:{id:string;name:string}[];orders:FinanceSummaryRow[];updated_at:string};
export function FinanceSummary(){
 const t=useT(),locale=useIntlLocale(),query=useSearchParams(),router=useRouter();
 const property=query.get('property')??'';
 const [result,setResult]=useState<{key:string;data:Report}|null>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[search,setSearch]=useState(''),[month,setMonth]=useState(taipeiDate().slice(0,7)),[limit,setLimit]=useState(30),[receipt,setReceipt]=useState<string|null>(null),[notice,setNotice]=useState('');
 const requestKey=`${property}:${refresh}`,data=result?.key===requestKey?result.data:null;
 useEffect(()=>{const abort=new AbortController();fetch(`/api/v1/finance-summary?property=${encodeURIComponent(property)}`,{cache:'no-store',signal:abort.signal}).then(async r=>{if(!r.ok)throw Error();return r.json();}).then(data=>{if(!abort.signal.aborted){setResult({key:requestKey,data});setError('');}}).catch(()=>{if(!abort.signal.aborted)setError('財務摘要暫時無法讀取，請重新整理。');});return()=>abort.abort();},[property,requestKey]);
 const money=(v:number|null)=>v===null?t('待確認'):new Intl.NumberFormat(locale,{style:'currency',currency:'TWD',maximumFractionDigits:v%100?2:0}).format(v/100);
 const orders=data?.orders.filter(o=>search.trim()?`${o.id} ${o.platform} ${PLATFORMS[o.platform]??''} ${o.ota_ids.join(' ')} ${o.owl_ids.join(' ')} ${o.rooms.join(' ')} ${o.check_in} ${o.check_in.replaceAll('-','/')}`.toLowerCase().includes(search.trim().toLowerCase()):o.check_in.startsWith(month))??[];
 return <main className="mx-auto max-w-6xl space-y-5 p-2 pb-10 text-slate-800">
 <header><Link href={`/finance?property=${encodeURIComponent(property)}`} className="text-sm text-slate-500 hover:underline">← {t('財務首頁')}</Link><h1 className="mt-3 text-2xl font-semibold">{t('訂單收款')}</h1></header>
 <div className="flex flex-wrap gap-2"><select aria-label={t('我的旅宿')} disabled={!data||!!receipt} className="min-w-0 rounded-lg border bg-white p-2.5" value={data?.property_id??property} onChange={e=>{setNotice('');router.push(`/finance/summary?property=${encodeURIComponent(e.target.value)}`);}}>{data?.properties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><input aria-label={t('入住月份')} type="month" className="min-w-0 rounded-lg border bg-white p-2.5" value={month} onChange={e=>{if(e.target.value){setMonth(e.target.value);setSearch('');setLimit(30);}}}/><button aria-label={t('重新整理')} className="rounded-lg border px-3" onClick={()=>setRefresh(v=>v+1)}>↻</button><input aria-label={t('搜尋全部訂單')} placeholder={t('搜尋全部訂單：編號、房間或日期')} className="min-w-0 basis-full rounded-lg border p-2.5 sm:flex-1 sm:basis-auto" value={search} onChange={e=>{setSearch(e.target.value);setLimit(30);}}/></div>
 {notice&&<p role="status" className="text-sm text-teal-800">{t(notice)}</p>}{error&&<p role="alert" className="rounded-lg bg-amber-50 p-3">{t(error)}</p>}
 {!data&&!error&&<p role="status">{t('載入中…')}</p>}
 {data&&<><div className="flex flex-wrap justify-between gap-2 text-xs text-slate-500"><span>{t('訂單數')} {orders.length}{search.trim()?` · ${t('搜尋全部月份')}`:''}</span><span>{t('已收僅列已登記款項；應收與未收尚未確認時顯示待確認。')}</span></div>
 <div className="space-y-3">{orders.slice(0,limit).map(o=>{
 const conflict=o.issues.some(v=>['identity_conflict','source_conflict','amount_invalid'].includes(v));
 return <article key={o.id} className="rounded-xl border bg-white p-4 sm:p-5"><div className="flex flex-wrap items-start justify-between gap-2"><div><h2 className="font-semibold">{t(PLATFORMS[o.platform]??o.platform)} · {o.rooms.join(', ')}</h2><p className="mt-1 text-sm text-slate-500">{o.check_in.replaceAll('-','/')} → {o.check_out.replaceAll('-','/')}</p></div>{o.platform==='agoda'&&<span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">{t(o.claim==='legacy_unclaimed'?'未請款':o.claim==='legacy_claimed'?'已請款':'請款待確認')}</span>}</div>
 <div className="mt-4 flex flex-wrap items-end gap-4"><dl className="grid min-w-0 flex-1 basis-full grid-cols-3 gap-2 sm:basis-auto">{[{label:'應收',value:money(o.receivable_total_cents)},{label:'已收',value:o.recorded_received_cents>0?money(o.recorded_received_cents):t('未登記')},{label:'未收',value:money(o.outstanding_cents)}].map(a=><div key={a.label}><dt className="text-xs text-slate-500">{t(a.label)}</dt><dd className="mt-1 break-words text-lg font-semibold tabular-nums">{a.value}</dd></div>)}</dl><button disabled={conflict} className="w-full rounded-lg bg-slate-800 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40 sm:w-auto" onClick={()=>setReceipt(o.id)}>{t('登記收款')}</button></div>
 {conflict&&<p className="mt-3 text-sm text-amber-800">{t('訂單資料需核對，暫時無法登記收款。')}</p>}
 <details className="mt-4 border-t pt-3 text-sm"><summary className="cursor-pointer text-slate-500">{t('查看明細')}</summary><div className="mt-3 space-y-2"><p className="break-all text-xs">OTA: {o.ota_ids.join(', ')||'—'} · OwlNest: {o.owl_ids.join(', ')||'—'}</p><p>{t('來源房費')} {money(o.source_amount_cents)} <span className="text-xs text-slate-500">{t('（尚未確認入帳計算基準）')}</span></p>{o.platform==='agoda'&&<p className="text-xs text-slate-500">{t('請款狀態沿用主表標記，不代表銀行已入帳。')}</p>}{o.ota_collected_cents>0&&<p>{t('OTA 代收')} {money(o.ota_collected_cents)}</p>}{o.records.length?<ul className="space-y-2">{o.records.map(r=><li key={r.id} className="text-xs">{r.at.replaceAll('-','/')} · {money(r.amount_cents)} · {t(METHODS[r.method as keyof typeof METHODS]??r.method)} · {r.actor}</li>)}</ul>:<p className="text-xs text-slate-500">{t('尚未登記收款，不代表客人未付款。')}</p>}</div></details>
 </article>;})}</div>{orders.length>limit&&<button className="rounded-lg border px-4 py-2" onClick={()=>setLimit(v=>v+30)}>{t('顯示更多')}</button>}{!orders.length&&<p className="py-10 text-center text-slate-500">{t('沒有符合的訂單')}</p>}</>}
 {receipt&&data&&<SummaryReceipt key={`${data.property_id}:${receipt}`} property={data.property_id} orderId={receipt} onClose={()=>setReceipt(null)} onSaved={()=>{setReceipt(null);setNotice('已儲存並確認。');setRefresh(v=>v+1);}}/>}
 </main>;
}
