import {messages} from './messages';
export const LOCALES=['zh-TW','en','th','vi'] as const;
export type Locale=typeof LOCALES[number];
export const isLocale=(v:unknown):v is Locale=>typeof v==='string'&&(LOCALES as readonly string[]).includes(v);
export const LOCALE_NAMES:Record<Locale,string>={'zh-TW':'繁體中文',en:'English',th:'ไทย',vi:'Tiếng Việt'};
export const intlLocale=(locale:Locale)=>locale==='th'?'th-TH-u-ca-gregory':locale==='vi'?'vi-VN':locale==='en'?'en-GB':'zh-TW';
export function translate(locale:Locale,value:string,values:unknown[]=[]):string{
 const interpolate=(s:string)=>s.replace(/\{(\d+)\}/g,(match,i)=>Number(i)<values.length?String(values[Number(i)]??''):match);
 if(locale==='zh-TW')return interpolate(value);
 const key=value.replace(/\s+/g,' ').trim();
 const entry=messages[key];if(entry)return interpolate(entry[locale]);
 if(!/[\u3400-\u9fff]/.test(key))return interpolate(value);
 for(const [pattern,entry] of Object.entries(messages)){
  if(!pattern.includes('{')||!/[\u3400-\u9fff]/.test(pattern.replace(/\{\d+\}/g,'')))continue;
  const indices:number[]=[];let regex='';let last=0;for(const m of pattern.matchAll(/\{(\d+)\}/g)){regex+=pattern.slice(last,m.index).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(.+?)';indices.push(Number(m[1]));last=m.index!+m[0].length;}regex+=pattern.slice(last).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const match=key.match(new RegExp('^'+regex+'$'));if(match)return entry[locale].replace(/\{(\d+)\}/g,(token,i)=>{const pos=indices.indexOf(Number(i));return pos>=0?match[pos+1]:token;});
 }
 return interpolate(value);
}
