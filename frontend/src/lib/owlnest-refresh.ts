import { pricingProperty } from './property-pricing.ts';
import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { validatePricingSnapshot, type PricingSnapshot } from "./pricing-snapshot.ts";
import { redisCommand } from "./workspace-auth/store.ts";

const DAY = 86400000;

export function refreshWindow(now = new Date()) {
  const start = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).format(now);
  const date = new Date(start + "T00:00:00Z");
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 4, 0));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 3, Math.min(date.getUTCDate(), last.getUTCDate()))).toISOString().slice(0,10);
  return {start,end}; // exclusive end
}

type OwlRoom = { room_id:number; plans:{id:number;plan_items:{date:string;price:number}[]}[]; stocks?:{date:string;count:number|null;is_lock:boolean|0|1}[] };
export function refreshedSnapshot(raw: unknown, prior: PricingSnapshot, start:string, end:string, observed:string): PricingSnapshot {
  const config = pricingProperty(prior.property_id);
  const payload = raw as {status:number;data:OwlRoom[]};
  if (payload?.status !== 0 || !Array.isArray(payload.data)) throw Error("OWLNEST_RESPONSE_INVALID");
  const old = new Map(prior.cells.map(c => [`${c.date}|${c.room}`,c]));
  const cells: PricingSnapshot["cells"] = [];
  const seenRooms = new Set<string>();
  for (const room of payload.data) {
    const code = config.rooms[room.room_id];
    if (!code) continue;
    if (seenRooms.has(code) || !Array.isArray(room.plans)) throw Error("OWLNEST_RESPONSE_INVALID");
    seenRooms.add(code);
    const values = new Map<string,Partial<Record<import("./availability").Channel,number>>>();
    for (const plan of room.plans) {
      const channel = config.plans[plan.id];
      if (!channel) continue;
      if (!Array.isArray(plan.plan_items)) throw Error("OWLNEST_RESPONSE_INVALID");
      for (const item of plan.plan_items) {
        const date = String(item.date).slice(0,10);
        if (date < start || date >= end) continue;
        const channels = values.get(date) ?? {};
        if (channels[channel] !== undefined || !Number.isSafeInteger(item.price) || item.price <= 0) throw Error("OWLNEST_RESPONSE_INVALID");
        channels[channel] = item.price;
        values.set(date,channels);
      }
    }
    const stocks = new Map<string, PricingSnapshot["cells"][number]["stock"]>();
    if (room.stocks !== undefined && !Array.isArray(room.stocks)) throw Error("OWLNEST_RESPONSE_INVALID");
    for (const item of room.stocks ?? []) {
      const date=String(item.date).slice(0,10);
      if (date < start || date >= end) continue;
      if (stocks.has(date) || ![true,false,0,1].includes(item.is_lock) || (item.count !== null && (!Number.isSafeInteger(item.count) || item.count < 0))) throw Error("OWLNEST_RESPONSE_INVALID");
      stocks.set(date,{count:item.count,is_lock:Boolean(item.is_lock)});
    }
    for (let d=Date.parse(start); d<Date.parse(end); d+=DAY) {
      const date=new Date(d).toISOString().slice(0,10), channels=values.get(date);
      if (!channels || config.channels.some(c => channels[c] === undefined)) throw Error("OWLNEST_RESPONSE_INCOMPLETE");
      const previous = old.get(`${date}|${code}`);
      cells.push({date,room:code,channels,observed_at:observed,stock:stocks.get(date) ?? null,
        rack_price:previous?.rack_price ?? null,daytype:previous?.daytype ?? "",baseline_version:previous?.baseline_version ?? "",
        sales_probability:previous?.sales_probability ?? null});
    }
  }
  if (seenRooms.size !== config.roomNames.length) throw Error("OWLNEST_RESPONSE_INCOMPLETE");
  // Dates outside this refresh retain their own observation time, never appear freshly read.
  cells.push(...prior.cells.filter(c => c.date < start || c.date >= end).map(c=>({...c,observed_at:c.observed_at ?? prior.observed_at})));
  cells.sort((a,b)=>a.date.localeCompare(b.date)||a.room.localeCompare(b.room));
  const snapshot = {...prior,observed_at:observed,cells};
  snapshot.version = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0,20);
  return validatePricingSnapshot(snapshot);
}

