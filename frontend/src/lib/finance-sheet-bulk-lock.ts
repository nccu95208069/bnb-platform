import {createHash,randomUUID} from 'node:crypto';
import {redisCommand} from './workspace-auth/store';

export async function withFinanceSheetLock<T>(spreadsheetId:string,work:()=>Promise<T>):Promise<T>{
  if(!/^[A-Za-z0-9_-]{10,128}$/.test(spreadsheetId))
    throw Error('SHEET_CONFIG_INVALID');
  const hash=createHash('sha256').update(spreadsheetId).digest('hex');
  const key=`finance:sheet-bulk:${hash}:lock`,owner=randomUUID();
  if(await redisCommand(['SET',key,owner,'NX','EX',120])!=='OK')
    throw Error('SHEET_BUSY');
  try{return await work();}
  finally{await redisCommand(['EVAL',
    "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
    1,key,owner]).catch(()=>{});}
}
