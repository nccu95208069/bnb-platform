"use client";
import {useEffect,useState} from 'react';
import {Dialog,DialogContent,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {useT,useIntlLocale} from '@/components/i18n/language-provider';
import {METHODS,taipeiDate,type FinanceReport,type FinanceOrder} from '@/lib/finance-model';
import {useFinanceSave} from './use-finance-save';
export function SummaryReceipt({property,orderId,onClose,onSaved}:{property:string;orderId:string;onClose:()=>void;onSaved:()=>void}){
 const t=useT();const [report,setReport]=useState<FinanceReport|null>(null),[error,setError]=useState('');
 useEffect(()=>{const abort=new AbortController();fetch(`/api/v1/finance?property=${encodeURIComponent(property)}&year=${taipeiDate().slice(0,4)}`,{cache:'no-store',signal:abort.signal}).then(async r=>{if(!r.ok)throw Error();return r.json();}).then(r=>{if(!abort.signal.aborted)setReport(r);}).catch(()=>{if(!abort.signal.aborted)setError('暫時無法讀取訂單，請關閉後重試。');});return()=>abort.abort();},[property]);
 const order=report?.orders.find(o=>o.id===orderId);
 if(report&&order&&order.receivable>0)return <ReceiptForm report={report} order={order} onClose={onClose} onSaved={onSaved}/>;
 return <Dialog open onOpenChange={open=>!open&&onClose()}><DialogContent><DialogTitle>{t('登記收款')}</DialogTitle><DialogDescription>{t(error||(!report?'正在核對訂單…':'這筆訂單目前無法登記更多房費，請到訂單詳情核對。'))}</DialogDescription></DialogContent></Dialog>;
}
function ReceiptForm({report,order,onClose,onSaved}:{report:FinanceReport;order:FinanceOrder;onClose:()=>void;onSaved:()=>void}){
 const locale=useIntlLocale();
 const money=(cents:number)=>new Intl.NumberFormat(locale,{style:'currency',currency:'TWD',maximumFractionDigits:cents%100?2:0}).format(cents/100);
 const t=useT(),{save,busy,error,pending}=useFinanceSave(report,onSaved);
 const [amount,setAmount]=useState(()=>String(order.receivable/100)),[date,setDate]=useState(taipeiDate()),[method,setMethod]=useState('bank_transfer'),[note,setNote]=useState('');
 const input='mt-1 w-full rounded-lg border bg-white px-3 py-2.5';
 return <Dialog open onOpenChange={open=>!open&&!busy&&!pending&&onClose()}><DialogContent showCloseButton={!busy&&!pending}><DialogTitle>{t('登記收款')}</DialogTitle><DialogDescription>{order.rooms.join('、')} · {order.check_in.replaceAll('-','/')} → {order.check_out.replaceAll('-','/')}<br/>{t('只登記旅宿實際收到的款項，請款申請不算收款。')}</DialogDescription>
 <p className="text-sm text-slate-600">{t('整筆訂單房費')} {money(order.total)}{order.received>0&&<> · {t('已登記收款')} {money(order.received)}</>}</p>
 <p className="text-xs text-slate-500">{t('依訂房表房費帶入，已扣除 OS 登記收款；可按實際收到的金額修改。')}</p>
 <form className="space-y-4" onSubmit={e=>{e.preventDefault();void save({action:'create',kind:'income',category:'lodging',platform:order.platform,amount:Number(amount),date,year:Number(date.slice(0,4)),method,description:note.trim()||t('住宿收入'),allocations:[{order_id:order.id,amount_cents:Math.round(Number(amount)*100)}]});}}>
 <fieldset disabled={busy||!!pending} className="space-y-4"><label className="block text-sm">{t('本次收款金額')}<input autoFocus required inputMode="decimal" type="number" min="0.01" max={order.receivable/100} step="0.01" className={input} value={amount} onChange={e=>setAmount(e.target.value)}/></label><div className="grid grid-cols-2 gap-3"><label className="min-w-0 text-sm">{t('收款日期')}<input required type="date" min="2020-01-01" max={taipeiDate()} className={input} value={date} onChange={e=>setDate(e.target.value)}/></label><label className="min-w-0 text-sm">{t('付款方式')}<select className={input} value={method} onChange={e=>setMethod(e.target.value)}>{Object.entries(METHODS).filter(([k])=>k!=='ota').map(([k,v])=><option key={k} value={k}>{t(v)}</option>)}</select></label></div><label className="block text-sm">{t('備註（選填）')}<input maxLength={500} className={input} value={note} onChange={e=>setNote(e.target.value)}/></label></fieldset>
 {error&&<p role="alert" className="text-sm text-red-700">{t(error)}</p>}<p className="text-xs text-slate-500">{t('收款會存入 OS；目前不修改主表。')}</p><button disabled={busy} className="w-full rounded-lg bg-slate-800 px-4 py-3 font-medium text-white disabled:opacity-50" type="submit">{t(busy?'儲存中…':pending?'重試原紀錄':'確認收款')}</button></form>
 </DialogContent></Dialog>;
}
