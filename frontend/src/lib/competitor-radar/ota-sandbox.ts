import "server-only";

import { Sandbox } from "@vercel/sandbox";

import { scorePropertyIdentity } from "./identity";
import type {
  OtaDayObservation,
  OtaPlatform,
  OtaPlatformScan,
  OtaPropertyIdentity,
  OtaRoomObservation,
  OtaScanRequest,
  OtaSourceOverride,
} from "./ota-types";

const SNAPSHOT_ID =
  process.env.AGENT_BROWSER_SNAPSHOT_ID ?? "snap_c3rDmQdTPMoDHIu55bxS3MruQxZz";
const BOOKING_SWEETFUN_URL =
  "https://www.booking.com/hotel/tw/shui-fang-sweetfun-rui-fang-jiu-fen.zh-tw.html";
const TRIP_SWEETFUN_URL =
  "https://tw.trip.com/hotels/new-taipei-city-hotel-detail-133359377/sweet-fun/";
const AGODA_SWEETFUN_ROOMS: Array<{ roomNumber: string; url: string }> = [
  { roomNumber: "101", url: "https://www.agoda.com/sweetfun-101/hotel/taipei-tw.html" },
  { roomNumber: "201", url: "https://www.agoda.com/sweetfun/hotel/taipei-tw.html" },
  { roomNumber: "202", url: "https://www.agoda.com/sweetfun-202/hotel/taipei-tw.html" },
  { roomNumber: "301", url: "https://www.agoda.com/sweetfun-301/hotel/taipei-tw.html" },
  { roomNumber: "302", url: "https://www.agoda.com/sweetfun-302/hotel/taipei-tw.html" },
];

const PLATFORM_HOSTS: Record<OtaPlatform, RegExp> = {
  booking: /(^|\.)booking\.com$/i,
  agoda: /(^|\.)agoda\.com$/i,
  trip: /(^|\.)(trip|ctrip)\.com$/i,
};

type SandboxInstance = Awaited<ReturnType<typeof Sandbox.create>>;

interface BrowserCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface BrowserIdentity {
  url?: string;
  title?: string;
  name?: string;
  address?: string;
  registrationNumber?: string;
  roomNames?: string[];
  blocked?: boolean;
}

interface BrowserDayResult {
  roomNumber?: string;
  stayDate: string;
  checkOut: string;
  url: string;
  title?: string;
  sourceName?: string;
  dateVerified: boolean;
  blocked?: boolean;
  soldOut?: boolean;
  available?: boolean;
  amount?: number;
  currency?: string;
  sourceText?: string;
  error?: string;
}

function addDays(value: string, amount: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function normalizedText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[()（）\-_/|·,，.。]/g, "")
    .toLowerCase();
}

function isSweetfun(request: OtaScanRequest): boolean {
  const joined = [
    request.property.name,
    request.property.registrationNumber,
    request.property.websiteUrl,
    request.property.sourceUrl,
    request.property.websiteHost,
  ]
    .filter(Boolean)
    .join(" ");
  return /水芳|sweetfun|新北市民宿\s*402/i.test(joined);
}

