import {assertFinanceWritesOpen} from './finance-history-policy.ts';
import type {Principal} from './workspace-auth/types.ts';
import {RedisWorkspaceStore} from './workspace-auth/store.ts';
import {activeSources} from './booking-sources/config.ts';
import {assertNotCardManaged} from './card-payment-ownership.ts';
import {ssotFinanceContext} from './finance-ssot-context.ts';
import {applySsotFinance,resumeSsotFinance,
  osFinanceOriginHash} from './finance-ssot-operations.ts';
import {ironGateSsotFinanceConfig} from './booking-sources/iron-gate-ssot-finance.server.ts';
import {verifyFinancePreview} from './finance-ssot-preview.server.ts';
import {acceptPendingOsFinance,rejectPendingOsFinance,readPendingOsFinance,
  reservePendingOsFinance} from './finance-ssot-pending.server.ts';

const definiteRejections=new Set(['INVALID_INPUT','VERSION_CONFLICT',
  'SOURCE_MAPPING_REVIEW_REQUIRED','CARD_PAYMENT_REVIEW_REQUIRED',
  'IRON_GATE_DIRECT_PAYMENT_REQUIRED','ORDER_REQUIRED','FUTURE_DATE',
  'SETTLEMENT_REVIEW_REQUIRED','NOT_FOUND','FINANCE_PREVIEW_REQUIRED',
  'FINANCE_PREVIEW_EXPIRED']);

export async function submitSsotOsFinance(input:Record<string,unknown>,
  actor:Principal,property:string,year:number){
  assertFinanceWritesOpen(property);
  // A cancelled or forged preview never creates a pending finance request.
  if(!await readPendingOsFinance(property,actor))
    verifyFinancePreview(input,actor,property,
      osFinanceOriginHash(input,actor.id,property),
      ironGateSsotFinanceConfig(property).calendar.proofSecret);
  const {pending,created}=await reservePendingOsFinance(input,property,actor);
  if(pending.status==='accepted'){
    if(!pending.result)throw Error('FINANCE_PENDING_UNAVAILABLE');
    return pending.result;
  }
  if(pending.status==='rejected')throw Error(pending.error_code??'INVALID_INPUT');
  try{
    const resumed=await resumeSsotFinance(input,actor,property);
    if(resumed.result){
      await acceptPendingOsFinance(property,actor,pending.request_id,resumed.result);
      return resumed.result;
    }
    // An existing pending request may have reached Iron Gate even when its
    // receipt is temporarily absent. Keep its slot and original key until an
    // operator can reconcile it; never submit or repreview it automatically.
    if(!created)throw Error('WRITE_UNCONFIRMED');
    const preview=verifyFinancePreview(input,actor,property,resumed.originHash,
      ironGateSsotFinanceConfig(property).calendar.proofSecret);
    const source=activeSources().find(s=>s.property.id===property);
    if(!source)throw Error('FORBIDDEN');
    const report=await ssotFinanceContext(source,year,actor);
    await assertNotCardManaged(property,[
      ...(typeof input.order_id==='string'?[input.order_id]:[]),
      ...(Array.isArray(input.allocations)?input.allocations.map(
        (a:{order_id?:unknown})=>String(a?.order_id??'')):[])]);
    const members=(await new RedisWorkspaceStore().read()).value.members;
    const result=await applySsotFinance(input,report,actor,property,year,
      members,resumed.originHash,preview);
    await acceptPendingOsFinance(property,actor,pending.request_id,result);
    return result;
  }catch(error){
    const code=error instanceof Error?error.message:'';
    if(created&&definiteRejections.has(code)){
      // An accepted write can have lost its response. Check the receipt before
      // recording a final rejection or releasing this user's pending slot.
      const resumed=await resumeSsotFinance(input,actor,property);
      if(resumed.result){
        await acceptPendingOsFinance(property,actor,pending.request_id,resumed.result);
        return resumed.result;
      }
      await rejectPendingOsFinance(property,actor,pending.request_id,code);
    }
    throw error;
  }
}
