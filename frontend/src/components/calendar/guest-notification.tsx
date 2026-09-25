"use client";
import {createContext,useContext,useEffect,useState,useCallback,type ReactNode} from 'react';
import {useAccessControl} from '@/lib/access-control';
import {useT,useIntlLocale} from '@/components/i18n/language-provider';
import type {NotificationState} from '@/lib/guest-notification';
import type {CalendarBooking} from './calendar-types';
type PropertyState={states:Record<string,NotificationState>;can_write:boolean};
const Context=createContext<{data:Record<string,PropertyState>;errors:Record<string,string>;busy:Record<string,boolean>;toggle:(b:CalendarBooking)=>Promise<void>;refresh:(p:string)=>Promise<void>}>({data:{},errors:{},busy:{},toggle:async()=>{},refresh:async()=>{}});
export function GuestNotificationProvider({children}:{children:ReactNode}){
 const member=useAccessControl(s=>s.membership),[data,setData]=useState<Record<string,PropertyState>>({}),[errors,setErrors]=useState<Record<string,string>>({}),[busy,setBusy]=useState<Record<string,boolean>>({});
 const properties=(member?.allProperties?['sweetfun','offland']:member?.propertyIds??[]).join(',');
 const refresh=useCallback(async(property:string)=>{
  try{const r=await fetch(`/api/v1/guest-notification?property=${encodeURIComponent(property)}`,{cache:'no-store'});if(!r.ok)throw Error();const value=await r.json();setData(d=>{const states={...value.states};for(const [id,state] of Object.entries(d[property]?.states??{})){if(state.version>(states[id]?.version??0))states[id]=state;}return {...d,[property]:{...value,states}};});setErrors(e=>Object.fromEntries(Object.entries(e).filter(([k])=>k!==property&&!k.startsWith(property+':'))));}
  catch{setErrors(e=>({...e,[property]:'通知狀態讀取失敗，點此重試'}));}
 },[]);
 useEffect(()=>{const load=()=>{for(const p of properties.split(',').filter(Boolean))void refresh(p);};load();window.addEventListener('focus',load);const timer=setInterval(load,60000);return()=>{window.removeEventListener('focus',load);clearInterval(timer);};},[properties,refresh]);
 async function toggle(booking:CalendarBooking){
  const property=booking.property_id,key=`${property}:${booking.order_id}`,previous=data[property]?.states[booking.order_id];
  if(busy[key]||!data[property]?.can_write)return;
  setBusy(b=>({...b,[key]:true}));setErrors(e=>({...e,[key]:''}));
  try{const r=await fetch('/api/v1/guest-notification',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({property_id:property,order_id:booking.order_id,notified:!previous?.notified,expected_version:previous?.version??0,request_id:crypto.randomUUID()})});if(!r.ok)throw Error(r.status===409?'狀態已被更新，請重新確認':'儲存未確認，請重試');const value=await r.json();setData(d=>({...d,[property]:{...d[property],states:{...d[property].states,[booking.order_id]:value.state}}}));}
  catch(error){await refresh(property);setErrors(e=>({...e,[key]:error instanceof Error?error.message:'儲存未確認，請重試'}));}
  finally{setBusy(b=>({...b,[key]:false}));}
 }
 return <Context.Provider value={{data,errors,busy,toggle,refresh}}>{children}</Context.Provider>;
}
export function GuestNotificationButton({booking,detail=false}:{booking:CalendarBooking;detail?:boolean}){
 const {data,errors,busy,toggle,refresh}=useContext(Context),t=useT(),locale=useIntlLocale();
 const preview=useAccessControl(s=>s.previewRole),property=booking.property_id,key=`${property}:${booking.order_id}`,state=data[property]?.states[booking.order_id];
 const editable=data[property]?.can_write&&!['viewer','viewer_no_price'].includes(preview??'');
 const error=errors[property]||errors[key],loading=!data[property],saving=busy[key];
 return <span className={detail?'block rounded-lg border p-3':'ml-auto flex shrink-0 flex-col items-end gap-1'} onClick={e=>e.stopPropagation()}>
  <button type="button" aria-pressed={Boolean(state?.notified)} disabled={saving||(!error&&(loading||!editable||booking.reservation_status==='cancelled'))} onClick={()=>error?void refresh(property):void toggle(booking)} title={t(state?.notified?'撤回已通知標記':'僅標記已通知，不會發送訊息')} className="min-h-10 rounded-md border border-current/20 bg-white/70 px-2 text-xs font-medium text-slate-800 disabled:opacity-60">
   {t(error?'重新整理':saving?'儲存中…':loading?'讀取中…':state?.notified?'✅ 已通知':'尚未通知')}
  </button>
  {error&&<span role="alert" className="max-w-32 text-xs text-red-700">{t(error)}</span>}
  {detail&&<span className="mt-2 block text-xs text-muted-foreground">{t('僅標記已通知，不會發送訊息')}{state&&<span className="mt-1 block">{state.actor_name} · {new Date(state.at).toLocaleString(locale)}</span>}</span>}
 </span>;
}
