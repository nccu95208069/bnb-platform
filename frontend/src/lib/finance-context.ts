import {redisCommand} from './workspace-auth/store';
import {readFinance,calendarIncome,type FinanceState} from './finance-store';
import {readBookingSnapshot} from './booking-sources/snapshot';
import type {SheetSourceDefinition} from './booking-sources/config';
import {projectOrders,projectionVersion} from './finance-projection';
import {recurrenceDue,taipeiDate,type PayoutRule} from './finance-model';
export async function financeContext(source:SheetSourceDefinition,year:number){
 const years=new Set<number>([year]);let cursor='0',pages=0;
 do{const result=await redisCommand(['SCAN',cursor,'MATCH',`sweetfun-os:finance:v1:${source.property.id}:*`,'COUNT',200]) as [string,string[]];cursor=String(result[0]);for(const key of result[1]){const suffix=key.split(':').at(-1)!;if(/^20\d{2}$/.test(suffix))years.add(Number(suffix));}if(++pages>100)throw new Error('UNAVAILABLE');}while(cursor!=='0');
 const sorted=[...years].sort();
 const [states,calendar,snapshot]=await Promise.all([Promise.all(sorted.map(y=>readFinance(source.property.id,y))),calendarIncome(source.property.id,null),readBookingSnapshot(source)]);
 if(!snapshot)throw new Error('UNAVAILABLE');
 calendar.sort((a,b)=>a.id.localeCompare(b.id));
 const entries=[...states.flatMap((s,i)=>s.state.entries.map(e=>({...e,ledger_year:sorted[i]}))),...calendar];
 const payment_accounts=states.flatMap(s=>s.state.payment_accounts??[]);
 const recurring=states.flatMap(s=>s.state.recurring??[]);
 const ruleMap=new Map<string,PayoutRule>();for(const s of states)for(const r of s.state.payout_rules??[])if((r.updated_at??'')>=(ruleMap.get(r.platform)?.updated_at??''))ruleMap.set(r.platform,r);
 const payout_rules=['ctrip','owljourney'].map(platform=>ruleMap.get(platform)??{platform,mode:'manual' as const,day:10,offset:1});
 const {orders,excluded}=projectOrders(snapshot.bookings,entries,payout_rules);
 const selected=states[sorted.indexOf(year)];
 return {raw:selected.raw,state:selected.state as FinanceState,entries,orders,recurring,payment_accounts,payout_rules,excluded_orders:excluded,versions:Object.fromEntries(sorted.map((y,i)=>[y,states[i].state.version])),due:[...new Set([...recurring.map(r=>Number(r.start.slice(0,4))),year])].flatMap(start=>Array.from({length:Math.max(0,year-start+1)},(_,i)=>start+i)).filter((y,i,a)=>a.indexOf(y)===i).flatMap(y=>recurrenceDue(recurring,entries,y)),projection_version:projectionVersion([snapshot.bookings.map(b=>[b.id,b.order_id,b.room_rate,b.check_in,b.check_out,b.platform,b.source_conflict,b.reservation_status]),states.filter(s=>s.state.version>0).map(s=>s.state),calendar]),asof:taipeiDate()};
}