function safePlatformUrl(value: string | undefined, platform: OtaPlatform): string | undefined {
  if (!value || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    if (!PLATFORM_HOSTS[platform].test(url.hostname)) return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function getCredentials() {
  if (
    process.env.VERCEL_TOKEN &&
    process.env.VERCEL_TEAM_ID &&
    process.env.VERCEL_PROJECT_ID
  ) {
    return {
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
    };
  }
  return {};
}

async function command(
  sandbox: SandboxInstance,
  args: string[],
  maximum = 1_500_000,
): Promise<BrowserCommandResult> {
  const result = await sandbox.runCommand({ cmd: "agent-browser", args });
  const stdout = (await result.stdout()).slice(0, maximum);
  const stderr = (await result.stderr()).slice(0, 8_000);
  if (result.exitCode !== 0) {
    throw new Error(stderr || `agent_browser_exit_${result.exitCode}`);
  }
  return { stdout, stderr, exitCode: result.exitCode };
}

function decodeAgentJson<T>(raw: string): T {
  let value: unknown = raw.trim();
  for (let attempt = 0; attempt < 3 && typeof value === "string"; attempt += 1) {
    const text = value.trim();
    if (!text) break;
    try {
      value = JSON.parse(text);
    } catch {
      break;
    }
  }
  if (!value || typeof value !== "object") throw new Error("ota_browser_payload_invalid");
  return value as T;
}

async function evaluate<T>(
  sandbox: SandboxInstance,
  source: string,
  maximum = 1_500_000,
): Promise<T> {
  const result = await command(sandbox, ["eval", source], maximum);
  return decodeAgentJson<T>(result.stdout);
}

async function withBrowser<T>(fn: (sandbox: SandboxInstance) => Promise<T>): Promise<T> {
  const sandbox = await Sandbox.create({
    ...getCredentials(),
    source: { type: "snapshot", snapshotId: SNAPSHOT_ID },
    timeout: 240_000,
    resources: { vcpus: 2 },
    networkPolicy: "allow-all",
  });
  try {
    return await fn(sandbox);
  } finally {
    await sandbox.runCommand({ cmd: "agent-browser", args: ["close"] }).catch(() => undefined);
    await sandbox.stop().catch(() => undefined);
  }
}

function propertyIdentity(
  platform: OtaPlatform,
  request: OtaScanRequest,
  observed: BrowserIdentity,
  trustedSource = false,
): OtaPropertyIdentity {
  const match = scorePropertyIdentity(request.property, {
    name: observed.name ?? observed.title,
    address: observed.address,
    registrationNumber: observed.registrationNumber,
    websiteUrl: observed.url,
  });
  const evidence = match.evidence.map((item) => `${item.label}：${item.detail}`);
  if (trustedSource) {
    evidence.unshift("此測試版使用已人工核對的水芳 OTA 房源網址與房號關係。");
  }
  const status = observed.blocked
    ? "not_found"
    : trustedSource && !match.conflicts.length
      ? "confirmed"
      : match.status;
  return {
    platform,
    sourceUrl: observed.url,
    sourceName: observed.name ?? observed.title,
    sourceAddress: observed.address,
    sourceRegistrationNumber: observed.registrationNumber,
    score: trustedSource ? Math.max(match.score, 0.9) : match.score,
    status,
    evidence,
  };
}

function roomIdForNumber(request: OtaScanRequest, roomNumber?: string): string | undefined {
  if (!roomNumber) return undefined;
  return request.canonicalRooms.find(
    (room) => normalizedText(room.roomNumber) === normalizedText(roomNumber),
  )?.id;
}

function emptyObservation(
  request: OtaScanRequest,
  stayDate: string,
  message: string,
  identityVerified: boolean,
  sourceUrl?: string,
): OtaDayObservation {
  return {
    stayDate,
    checkOut: addDays(stayDate, 1),
    state: "partial",
    availability: "unknown",
    sourceUrl,
    identityVerified,
    dateVerified: false,
    rooms: [],
    message,
  };
}

async function scanBooking(request: OtaScanRequest): Promise<OtaPlatformScan> {
  const started = Date.now();
  const sourceUrl =
    safePlatformUrl(request.sourceUrl, "booking") ??
    (isSweetfun(request) ? BOOKING_SWEETFUN_URL : undefined);
  if (!sourceUrl) {
    return {
      platform: "booking",
      state: "not_found",
      capturedAt: new Date().toISOString(),
      requestedDays: request.days,
      completedDays: 0,
      identity: { platform: "booking", status: "not_found", evidence: [] },
      observations: [],
      warnings: ["沒有找到可安全使用的 Booking 房源網址。"],
      durationMs: Date.now() - started,
    };
  }

  try {
    const observed = await withBrowser(async (sandbox) => {
      await command(sandbox, ["open", sourceUrl]);
      await command(sandbox, ["wait", "7000"]);
      return evaluate<BrowserIdentity>(
        sandbox,
        `JSON.stringify((()=>{
          const body=(document.body?.innerText||'');
          const lines=body.split('\\n').map(x=>x.trim()).filter(Boolean);
          const license=(body.match(/(?:新北市|臺北市|台北市|宜蘭縣|基隆市)?(?:民宿|旅館)\\s*\\d+\\s*號/)||[])[0];
          const address=lines.find(x=>/(?:路|街|大道).{0,20}\\d+(?:之|-)?\\d*號/.test(x));
          const candidates=lines.filter((line,index)=>{
            const next=lines.slice(index+1,index+4).join(' ');
            return line.length>=5&&line.length<=120&&
              (/^(?:Standard|Superior|Deluxe|Executive|Family|Double|Twin|Triple|Quadruple|Suite|Villa|Apartment|Entire)/i.test(line)||/(?:雙人|四人|三人|家庭|套房|別墅|包棟).*(?:房|間)/.test(line))&&
              /(?:bed|床|顯示價格|show prices)/i.test(next);
          });
          const roomNames=[...new Set(candidates)].slice(0,40);
          const h2=[...document.querySelectorAll('h1,h2')].map(x=>(x.innerText||'').trim()).find(x=>/水芳|Sweetfun/i.test(x))||document.title.split('|')[0].trim();
          return {url:location.href,title:document.title,name:h2,address,registrationNumber:license,roomNames,blocked:/captcha|verify you are human|機器人驗證|request rejected/i.test(body)};
        })())`,
      );
    });
    const identity = propertyIdentity("booking", request, observed);
    const identityVerified = identity.status === "confirmed";
    const sourceRooms: OtaRoomObservation[] = (observed.roomNames ?? []).map((name, index) => ({
      sourceRoomId: `booking-${index}`,
      sourceRoomName: name,
      availability: "unknown",
      quantityState: "unknown",
    }));
    const observations = Array.from({ length: request.days }, (_, index) => {
      const stayDate = addDays(request.startDate, index);
      return {
        ...emptyObservation(
          request,
          stayDate,
          "Booking 已確認住宿與房型目錄，但這條公開頁面路徑沒有回傳可驗證的入住日期，因此不採用價格或房量。",
          identityVerified,
          sourceUrl,
        ),
        rooms: sourceRooms,
      };
    });
    return {
      platform: "booking",
      state: observed.blocked ? "blocked" : "partial",
      capturedAt: new Date().toISOString(),
      requestedDays: request.days,
      completedDays: observed.blocked ? 0 : request.days,
      identity,
      observations,
      warnings: [
        "Booking 房源頁會在轉址或送出日期時靜默遺失 query；日期未通過驗證前不顯示任何價格。",
        "房型目錄為即時頁面觀察，並不是 14 天可售量。",
      ],
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return failedScan("booking", request, started, error);
  }
}

function agodaSources(request: OtaScanRequest): Array<{ roomNumber?: string; url: string }> {
  const overrides = (request.sourceOverrides ?? [])
    .map((item) => ({ roomNumber: item.roomNumber, url: safePlatformUrl(item.url, "agoda") }))
    .filter((item): item is { roomNumber?: string; url: string } => Boolean(item.url));
  if (overrides.length) return overrides;
  const single = safePlatformUrl(request.sourceUrl, "agoda");
  if (single) return [{ url: single }];
  return isSweetfun(request) ? AGODA_SWEETFUN_ROOMS : [];
}

async function scanAgoda(request: OtaScanRequest): Promise<OtaPlatformScan> {
  const started = Date.now();
  const sources = agodaSources(request);
  if (!sources.length) {
    return {
      platform: "agoda",
      state: "not_found",
      capturedAt: new Date().toISOString(),
      requestedDays: request.days,
      completedDays: 0,
      identity: { platform: "agoda", status: "not_found", evidence: [] },
      observations: [],
      warnings: ["沒有找到 Agoda 房源網址。水芳在 Agoda 是逐房間獨立頁面，其他住宿可能採不同結構。"],
      durationMs: Date.now() - started,
    };
  }

  const jobs = Array.from({ length: request.days }, (_, index) => {
    const stayDate = addDays(request.startDate, index);
    return sources.map((source) => ({
      roomNumber: source.roomNumber,
      stayDate,
      checkOut: addDays(stayDate, 1),
      url: `${source.url}${source.url.includes("?") ? "&" : "?"}${new URLSearchParams({
        checkIn: stayDate,
        los: "1",
        rooms: "1",
        adults: String(request.adults),
        children: "0",
        currencyCode: "TWD",
      })}`,
    }));
  }).flat();

  try {
    const results = await withBrowser(async (sandbox) => {
      await command(sandbox, ["open", sources[0]!.url]);
      await command(sandbox, ["wait", "2500"]);
      const serializedJobs = JSON.stringify(jobs).replace(/</g, "\\u003c");
      return evaluate<BrowserDayResult[]>(
        sandbox,
        `(async()=>{
          const jobs=${serializedJobs};
          const parse=async(job)=>{
            try{
              const response=await fetch(job.url,{credentials:'include'});
              const html=await response.text();
              const doc=new DOMParser().parseFromString(html,'text/html');
              const body=(doc.body?.innerText||doc.body?.textContent||'').replace(/\\s+/g,' ');
              const scripts=[...doc.scripts].map(s=>s.textContent||'').join('\\n');
              const dateVerified=scripts.includes('checkIn='+job.stayDate)&&scripts.includes('los=1')||
                scripts.includes('\\"checkInDateStr\\":\\"'+job.stayDate+'\\"')||
                body.includes(new Date(job.stayDate+'T00:00:00Z').toLocaleDateString('en-US',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'}).replace(',',''));
              const soldOut=/Sold out!.*Our last room is already booked/i.test(body)||/\\"isSoldOut\\"\\s*:\\s*true/i.test(scripts);
              const blocked=/captcha|verify you are human|request rejected|access denied/i.test(body);
              const currency=(scripts.match(/\\"currency\\"\\s*:\\s*\\{\\"code\\"\\s*:\\s*\\"([A-Z]{3})\\"/)||[])[1]||
                (body.match(/\\b(TWD|USD|NTD)\\b/)||[])[1];
              const structured=[];
              for(const pattern of [/\\"displayPrice\\"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)/g,/\\"sellingPrice\\"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)/g,/\\"exclusivePrice\\"\\s*:\\s*([0-9]+(?:\\.[0-9]+)?)/g]){
                for(const match of scripts.matchAll(pattern)){const value=Number(match[1]);if(value>100&&value<1000000)structured.push(value)}
              }
              const amount=!soldOut&&structured.length?Math.min(...structured):undefined;
              const available=dateVerified&&!soldOut&&(amount!==undefined||/Select your room|Choose your room/i.test(body));
              return {...job,title:doc.title,sourceName:doc.title.split('(')[0].trim(),dateVerified,blocked,soldOut,available,amount,currency,sourceText:soldOut?'Sold out! Our last room is already booked':available?'Agoda page returned a dated room offer':'No dated offer was exposed'};
            }catch(error){return {...job,dateVerified:false,error:String(error)}}
          };
          const output=[];
          for(let index=0;index<jobs.length;index+=6){output.push(...await Promise.all(jobs.slice(index,index+6).map(parse)))}
          return JSON.stringify(output);
        })()`,
        2_000_000,
      );
    });

    const trusted = isSweetfun(request) && !request.sourceUrl && !(request.sourceOverrides?.length);
    const first = results.find((item) => !item.error && !item.blocked);
    const identity = propertyIdentity(
      "agoda",
      request,
      {
        url: first?.url ?? sources[0]!.url,
        title: first?.title,
        name: first?.sourceName,
        blocked: !first && results.some((item) => item.blocked),
      },
      trusted,
    );
    const identityVerified = identity.status === "confirmed";
    const observations: OtaDayObservation[] = Array.from({ length: request.days }, (_, index) => {
      const stayDate = addDays(request.startDate, index);
      const day = results.filter((item) => item.stayDate === stayDate);
      const rooms: OtaRoomObservation[] = day.map((item, roomIndex) => ({
        sourceRoomId: item.roomNumber ? `agoda-${item.roomNumber}` : `agoda-${roomIndex}`,
        sourceRoomName: item.sourceName ?? (item.roomNumber ? `Agoda ${item.roomNumber}` : "Agoda 房型"),
        canonicalRoomId: roomIdForNumber(request, item.roomNumber),
        availability:
          !identityVerified || !item.dateVerified || item.error || item.blocked
            ? "unknown"
            : item.soldOut
              ? "sold_out"
              : item.available
                ? "available"
                : "unknown",
        quantityState: "unknown",
        amount:
          identityVerified && item.dateVerified && !item.soldOut ? item.amount : undefined,
        currency:
          identityVerified && item.dateVerified && !item.soldOut ? item.currency : undefined,
        sourceText: item.error ?? item.sourceText,
      }));
      const usable = rooms.filter((room) => room.availability !== "unknown");
      const currencies = [...new Set(rooms.map((room) => room.currency).filter(Boolean))];
      const prices = rooms
        .map((room) => room.amount)
        .filter((amount): amount is number => amount !== undefined);
      const availability = rooms.some((room) => room.availability === "available")
        ? "available"
        : usable.length === rooms.length && rooms.length > 0 && rooms.every((room) => room.availability === "sold_out")
          ? "sold_out"
          : "unknown";
      const dateVerified = day.length > 0 && day.every((item) => item.dateVerified);
      return {
        stayDate,
        checkOut: addDays(stayDate, 1),
        state: day.some((item) => item.error || item.blocked) ? "partial" : "ready",
        availability,
        minAmount: currencies.length === 1 && prices.length ? Math.min(...prices) : undefined,
        currency: currencies.length === 1 ? currencies[0] : undefined,
        sourceUrl: day[0]?.url,
        identityVerified,
        dateVerified,
        rooms,
        message: dateVerified
          ? "Agoda 的每個房間頁面分開觀察；平台沒有公開可靠待售數量。"
          : "日期未能從回傳頁面確認，數值維持未知。",
      };
    });
    const completedDays = observations.filter((item) => item.dateVerified).length;
    const state: OtaPlatformScan["state"] = results.every((item) => item.blocked)
      ? "blocked"
      : completedDays === request.days
        ? "ready"
        : completedDays
          ? "partial"
          : "failed";
    return {
      platform: "agoda",
      state,
      capturedAt: new Date().toISOString(),
      requestedDays: request.days,
      completedDays,
      identity,
      observations,
      warnings: [
        "水芳在 Agoda 以獨立房間頁面販售；102 尚未找到可驗證頁面，因此不會推論整間住宿售罄。",
        "Agoda 頁面可能忽略要求的 TWD 並回傳其他幣別；系統保留來源幣別，不自行換算。",
        "Agoda 未公開可靠待售間數，數量一律顯示未知。",
      ],
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return failedScan("agoda", request, started, error);
  }
}

async function scanTrip(request: OtaScanRequest): Promise<OtaPlatformScan> {
  const started = Date.now();
  const sourceUrl =
    safePlatformUrl(request.sourceUrl, "trip") ??
    (isSweetfun(request) ? TRIP_SWEETFUN_URL : undefined);
  if (!sourceUrl) {
    return {
      platform: "trip",
      state: "not_found",
      capturedAt: new Date().toISOString(),
      requestedDays: request.days,
      completedDays: 0,
      identity: { platform: "trip", status: "not_found", evidence: [] },
      observations: [],
      warnings: ["沒有找到 Trip.com 房源網址。"],
      durationMs: Date.now() - started,
    };
  }
  const jobs = Array.from({ length: request.days }, (_, index) => {
    const stayDate = addDays(request.startDate, index);
    const url = new URL(sourceUrl);
    url.searchParams.set("checkIn", stayDate);
    url.searchParams.set("checkOut", addDays(stayDate, 1));
    url.searchParams.set("adult", String(request.adults));
    url.searchParams.set("children", "0");
    url.searchParams.set("crn", "1");
    url.searchParams.set("curr", "TWD");
    return { stayDate, checkOut: addDays(stayDate, 1), url: url.href };
  });

  try {
    const results = await withBrowser(async (sandbox) => {
      await command(sandbox, ["open", jobs[0]!.url]);
      await command(sandbox, ["wait", "3000"]);
      const serializedJobs = JSON.stringify(jobs).replace(/</g, "\\u003c");
      return evaluate<Array<BrowserDayResult & BrowserIdentity>>(
        sandbox,
        `(async()=>{
          const jobs=${serializedJobs};
          const parse=async(job)=>{
            try{
              const response=await fetch(job.url,{credentials:'include',redirect:'follow'});
              const html=await response.text();
              const doc=new DOMParser().parseFromString(html,'text/html');
              const body=(doc.body?.innerText||doc.body?.textContent||'').replace(/\\s+/g,' ');
              const scripts=[...doc.scripts].map(s=>s.textContent||'').join('\\n');
              const blocked=/Sign in to Trip\\.com|登入 \\/ 註冊即視同|captcha|機器人驗證/i.test((doc.title||'')+' '+body);
              const compactIn=job.stayDate.replaceAll('-','');
              const compactOut=job.checkOut.replaceAll('-','');
              const dateVerified=!blocked&&(
                scripts.includes('\\"checkIn\\":\\"'+compactIn+'\\"')&&scripts.includes('\\"checkOut\\":\\"'+compactOut+'\\"')||
                scripts.includes('\\"checkIn\\":\\"'+job.stayDate.replaceAll('-','/')+'\\"')&&scripts.includes('\\"checkOut\\":\\"'+job.checkOut.replaceAll('-','/')+'\\"')
              );
              const name=(body.match(/水芳瑞芳|Sweetfun/i)||[])[0]||doc.title.split('-')[0].trim();
              const address=(body.match(/新北[^|]{0,10}瑞芳區[^|]{0,30}(?:路|街)[^|]{0,20}號/)||[])[0];
              const registrationNumber=(body.match(/新北市民宿\\s*402\\s*號/)||[])[0];
              const alternative=/下列房型並未完全符合您的需求/.test(body);
              return {...job,url:response.url,title:doc.title,name,address,registrationNumber,dateVerified,blocked,soldOut:false,available:false,sourceText:alternative?'Trip.com 只回傳未完全符合條件的替代房型，未公開可採用價格。':'Trip.com 沒有公開可採用的逐房型價格。'};
            }catch(error){return {...job,dateVerified:false,error:String(error)}}
          };
          const output=[];
          for(let index=0;index<jobs.length;index+=5){output.push(...await Promise.all(jobs.slice(index,index+5).map(parse)))}
          return JSON.stringify(output);
        })()`,
        1_500_000,
      );
    });
    const first = results.find((item) => !item.error && !item.blocked);
    const identity = propertyIdentity("trip", request, first ?? { url: sourceUrl, blocked: true });
    const identityVerified = identity.status === "confirmed";
    const observations: OtaDayObservation[] = results.map((item) => ({
      stayDate: item.stayDate,
      checkOut: item.checkOut,
      state: item.error || item.blocked ? "partial" : "ready",
      availability: "unknown",
      sourceUrl: item.url,
      identityVerified,
      dateVerified: item.dateVerified,
      rooms: [],
      message: item.error ?? item.sourceText,
    }));
    const completedDays = observations.filter((item) => item.dateVerified).length;
    return {
      platform: "trip",
      state: results.every((item) => item.blocked)
        ? "blocked"
        : completedDays === request.days
          ? "partial"
          : completedDays
            ? "partial"
            : "failed",
      capturedAt: new Date().toISOString(),
      requestedDays: request.days,
      completedDays,
      identity,
      observations,
      warnings: [
        "Trip.com 能核對住宿、日期與登記證，但房價區塊可能要求登入或只提供不完全符合條件的替代房型。",
        "SEO 的 priceRange 不是指定入住日價格，系統刻意不採用。",
      ],
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return failedScan("trip", request, started, error);
  }
}

function failedScan(
  platform: OtaPlatform,
  request: OtaScanRequest,
  started: number,
  error: unknown,
): OtaPlatformScan {
  const detail = error instanceof Error ? error.message : "unknown_error";
  return {
    platform,
    state: "failed",
    capturedAt: new Date().toISOString(),
    requestedDays: request.days,
    completedDays: 0,
    identity: { platform, status: "not_found", evidence: [] },
    observations: [],
    warnings: [`平台資料取得失敗：${detail.slice(0, 240)}`],
    durationMs: Date.now() - started,
  };
}

export async function scanOtaPlatform(request: OtaScanRequest): Promise<OtaPlatformScan> {
  switch (request.platform) {
    case "booking":
      return scanBooking(request);
    case "agoda":
      return scanAgoda(request);
    case "trip":
      return scanTrip(request);
  }
}

export function normalizeSourceOverrides(
  platform: OtaPlatform,
  value: unknown,
): OtaSourceOverride[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 20)
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const candidate = item as Record<string, unknown>;
      const url = safePlatformUrl(
        typeof candidate.url === "string" ? candidate.url : undefined,
        platform,
      );
      if (!url) return null;
      const roomNumber =
        typeof candidate.roomNumber === "string"
          ? candidate.roomNumber.trim().slice(0, 30)
          : undefined;
      return { url, roomNumber };
    })
    .filter((item): item is OtaSourceOverride => Boolean(item));
}
