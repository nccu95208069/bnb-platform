// Private operator bridge. Dedicated research key only: no OwlNest or price writes.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {OFFLAND_REFERENCE_KEY,validateOfflandReference} from '../src/lib/offland-reference.ts';
import {redisCommand} from '../src/lib/workspace-auth/store.ts';
const [ledgerPath,trialPath]=process.argv.slice(2);
const ledger=JSON.parse(await readFile(ledgerPath,'utf8'));
const trial=JSON.parse(await readFile(trialPath,'utf8'));
if(ledger.property_id!=='offland'||trial.property_id!=='offland'||ledger.production_enabled!==false||
   trial.automatic_publication_enabled!==false||ledger.asof!==trial.asof||
   ledger.model_version!=='offland-pooled-retained-v1'||
   ['orders.json','calendar.json','price-table.json'].some(k=>ledger.input_sha256[k]!==trial.input_sha256[k]))throw Error('INPUT_MISMATCH');
const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
if(ledger.asof!==today)throw Error('RECOLLECT_CURRENT_DAY_BEFORE_PUBLICATION');
const cells=ledger.forecasts.filter(f=>f.research_p!==null).map(f=>{
 const proposal=people=>{
   const r=trial.cells.find(c=>c.date===f.date&&c.plan_people===people);
   return r?.trial_price!=null&&r.trial_basis==='current_price_guardrail_only_not_probability'&&r.publishable===false
     ?{current:r.current_price,suggested:r.trial_price}:null;
 };
 return {date:f.date,probability:f.research_p,direct:proposal(6),direct_four:proposal(4)};
});
const version=createHash('sha256').update(JSON.stringify({asof:ledger.asof,cells})).digest('hex').slice(0,20);
const snapshot=validateOfflandReference({schema:1,property_id:'offland',version,asof:ledger.asof,
 model:ledger.model_version,publication_enabled:false,cells});
const value=JSON.stringify(snapshot),old=await redisCommand(['GET',OFFLAND_REFERENCE_KEY]);
if(old){const previous=validateOfflandReference(JSON.parse(old));if(previous.asof>snapshot.asof)throw Error('NEWER_REFERENCE_EXISTS');}
if(old!==value){
 const result=await redisCommand(['EVAL',"local old=redis.call('GET',KEYS[1]); if (old or '')~=ARGV[1] then return 0 end; if old then redis.call('SET',KEYS[2],old) end; redis.call('SET',KEYS[1],ARGV[2]); return 1",2,OFFLAND_REFERENCE_KEY,OFFLAND_REFERENCE_KEY+':previous',old??'',value]);
 if(result!==1)throw Error('CONCURRENT_PUBLICATION');
}
if(await redisCommand(['GET',OFFLAND_REFERENCE_KEY])!==value)throw Error('READBACK_MISMATCH');
console.log(JSON.stringify({verified:true,version,dates:cells.length,price_writes:0}));
