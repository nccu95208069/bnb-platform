import {redisCommand} from '../workspace-auth/store.ts';
import {isLocale,type Locale} from './core.ts';
export const languageKey=(id:string)=>`sweetfun-os:language:v1:${encodeURIComponent(id)}`;
export async function readLanguage(id:string):Promise<Locale>{const value=await redisCommand(['GET',languageKey(id)]);if(value===null)return 'zh-TW';if(!isLocale(value))throw new Error('LANGUAGE_UNAVAILABLE');return value;}
export async function saveLanguage(id:string,locale:Locale){if(!isLocale(locale))throw new Error('INVALID_LOCALE');await redisCommand(['SET',languageKey(id),locale]);if(await readLanguage(id)!==locale)throw new Error('LANGUAGE_UNCONFIRMED');return locale;}
