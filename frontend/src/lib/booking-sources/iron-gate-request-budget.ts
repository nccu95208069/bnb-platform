/** A request-local limit; acquire before signing and starting the backend timeout. */
export type RequestBudget=<T>(task:()=>Promise<T>)=>Promise<T>;
export const noRequestBudget:RequestBudget=task=>task();

export function requestBudget(max:number):RequestBudget{
 if(!Number.isSafeInteger(max)||max<1)throw Error('INVALID_REQUEST_BUDGET');
 let active=0;const waiting:(()=>void)[]=[];
 return async task=>{
  if(active<max&&!waiting.length)active++;
  else await new Promise<void>(resolve=>waiting.push(resolve));
  try{return await task();}
  finally{
   const next=waiting.shift();
   if(next)next();else active--;
  }
 };
}
