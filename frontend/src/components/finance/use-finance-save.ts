"use client";
import {useCallback,useEffect,useState} from 'react';
import type {FinanceReport} from '@/lib/finance-model';

type PendingSummary={request_id:string;status:'pending'|'accepted'|'rejected';
  action:string;created_at:string};
const changed='finance-ssot-pending-changed';
const unknown='結果尚未確認。請查詢原請求，暫時不要再登記一次。';
const pendingUrl=(property:string)=>`/api/v1/finance/pending?property=${encodeURIComponent(property)}`;

export function useFinanceSave(report:FinanceReport,onSaved:()=>void){
  const property=report.property_id,ssotEnabled=report.ssot_enabled;
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [pending,setPending]=useState<Record<string,unknown>|PendingSummary|null>(null);

  const refreshPending=useCallback(async()=>{
    if(!ssotEnabled)return;
    const response=await fetch(pendingUrl(property),{cache:'no-store'});
    if(!response.ok)throw Error('待確認請求暫時無法查詢。');
    const data=await response.json() as {pending:PendingSummary|null};
    setPending(data.pending);
  },[property,ssotEnabled]);

  useEffect(()=>{
    if(!ssotEnabled)return;
    let live=true;
    const refresh=()=>{void refreshPending().catch(()=>{
      if(live)setError('待確認請求暫時無法查詢。請稍後再試。');
    });};
    refresh();
    window.addEventListener(changed,refresh);
    return ()=>{live=false;window.removeEventListener(changed,refresh);};
  },[refreshPending,ssotEnabled]);

  async function acknowledge(requestId:string){
    const response=await fetch(`${pendingUrl(report.property_id)}&request_id=${encodeURIComponent(requestId)}`,
      {method:'DELETE'});
    if(!response.ok)throw Error('原請求已處理，但確認狀態尚未清除。請重新查詢。');
    setPending(null);
    window.dispatchEvent(new Event(changed));
  }

  async function retryPending(){
    if(!report.ssot_enabled||busy)return;
    const requestId=typeof pending?.request_id==='string'?pending.request_id:null;
    if(!requestId){setError('請重新載入後查詢原請求。');return;}
    setBusy(true);setError('');
    try{
      const response=await fetch('/api/v1/finance/pending',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({property_id:report.property_id})});
      const result=await response.json() as Record<string,unknown>;
      if(response.ok&&result.verified===true){
        await acknowledge(requestId);onSaved();return;
      }
      if(response.status===409&&result.rejected===true){
        await acknowledge(requestId);
        setError('原請求未入帳，請修正後重新送出。');
        return;
      }
      setError(typeof result.detail==='string'?result.detail:unknown);
      await refreshPending();
    }catch{
      setError(unknown);
      await refreshPending().catch(()=>{});
    }finally{setBusy(false);}
  }

  async function save(fields:Record<string,unknown>){
    if(busy)return;
    if(report.ssot_enabled&&pending){await retryPending();return;}
    setBusy(true);setError('');
    const payload=!report.ssot_enabled&&pending?pending:{...fields,property_id:report.property_id,
      year:Number(fields.year??report.year),
      expected_version:report.versions?.[String(fields.year??report.year)]??0,
      projection_version:report.projection_version,request_id:crypto.randomUUID()};
    if(!report.ssot_enabled)setPending(payload);
    try{
      const response=await fetch('/api/v1/finance',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const result=await response.json() as Record<string,unknown>;
      if(response.ok&&result.verified===true){
        if(report.ssot_enabled)await acknowledge(String(payload.request_id));
        else setPending(null);
        onSaved();return;
      }
      if(report.ssot_enabled){
        await refreshPending();
        if(response.status===409&&result.code==='FINANCE_PENDING_REQUEST'){
          setError('上一筆財務請求尚未完成。請先查詢原請求。');return;
        }
        if(response.status>=400&&response.status<500&&
          result.code!=='IDEMPOTENCY_CONFLICT'){
          await acknowledge(String(payload.request_id)).catch(()=>{});
        }
      }else if(response.status<500)setPending(null);
      setError(typeof result.detail==='string'?result.detail:unknown);
    }catch{
      if(report.ssot_enabled)await refreshPending().catch(()=>{});
      setError(unknown);
    }finally{setBusy(false);}
  }

  return {busy,error,pending,save,retryPending};
}
