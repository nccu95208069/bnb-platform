"use client";
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {useRouter,useSearchParams} from 'next/navigation';
import {useT,useIntlLocale} from '@/components/i18n/language-provider';
import type {FinanceSummaryRow} from '@/lib/finance-summary';
import {PLATFORMS,METHODS} from '@/lib/finance-model';
type Report={property_id:string;properties:{id:string;name:string}[];orders:FinanceSummaryRow[];registry_version:number;source_version:string;retained_orders:number;source_issues:number;last_capture:string|null;updated_at:string};
export function FinanceSummary(){
 const t=useT(),locale=useIntlLocale(),query=useSearchParams(),router=useRouter();
 const property=query.get('property')??'';
 const [result,setResult]=useState<{key:string;data:Report}|null>(null),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false),[search,setSearch]=useState(''),[limit,setLimit]=useState(50);
 const requestKey=`${property}:${refresh}`,data=result?.key===requestKey?result.data:null;
 useEffect(()=>{const abort=new AbortController();fetch(`/api/v1/finance-summary?property=${encodeURIComponent(property)}`,{cache:'no-store',signal:abort.signal}).then(async r=>{if(!r.ok)throw Error(String(r.status));return r.json();}).then(data=>{if(!abort.signal.aborted){setResult({key:requestKey,data});setError('');}}).catch(()=>{if(!abort.signal.aborted)setError('財務摘要暫時無法讀取，請重新整理。');});return()=>abort.abort();},[property,requestKey]);
 const money=(v:number|null)=>v===null?t('待確認'):new Intl.NumberFormat(locale,{style:'currency',currency:'TWD'}).format(v/100);
 const amountLabel=(v:number)=>v>0?t('有紀錄，完整性待確認'):t('尚無紀錄');
 async function capture(){if(!data)return;setBusy(true);setError('');try{const r=await fetch(`/api/v1/finance-summary?property=${encodeURIComponent(data.property_id)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expected_version:data.registry_version,source_version:data.source_version})});if(!r.ok)throw Error(String(r.status));setRefresh(v=>v+1);}catch{setError('資料可能已變動，請重新整理後確認保存結果。');}finally{setBusy(false);}}
 const orders=data?.orders.filter(o=>`${o.id} ${o.platform} ${PLATFORMS[o.platform]??''} ${o.ota_ids.join(' ')} ${o.owl_ids.join(' ')} ${o.rooms.join(' ')} ${o.check_in}`.toLowerCase().includes(search.toLowerCase()))??[];
 const claimLabels={unknown:'待確認',not_applicable:'不適用',legacy_claimed:'舊表標記：已請款',legacy_unclaimed:'舊表標記：未請款'};
 return <main className="mx-auto max-w-7xl space-y-4 p-2 pb-10 text-slate-800">
 <header><Link href={`/finance?property=${encodeURIComponent(property)}`} className="text-sm underline">{t('財務首頁')}</Link><h1 className="mt-3 text-2xl font-semibold">{t('訂單財務摘要')}</h1><p className="mt-2 text-sm text-slate-600">{t('唯讀試行：付款、請款與入帳分開顯示；尚未寫回主表。')}</p></header>
 <div className="flex flex-wrap gap-2"><select aria-label={t('我的旅宿')} disabled={!data||busy} className="rounded-lg border p-2" value={data?.property_id??property} onChange={e=>router.push(`/finance/summary?property=${encodeURIComponent(e.target.value)}`)}>{data?.properties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><input aria-label={t('搜尋訂單')} placeholder={t('訂單編號、房間或入住日期')} className="min-w-0 flex-1 rounded-lg border p-2" value={search} onChange={e=>{setSearch(e.target.value);setLimit(50);}}/><button className="rounded-lg border px-3 py-2" disabled={busy} onClick={()=>setRefresh(v=>v+1)}>{t('重新整理')}</button><button className="rounded-lg bg-slate-800 px-3 py-2 text-white disabled:opacity-50" disabled={!data||busy} onClick={()=>void capture()}>{t('保存訂單對應')}</button></div>
 {error&&<p role="alert" className="rounded-lg bg-amber-50 p-3">{t(error)}</p>}
 {!data&&!error&&<p role="status">{t('載入中…')}</p>}
 {data&&<><p role="status" className="text-sm text-slate-600">{t('訂單數')} {orders.length} · {t('保留的歷史對應')} {data.retained_orders} · {t('來源問題')} {data.source_issues} · {t('版本')} {data.registry_version}</p><p className="text-xs text-slate-500">{t('上次保存')}：{data.last_capture?new Date(data.last_capture).toLocaleString(locale):t('尚無紀錄')} · {t('已記錄入帳不代表完整歷史收款；未知金額不以零代替。')}</p>
 <div className="space-y-3">{orders.slice(0,limit).map(o=><article key={o.id} className="rounded-xl border bg-white p-4"><div className="flex flex-wrap justify-between gap-2"><div><strong>{PLATFORMS[o.platform]??o.platform} · {o.rooms.join(', ')}</strong><p className="text-sm">{o.check_in} → {o.check_out}</p><p className="break-all text-xs text-slate-500">OTA: {o.ota_ids.join(', ')||'—'} · OwlNest: {o.owl_ids.join(', ')||'—'}</p></div><span className="text-xs text-slate-500">{t('來源房費')} {money(o.source_amount_cents)}</span></div>
 <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3"><div><dt className="text-slate-500">{t('客人付款')}</dt><dd>{amountLabel(o.ota_collected_cents+(o.platform==='direct'?o.recorded_received_cents:0))}</dd></div><div><dt className="text-slate-500">{t('平台請款')}</dt><dd>{t(claimLabels[o.claim])}</dd></div><div><dt className="text-slate-500">{t('旅宿入帳')}</dt><dd>{amountLabel(o.recorded_received_cents)}{o.recorded_received_cents>0&&` · ${money(o.recorded_received_cents)}`}</dd></div></dl>
 <p className="mt-3 text-xs text-slate-600">{t('確認應收總額')} {money(o.receivable_total_cents)} · {t('未入帳餘額')} {money(o.outstanding_cents)}</p>
 {(o.issues.includes('identity_conflict')||o.issues.includes('source_conflict'))&&<p className="mt-2 text-sm text-amber-800">{t('訂單對應有衝突，未自動合併或保存。')}</p>}
 <details className="mt-3 text-sm"><summary className="cursor-pointer">{t('紀錄與來源')}</summary><p className="mt-2 break-all text-xs">OS: {o.id}</p><p className="text-xs">{t('來源列數')} {o.row_ids.length} · {t('舊付款標記')} {o.legacy_status}</p>{o.records.length?<ul className="mt-2 space-y-1">{o.records.map(r=><li key={r.id}>{r.at} · {money(r.amount_cents)} · {t(METHODS[r.method as keyof typeof METHODS]??r.method)} · {r.actor} · {t(r.source==='calendar'?'日曆':'記帳')}</li>)}</ul>:<p>{t('尚無紀錄')}</p>}</details>
 </article>)}</div>{orders.length>limit&&<button className="rounded-lg border px-4 py-2" onClick={()=>setLimit(v=>v+50)}>{t('顯示更多')}</button>}{!orders.length&&<p>{t('沒有符合的訂單')}</p>}</>}
 </main>;
}
