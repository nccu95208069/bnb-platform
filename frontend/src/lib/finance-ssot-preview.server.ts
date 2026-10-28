import {createHmac,timingSafeEqual} from 'node:crypto';
import type {Principal} from './workspace-auth/types.ts';

export type ConfirmedFinancePreview={schema:1;actor_id:string;property_id:string;
  request_id:string;origin_hash:string;projection_version:string;
  action:string;expires_at:number;draft_command?:Record<string,unknown>;
  confirmed_command?:Record<string,unknown>;plan_command?:Record<string,unknown>;
  plan_suffix?:'accounts'|'recurring-rules'|'payout-rules';
  category?:{kind:'income'|'expense';code:string;label:string}};

function signature(encoded:string,secret:string){
  if(secret.length<32)throw Error('FINANCE_SSOT_UNAVAILABLE');
  return createHmac('sha256',secret).update(`os-finance-preview:v1:${encoded}`)
    .digest();
}

export function sealFinancePreview(claim:Omit<ConfirmedFinancePreview,'schema'|'expires_at'>,
  secret:string,now=Date.now()){
  const encoded=Buffer.from(JSON.stringify({...claim,schema:1,
    expires_at:now+10*60_000})).toString('base64url');
  return `${encoded}.${signature(encoded,secret).toString('base64url')}`;
}

export function verifyFinancePreview(input:Record<string,unknown>,actor:Principal,
  property:string,originHash:string,secret:string,now=Date.now()):ConfirmedFinancePreview{
  const token=input.ssot_preview_proof;
  if(typeof token!=='string'||token.length>200_000)throw Error('FINANCE_PREVIEW_REQUIRED');
  const match=/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
  if(!match)throw Error('FINANCE_PREVIEW_REQUIRED');
  const expected=signature(match[1],secret),actual=Buffer.from(match[2],'base64url');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))
    throw Error('FINANCE_PREVIEW_REQUIRED');
  let claim:ConfirmedFinancePreview;
  try{claim=JSON.parse(Buffer.from(match[1],'base64url').toString('utf8'));}
  catch{throw Error('FINANCE_PREVIEW_REQUIRED');}
  if(!claim||typeof claim!=='object'||claim.schema!==1||
    claim.actor_id!==actor.id||claim.property_id!==property||
    claim.request_id!==input.request_id||claim.action!==input.action||
    claim.origin_hash!==originHash||
    claim.projection_version!==input.projection_version||
    !Number.isSafeInteger(claim.expires_at)||claim.expires_at<now||
    claim.expires_at>now+10*60_000)
    throw Error('FINANCE_PREVIEW_EXPIRED');
  return claim;
}
