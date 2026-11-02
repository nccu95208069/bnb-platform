'use client';
import {useIntlLocale} from "@/components/i18n/language-provider";
import {useT} from "@/components/i18n/language-provider";
import {useEffect,useState} from 'react';
type Device={id:string;userAgent:string;lastLoginAt:string;sessionExpiresAt:string};
export function LoginDevices({accountId}:{accountId?:string}){
const uiLocale = useIntlLocale();

  const uiText = useT();

 const [devices,setDevices]=useState<Device[]>([]),[current,setCurrent]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 useEffect(()=>{let active=true;fetch(`/api/account-devices${accountId?`?account=${encodeURIComponent(accountId)}`:''}`,{cache:'no-store'}).then(async r=>{const d=await r.json();if(!r.ok)throw new Error(d.detail);if(active){setDevices(d.devices);setCurrent(d.currentDeviceId);}}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[accountId]);
 return <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">{uiText("登入裝置紀錄")}</h2><p className="text-xs leading-5 text-muted-foreground">{uiText("登入保留 30 天。這裡記錄各瀏覽器的最近登入；清除瀏覽器資料或換瀏覽器會產生新的裝置 ID。")}</p>{loading?<p className="text-sm">{uiText("載入中…")}</p>:error?<p role="alert" className="text-sm">{uiText(error)}</p>:devices.length===0?<p className="text-sm">{uiText("尚無紀錄，下次登入時開始記錄。")}</p>:devices.map(d=><div key={d.id} className="space-y-1 border-t pt-3 text-xs"><p className="font-medium">{d.id===current?uiText("這個瀏覽器"):uiText("其他瀏覽器")}</p><p className="break-all text-muted-foreground">{d.userAgent}</p><p>{uiText("最近登入：")}{new Date(d.lastLoginAt).toLocaleString(uiLocale)}</p><p>{uiText("當次登入到期：")}{new Date(d.sessionExpiresAt).toLocaleString(uiLocale)}</p><p className="break-all font-mono">ID：{d.id}</p></div>)}</section>;
}
