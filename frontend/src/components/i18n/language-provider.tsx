"use client";
import {createContext,useContext,useState,useEffect,useCallback,useRef,type ReactNode} from 'react';
import {usePathname} from 'next/navigation';
import {isLocale,translate,intlLocale,type Locale} from '@/lib/i18n/core';
const KEY='sweetfun-language-v1';
type Language={locale:Locale;scope:'loading'|'account'|'device'|'error';saving:boolean;error:boolean;save:(locale:Locale)=>Promise<void>};
const Context=createContext<Language>({locale:'zh-TW',scope:'loading',saving:false,error:false,save:async()=>{}});
export function LanguageProvider({children,initialLocale}:{children:ReactNode;initialLocale:Locale}){
 const [locale,setLocale]=useState<Locale>(initialLocale),[scope,setScope]=useState<Language['scope']>('loading'),[saving,setSaving]=useState(false),[error,setError]=useState(false);const path=usePathname(),serial=useRef(0),busy=useRef(false);
 const apply=useCallback((next:Locale)=>{setLocale(next);document.documentElement.lang=next;document.cookie=`sweetfun-language=${next}; Path=/; Max-Age=2592000; SameSite=Lax${location.protocol==='https:'?'; Secure':''}`;},[]);
 useEffect(()=>{let dead=false;async function load(){if(busy.current)return;const ticket=++serial.current;try{const r=await fetch('/api/account-language',{cache:'no-store',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error();const d=await r.json();if(dead||ticket!==serial.current)return;if(d.scope==='account'&&isLocale(d.locale)){apply(d.locale);setScope('account');}else if(d.scope==='device'){let stored;try{stored=localStorage.getItem(KEY);}catch{}apply(isLocale(stored)?stored:initialLocale);setScope('device');}else throw Error();setError(false);}catch{if(!dead&&ticket===serial.current){setScope('error');setError(true);}}}void load();window.addEventListener('focus',load);return()=>{dead=true;window.removeEventListener('focus',load);};},[path,apply,initialLocale]);
 async function save(next:Locale){if(busy.current||!isLocale(next)||scope==='loading')return;busy.current=true;++serial.current;setSaving(true);setError(false);try{if(scope!=='device'){const r=await fetch('/api/account-language',{method:'PUT',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify({locale:next})});const d=await r.json();if(!r.ok||!d.verified||d.locale!==next)throw Error();setScope('account');}else{localStorage.setItem(KEY,next);if(localStorage.getItem(KEY)!==next)throw Error();}apply(next);}catch{setError(true);}finally{busy.current=false;setSaving(false);}}
 return <Context.Provider value={{locale,scope,saving,error,save}}>{children}</Context.Provider>;
}
export const useLanguage=()=>useContext(Context);
export function useT(){const {locale}=useLanguage();return useCallback(<Value,>(value:Value,values:unknown[]=[]):Value=>typeof value==='string'?translate(locale,value,values) as Value:value,[locale]);}
export function useIntlLocale(){return intlLocale(useLanguage().locale);}
// Only authored interface text is passed here. Guest/account names and free text
// remain ordinary React children and never enter the translation catalog.
export function T({children}:{children:ReactNode}){const t=useT();return <>{typeof children==='string'?t(children):children}</>;}
