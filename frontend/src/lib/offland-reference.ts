import type { AvailabilityResult } from './availability';

export const OFFLAND_REFERENCE_KEY = 'sweetfun-os:research:v1:offland';
export type OfflandReference = {
  asof: string; probability: number | null; suggested_price: number | null;
  status: 'research_only'; source_version: string;
};
export type OfflandReferenceSnapshot = {
  schema: 1; property_id: 'offland'; version: string; asof: string;
  model: 'offland-pooled-retained-v1'; publication_enabled: false;
  cells: {date:string; probability:number|null;
    direct: {current:number; suggested:number}|null;
    direct_four: {current:number; suggested:number}|null}[];
};
const validDay=(d:string)=>/^\d{4}-\d{2}-\d{2}$/.test(d)&&Number.isFinite(Date.parse(d))&&new Date(d).toISOString().slice(0,10)===d;
export function validateOfflandReference(value:unknown):OfflandReferenceSnapshot {
  const s=value as OfflandReferenceSnapshot;
  if(!s||s.schema!==1||s.property_id!=='offland'||s.publication_enabled!==false||
     s.model!=='offland-pooled-retained-v1'||!validDay(s.asof)||!/^[a-f0-9]{20}$/.test(s.version)||
     !Array.isArray(s.cells)||s.cells.length>400)throw Error('INVALID_OFFLAND_REFERENCE');
  const seen=new Set<string>();
  for(const c of s.cells){
    const lead=(Date.parse(c.date)-Date.parse(s.asof))/86400000;
    if(!validDay(c.date)||seen.has(c.date)||lead<0||lead>90||
       (c.probability!==null&&(!Number.isFinite(c.probability)||c.probability<0||c.probability>1)))throw Error('INVALID_OFFLAND_REFERENCE_CELL');
    for(const key of ['direct','direct_four'] as const){
      const p=c[key];const saturday=new Date(c.date+'T00:00:00Z').getUTCDay()===6;
      const floor=key==='direct'?(saturday?11000:7800):(saturday?9000:6600);
      if(p!==null&&(!p||!Number.isSafeInteger(p.current)||p.current<=0||!Number.isSafeInteger(p.suggested)||p.suggested<floor))throw Error('INVALID_OFFLAND_REFERENCE_PRICE');
    }
    seen.add(c.date);
  }
  return s;
}
export function attachOfflandReference(result:AvailabilityResult, snapshot:OfflandReferenceSnapshot|null):AvailabilityResult {
  if(result.property_id!=='offland')return result;
  const age=snapshot?(Date.parse(result.asof)-Date.parse(snapshot.asof))/86400000:Infinity;
  const usable=!!snapshot&&age>=0&&age<=3;
  const map=new Map(usable?snapshot.cells.map(c=>[c.date,c]):[]);
  return {...result,source_notice:result.source_notice+' OFFLAND 參考版：機率試算中，四／六人共用整棟機率；建議價未發布，不會自動改價。資料不足、連假或過期資料不顯示試算。',
    cells:result.cells.map(cell=>{
      const reference=map.get(cell.date);
      if(cell.state!=='available'||!reference||!snapshot)return {...cell,offland_reference:null};
      const channel=result.query.channel;
      const proposal=channel==='direct'||channel==='direct_four'?reference[channel]:null;
      const samePrice=proposal&&cell.pricing?.policy==='observed_snapshot'&&proposal.current===cell.pricing.current_price;
      return {...cell,offland_reference:{asof:snapshot.asof,probability:reference.probability,
        suggested_price:samePrice?proposal.suggested:null,status:'research_only' as const,source_version:snapshot.version}};
    })};
}