export async function readOwlNest(start:string,end:string,property="sweetfun") {
  const config=pricingProperty(property);
  const API=`https://www.owlting.com/booking/v2/admin/hotels/${config.hotel}/calendars`;
  const authorization = process.env.OWLNEST_AUTHORIZATION;
  if (!authorization || authorization.length < 20 || /undefined|null/i.test(authorization)) throw Error("OWLNEST_NOT_CONFIGURED");
  const inclusiveEnd = new Date(Date.parse(end)-DAY).toISOString().slice(0,10);
  const response = await fetch(`${API}?${new URLSearchParams({during_start_date:start,during_end_date:inclusiveEnd})}`, {
    method:"GET",cache:"no-store",redirect:"error",signal:AbortSignal.timeout(30000),
    headers:{Authorization:authorization,Accept:"application/json","X-Requested-With":"XMLHttpRequest","User-Agent":"Mozilla/5.0"},
  });
  if ([401,403].includes(response.status)) throw Error("OWLNEST_AUTH_EXPIRED");
  if (!response.ok) throw Error("OWLNEST_READ_FAILED");
  const raw=await response.json();
  if (raw?.status === 30003) throw Error("OWLNEST_AUTH_EXPIRED");
  return raw;
}

export async function refreshOwlNest(deps={command:redisCommand,read:readOwlNest,now:()=>new Date()}, property="sweetfun") {
  const config=pricingProperty(property), PRICING_KEY=config.key;
  const lock = PRICING_KEY+":refresh-lock", owner=randomUUID();
  if (await deps.command(["SET",lock,owner,"NX","EX",90]) !== "OK") throw Error("PRICE_REFRESH_BUSY");
  try {
    const raw=await deps.command(["GET",PRICING_KEY]);
    if (raw !== null && (typeof raw !== "string" || !raw.startsWith("gz1:"))) throw Error("PRICING_NOT_READY");
    const prior:PricingSnapshot=raw === null ? {schema:1,property_id:config.id,observed_at:"1970-01-01T00:00:00Z",version:"0".repeat(20),source_commit:"0".repeat(40),cells:[]} : validatePricingSnapshot(JSON.parse(gunzipSync(Buffer.from(String(raw).slice(4),"base64"),{maxOutputLength:4*1024*1024}).toString("utf8")),property);
    const {start,end}=refreshWindow(deps.now());
    const response=await deps.read(start,end,property);
    const observed=deps.now().toISOString();
    if (Date.parse(observed) <= Date.parse(prior.observed_at)) throw Error("PRICE_REFRESH_CONFLICT");
    const snapshot=refreshedSnapshot(response,prior,start,end,observed);
    const encoded="gz1:"+gzipSync(JSON.stringify(snapshot)).toString("base64");
    const result=await deps.command(["EVAL","if redis.call('GET',KEYS[1])~=ARGV[1] or (redis.call('GET',KEYS[2]) or '')~=ARGV[2] then return 0 end; if ARGV[2]~='' then redis.call('SET',KEYS[3],ARGV[2]); end; redis.call('SET',KEYS[2],ARGV[3]); return 1",3,lock,PRICING_KEY,PRICING_KEY+":previous",owner,raw ?? "",encoded]).catch(()=>{throw Error("PRICE_REFRESH_UNCONFIRMED");});
    if (result !== 1) throw Error("PRICE_REFRESH_CONFLICT");
    const confirmed=await deps.command(["GET",PRICING_KEY]).catch(()=>{throw Error("PRICE_REFRESH_UNCONFIRMED");});
    if (confirmed !== encoded) throw Error("PRICE_REFRESH_UNCONFIRMED");
    return {verified:true,observed_at:observed,start,end,version:snapshot.version,property_id:property,room_count:config.roomNames.length,channel_count:config.channels.length};
  } finally {
    await deps.command(["EVAL","if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0",1,lock,owner]).catch(()=>undefined);
  }
}
