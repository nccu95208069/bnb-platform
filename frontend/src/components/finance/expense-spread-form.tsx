"use client";
import {useState} from 'react';
import {useT,useIntlLocale} from '@/components/i18n/language-provider';
import {spreadMonths,equalSpread,type ExpenseShare} from '@/lib/expense-spread';
export function useExpenseSpread(amount:string,date:string,initial?:ExpenseShare[]){
 const [enabled,setEnabled]=useState(!!initial?.length),[start,setStart]=useState(initial?.[0]?.month??date.slice(0,7)),[end,setEnd]=useState(initial?.at(-1)?.month??date.slice(0,7)),[custom,setCustom]=useState(!!initial?.length),[values,setValues]=useState<Record<string,string>>(Object.fromEntries((initial??[]).map(r=>[r.month,String(r.amount_cents/100)])));
 const [multi,setMulti]=useState((initial?.length??0)>1);
 const months=spreadMonths(start,multi?end:start),equal=equalSpread(Math.round(Number(amount)*100),months);
 const rows=custom&&multi?months.map(month=>({month,amount_cents:Math.round(Number(values[month]??'')*100)})):equal;
 const valid=!enabled||(rows.length>=1&&rows.every(r=>Number.isSafeInteger(r.amount_cents)&&r.amount_cents>=0)&&(!custom||!multi||months.every(m=>values[m]?.trim()!==''))&&rows.reduce((s,r)=>s+r.amount_cents,0)===Math.round(Number(amount)*100)&&Number(amount)>0);
 return {multi,setMulti,enabled,setEnabled,start,setStart,end,setEnd,custom,setCustom,values,setValues,rows,equal,valid};
}
export function ExpenseSpreadForm({state}:{state:ReturnType<typeof useExpenseSpread>}){
 const t=useT(),locale=useIntlLocale(),s=state;
 const money=(n:number)=>new Intl.NumberFormat(locale,{style:'currency',currency:'TWD',maximumFractionDigits:2}).format(n/100);
 return <div className="rounded-lg border p-3 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={s.enabled} onChange={e=>s.setEnabled(e.target.checked)}/>{t('指定費用歸屬月份（選填）')}</label>{s.enabled&&<div className="mt-3 space-y-3"><p className="text-xs text-slate-500">{t('費用按歸屬月份統計，付款日期與登記時間不變。')}</p><label className="block">{t(s.multi?'起始月份':'費用歸屬月份')}<input required type="month" min="2020-01" max="2099-12" className="mt-1 w-full min-w-0 rounded border p-2" value={s.start} onChange={e=>{s.setStart(e.target.value);s.setCustom(false);}}/></label><label className="flex items-center gap-2"><input type="checkbox" checked={s.multi} onChange={e=>{s.setMulti(e.target.checked);s.setCustom(false);}}/>{t('分攤到多個月份')}</label>{s.multi&&<><label className="block">{t('結束月份')}<input required type="month" min={s.start} max="2099-12" className="mt-1 w-full min-w-0 rounded border p-2" value={s.end} onChange={e=>{s.setEnd(e.target.value);s.setCustom(false);}}/></label><button type="button" className="text-teal-800 underline" onClick={()=>{s.setValues(Object.fromEntries(s.equal.map(r=>[r.month,String(r.amount_cents/100)])));s.setCustom(!s.custom);}}>{t(s.custom?'恢復平均分攤':'自行調整金額')}</button></>}<div className="max-h-44 space-y-2 overflow-y-auto">{s.rows.map(r=><div key={r.month} className="flex items-center justify-between gap-3"><span>{r.month.replace('-','/')}</span>{s.custom&&s.multi?<input aria-label={`${t('分攤金額')} ${r.month}`} required type="number" min="0" step="0.01" className="w-32 rounded border p-2" value={s.values[r.month]??''} onChange={e=>s.setValues({...s.values,[r.month]:e.target.value})}/>:<span>{money(r.amount_cents)}</span>}</div>)}</div>{!s.valid&&<p role="alert" className="text-xs text-amber-800">{t('請確認歸屬月份，分攤合計須等於費用金額。')}</p>}</div>}</div>;

}
export function ExpenseSpreadDetail({rows}:{rows:ExpenseShare[]}){const t=useT(),locale=useIntlLocale();return <div className="rounded border p-3"><p className="mb-2 font-medium">{t('費用歸屬月份')}</p>{rows.map(r=><p key={r.month} className="flex justify-between"><span>{r.month.replace('-','/')}</span><span>{new Intl.NumberFormat(locale,{style:'currency',currency:'TWD'}).format(r.amount_cents/100)}</span></p>)}</div>;}
