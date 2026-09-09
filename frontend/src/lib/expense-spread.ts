export type ExpenseShare={month:string;amount_cents:number};
const validMonth=(v:unknown):v is string=>typeof v==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(v);
export function spreadMonths(start:string,end:string):string[]{
 if(!validMonth(start)||!validMonth(end)||end<start)return [];
 const index=(s:string)=>Number(s.slice(0,4))*12+Number(s.slice(5))-1;
 const count=index(end)-index(start)+1;if(count<1||count>120)return [];
 return Array.from({length:count},(_,i)=>{const n=index(start)+i;return `${Math.floor(n/12)}-${String(n%12+1).padStart(2,'0')}`;});
}
export function equalSpread(cents:number,months:string[]):ExpenseShare[]{
 if(!Number.isSafeInteger(cents)||cents<=0||!months.length)return [];
 const base=Math.floor(cents/months.length),remainder=cents%months.length;
 return months.map((month,i)=>({month,amount_cents:base+(i<remainder?1:0)}));
}
export function validateSpread(value:unknown,kind:unknown,cents:number):ExpenseShare[]|undefined{
 if(value==null)return undefined;
 if(kind!=='expense'||!Array.isArray(value)||value.length<1||value.length>120)throw new Error('INVALID_INPUT');
 const rows=value as ExpenseShare[];
 if(rows.some(r=>!r||!validMonth(r.month)||!Number.isSafeInteger(r.amount_cents)||r.amount_cents<0)||rows.reduce((s,r)=>s+r.amount_cents,0)!==cents)throw new Error('INVALID_INPUT');
 const months=spreadMonths(rows[0].month,rows.at(-1)!.month);
 if(months.length!==rows.length||rows.some((r,i)=>r.month!==months[i]))throw new Error('INVALID_INPUT');
 return rows.map(r=>({month:r.month,amount_cents:r.amount_cents}));
}
