"use client";
import {useEffect,useState} from 'react';
import Link from 'next/link';
import {useT,useIntlLocale} from '@/components/i18n/language-provider';
import {AUDIT_ACTIONS,type FinanceAuditEvent} from '@/lib/finance-audit';
import {taipeiDate} from '@/lib/finance-model';
type Report={properties:{id:string;name:string}[];property_id:string;total:number;page_size:number;events:FinanceAuditEvent[]};
const labels:Record<string,string>={amount_cents:'金額（分）',amount:'金額（元）',date:'付款日期',description:'說明',method:'付款方式',payment_method:'付款方式',payment_type:'收款類型',received_at:'收款日期',expense_spread:'費用歸屬月份',advanced_by:'代墊人',payment_account:'付款帳戶',category:'分類',category_name:'分類名稱',status:'狀態',void_reason:'作廢原因',allocations:'訂單分配',note:'備註',stage:'收款類型',platform:'預訂平台',name:'名稱',last_digits:'帳戶末碼',start:'開始日期',end:'結束日期',day:'日期',offset:'月份偏移',mode:'模式'};
export function FinanceAudit(){
 const t=useT(),locale=useIntlLocale();
 const [property,setProperty]=useState(''),[page,setPage]=useState(1),[action,setAction]=useState(''),[search,setSearch]=useState(''),[q,setQ]=useState(''),[refresh,setRefresh]=useState(0),[result,setResult]=useState<{key:string;data:Report}|null>(null),[error,setError]=useState('');
 const key=JSON.stringify([property,page,action,q,refresh]),data=result?.key===key?result.data:null;
 useEffect(()=>{const abort=new AbortController();const query=new URLSearchParams({property,year:taipeiDate().slice(0,4),audit:'1',page:String(page),action,q});fetch(`/api/v1/finance?${query}`,{cache:'no-store',signal:abort.signal}).then(async r=>{if(!r.ok)throw Error();return r.json();}).then(data=>{if(!abort.signal.aborted){setResult({key,data});setError('');}}).catch(()=>{if(!abort.signal.aborted)setError('紀錄暫時無法讀取，請重新整理。');});return()=>abort.abort();},[key,property,page,action,q]);
 const value=(v:unknown)=>v==null?'—':typeof v==='object'?JSON.stringify(v,null,2):String(v);
 return <main className="mx-auto max-w-5xl space-y-4 p-3 pb-12 text-slate-800">
 <Link className="text-sm underline" href="/finance">← {t('財務首頁')}</Link><h1 className="text-2xl font-semibold">{t('財務操作紀錄')}</h1>
 <p className="text-sm text-slate-500">{t('記錄成功的財務操作；歷史缺漏不會推測補填。')}</p>
 <form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();setPage(1);setQ(search.trim());}}>
 <select aria-label={t('我的旅宿')} value={property||data?.property_id||''} onChange={e=>{setProperty(e.target.value);setPage(1);}} className="min-w-0 rounded-lg border p-2">{result?.data.properties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
 <select aria-label={t('操作類型')} value={action} onChange={e=>{setAction(e.target.value);setPage(1);}} className="min-w-0 rounded-lg border p-2"><option value="">{t('全部操作')}</option>{Object.entries(AUDIT_ACTIONS).map(([k,v])=><option key={k} value={k}>{t(v)}</option>)}</select>
 <input aria-label={t('搜尋紀錄')} placeholder={t('搜尋帳號、日期或內容')} value={search} maxLength={200} onChange={e=>setSearch(e.target.value)} className="min-w-0 flex-1 rounded-lg border p-2"/><button className="rounded-lg border px-3">{t('搜尋')}</button><button type="button" className="rounded-lg border px-3" onClick={()=>setRefresh(v=>v+1)}>{t('重新整理')}</button></form>
 {error&&<p role="alert">{t(error)}</p>}{!data&&!error&&<p role="status">{t('載入中…')}</p>}
 {data&&<><p className="text-sm">{t('紀錄筆數')}：{data.total}</p>{data.events.map(e=><article key={`${e.source}:${e.id}`} className="space-y-2 rounded-xl border p-4">
 <div className="flex flex-wrap justify-between gap-2"><strong>{t(AUDIT_ACTIONS[e.action]??e.action)}</strong><time className="text-sm" dateTime={e.at}>{new Date(e.at).toLocaleString(locale,{timeZone:'Asia/Taipei',hour12:false})} UTC+8</time></div>
 <p className="break-words text-sm">{e.actor_name||e.actor_id} {e.actor_email?` · ${e.actor_email}`:''} · {t(e.source==='calendar'?'日曆':'財務')} · {t('已成功儲存')}</p>
 {e.completeness==='legacy_partial'&&<p className="text-sm text-amber-800">{t('歷史紀錄不完整：僅顯示當時有保存的資訊。')}</p>}
 <details><summary className="cursor-pointer text-sm">{t('查看變更內容')}</summary><div className="mt-2 space-y-3">{e.changed_fields.map(k=><div key={k} className="rounded-lg bg-slate-50 p-3 text-sm"><strong>{t(k==='amount_cents'?'金額（元）':labels[k]??k)}</strong><div className="mt-1 grid gap-2 sm:grid-cols-2"><div><span className="text-slate-500">{t('修改前')}</span><pre className="whitespace-pre-wrap break-all font-sans">{value(k==='amount_cents'&&typeof e.before?.[k]==='number'?Number(e.before[k])/100:e.before?.[k])}</pre></div><div><span className="text-slate-500">{t('修改後')}</span><pre className="whitespace-pre-wrap break-all font-sans">{value(k==='amount_cents'&&typeof e.after?.[k]==='number'?Number(e.after[k])/100:e.after?.[k])}</pre></div></div></div>)}{!e.changed_fields.length&&<p>{t('沒有保存完整的變更前後內容。')}</p>}</div></details>
 <details className="text-xs text-slate-500"><summary className="cursor-pointer">{t('追溯資訊')}</summary><dl className="space-y-1 break-all pt-2"><dt>{t('帳號 ID')}</dt><dd>{e.actor_id||'—'}</dd><dt>{t('角色')}</dt><dd>{e.actor_role||'—'}</dd><dt>{t('資料 ID')}</dt><dd>{e.target_id}</dd><dt>{t('請求 ID')}</dt><dd>{e.request_id}</dd><dt>{t('版本')}</dt><dd>{e.version_before??'—'} → {e.version_after??'—'}</dd></dl></details>
 </article>)}<div className="flex items-center justify-between"><button className="rounded-lg border p-2 disabled:opacity-40" disabled={page===1} onClick={()=>setPage(p=>p-1)}>{t('上一頁')}</button><span>{page} / {Math.max(1,Math.ceil(data.total/data.page_size))}</span><button className="rounded-lg border p-2 disabled:opacity-40" disabled={page*data.page_size>=data.total} onClick={()=>setPage(p=>p+1)}>{t('下一頁')}</button></div></>}
 </main>;
}
