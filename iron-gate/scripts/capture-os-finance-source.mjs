import {open,stat,realpath} from 'node:fs/promises';
import {resolve,dirname,parse} from 'node:path';
import {createHash} from 'node:crypto';
import {captureOsFinanceSnapshot} from '../src/os-finance-backfill.mjs';

// Explicit-property read-only capture. Credentials are passed only in the process
// environment; the raw snapshot is private and must remain outside Git.
const [property,output,...extra]=process.argv.slice(2);
if(!['sweetfun','offland'].includes(property)||!output||extra.length)
 throw Error('USAGE: capture-os-finance-source.mjs <sweetfun|offland> <new-private-output>');
const destination=resolve(output);
let parent=await realpath(dirname(destination));
for(;;){
 if(await stat(resolve(parent,'.git')).then(()=>true,()=>false))throw Error('PRIVATE_OUTPUT_INSIDE_GIT');
 if(parent===parse(parent).root)break;
 parent=dirname(parent);
}
const url=process.env.FINANCE_CAPTURE_REDIS_URL;
const token=process.env.FINANCE_CAPTURE_READ_ONLY_TOKEN;
if(!url||!token||new URL(url).protocol!=='https:')throw Error('READ_ONLY_SOURCE_UNAVAILABLE');
async function read(command){
 if(!['SCAN','MGET'].includes(command[0]))throw Error('READ_ONLY_COMMAND_REQUIRED');
 const response=await fetch(url,{method:'POST',signal:AbortSignal.timeout(12000),
  headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(command)});
 if(!response.ok)throw Error('READ_ONLY_SOURCE_FAILED');
 const result=await response.json();if(result.error)throw Error('READ_ONLY_SOURCE_FAILED');
 return result.result;
}
const snapshot=await captureOsFinanceSnapshot({property_id:property,
 scan:(cursor,pattern)=>read(['SCAN',cursor,'MATCH',pattern,'COUNT',200]),
 mget:keys=>read(['MGET',...keys]),payment_orders:[]});
const file=await open(destination,'wx',0o600);
try{await file.writeFile(`${JSON.stringify(snapshot)}\n`);await file.sync();}finally{await file.close();}
console.log(JSON.stringify({status:'captured',property,record_count:snapshot.records.length,
 scan_complete:snapshot.scan_complete,records_sha256:createHash('sha256')
  .update(JSON.stringify(snapshot.records)).digest('hex')}));
