import "server-only";

import { Sandbox } from "@vercel/sandbox";

import { AGODA_EVIDENCE_VERSION } from "./ota-evidence";
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


interface TripDayResult {
  stayDate: string;
  checkOut: string;
  url: string;
  dateVerified: boolean;
  sourceText?: string;
  error?: string;
}

function addDays(value: string, amount: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}


function isSweetfun(request: OtaScanRequest): boolean {
  const match = scorePropertyIdentity(request.property, {
    name: "水芳 Sweetfun", address: "新北市瑞芳區中山路24之1號",
    registrationNumber: "新北市民宿402號", websiteUrl: "https://www.sweetfuntw.com/",
  });
  return match.status === "confirmed" && !match.conflicts.length;
}

function safePlatformUrl(value: string | undefined, platform: OtaPlatform): string | undefined {
  if (!value || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return undefined;
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
    networkPolicy: {
      allow: ["*.booking.com", "*.bstatic.com", "*.agoda.com", "*.agoda.net", "*.agoda.io", "*.trip.com", "*.ctrip.com", "*.tripcdn.com"],
      subnets: { deny: ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16", "224.0.0.0/4"] },
    },
  });
  try {
    // The egress API accepts IPv4 CIDRs only. Disable IPv6 inside this isolated
    // VM before opening any untrusted page, while preserving IPv4 deny rules.
    const ipv6 = await sandbox.runCommand({ cmd: "sh", args: ["-c", "if test -e /proc/sys/net/ipv6/conf/all/disable_ipv6; then sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1; fi"] });
    if (ipv6.exitCode !== 0) throw new Error("ota_ipv6_isolation_failed");
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
): OtaPropertyIdentity {
  const match = scorePropertyIdentity(request.property, {
    name: observed.name ?? observed.title,
    address: observed.address,
    registrationNumber: observed.registrationNumber,
    websiteUrl: observed.url,
  });
  const evidence = match.evidence.map((item) => `${item.label}：${item.detail}`);
  const status = observed.blocked ? "not_found" : match.status;
  return {
    platform,
    sourceUrl: observed.url,
    sourceName: observed.name ?? observed.title,
    sourceAddress: observed.address,
    sourceRegistrationNumber: observed.registrationNumber,
    score: match.score,
    status,
    evidence,
  };
}


function emptyObservation(
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
          return {url:location.href,title:document.title,name:h2,address,registrationNumber:license,roomNames,blocked:Boolean(document.querySelector('script[src*="awswaf.com"],#challenge-container'))||/captcha|verify you are human|機器人驗證|request rejected/i.test(body)};
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
          stayDate,
          identityVerified ? "Booking 住宿已核對，但未取得可驗證入住日期，價格與房量保持未知。" : "Booking 住宿與入住日期尚未核對，價格與房量保持未知。",
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
      completedDays: 0,
      identity,
      observations,
      warnings: [
        "Booking 房源頁會在轉址或送出日期時靜默遺失 query；日期未通過驗證前不顯示任何價格。",
        "房型目錄為即時頁面觀察，並不是未來日期的可售量。",
      ],
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return failedScan("booking", request, started, error);
  }
}

async function scanAgoda(request: OtaScanRequest): Promise<OtaPlatformScan> {
  // The owner supplied contrary dated evidence from a multi-room property page.
  // Legacy individual-room URLs are withdrawn, not silently used as fallbacks.
  return {
    platform: "agoda", state: "partial", collectionState: "withdrawn",
    evidenceVersion: AGODA_EVIDENCE_VERSION,
    capturedAt: new Date().toISOString(), requestedDays: request.days, completedDays: 0,
    identity: { platform: "agoda", status: "review", evidence: [] },
    observations: [], durationMs: 0,
    warnings: ["舊版逐房頁面結果已撤回；正在核對包含六個房型的住宿頁，暫不採用價格或售完狀態。"],
  };
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
      return evaluate<Array<TripDayResult & BrowserIdentity>>(
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
              const hasProperty=/水芳瑞芳|Sweetfun|新北市民宿\\s*402/i.test(body);
              const blocked=/captcha|機器人驗證/i.test((doc.title||'')+' '+body)||/Sign in to Trip\\.com/i.test(doc.title||'')||(!hasProperty&&/(?:登入|sign in)/i.test(body));
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
          for(const job of jobs){const result=await parse(job);output.push(result);if(result.blocked)break;}
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
        "Trip.com 本次是否完成住宿與日期核對以結果為準；平台可能要求登入或提供不符合條件的替代房型。",
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
      if (process.env.RADAR_BOOKING_COLLECTION_ENABLED !== "true") return {
        platform: "booking", state: "blocked", collectionState: "paused",
        capturedAt: "2026-09-08T05:05:38.115Z", requestedDays: request.days, completedDays: 0,
        identity: { platform: "booking", status: "not_found", sourceUrl: isSweetfun(request) ? BOOKING_SWEETFUN_URL : undefined, evidence: [] },
        observations: [], durationMs: 0,
        warnings: ["Booking 回傳防護驗證頁，這條雲端採集路線已暫停；沒有取得房型或報價。"],
      };
      return scanBooking(request);
    case "agoda":
      return scanAgoda(request);
    case "trip":
      // Pause after a restricted response; ordinary retries must not probe again.
      if (process.env.RADAR_TRIP_COLLECTION_ENABLED !== "true") return {
        platform: "trip", state: "blocked", collectionState: "paused",
        capturedAt: "2026-09-08T04:11:20.414Z", requestedDays: request.days, completedDays: 0,
        identity: { platform: "trip", status: "not_found", sourceUrl: isSweetfun(request) ? TRIP_SWEETFUN_URL : undefined, evidence: [] },
        observations: [], durationMs: 0,
        warnings: ["Trip.com 採集路線於 2026-09-08 回傳受限結果，已暫停。這次未重新連線，日期、價格與參考房量維持無法確認。"],
      };
      return scanTrip(request);
  }
}

export function normalizeSourceOverrides(
  platform: OtaPlatform,
  value: unknown,
): OtaSourceOverride[] {
  if (!Array.isArray(value)) return [];
  const normalized: OtaSourceOverride[] = [];
  for (const item of value.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Record<string, unknown>;
    const url = safePlatformUrl(
      typeof candidate.url === "string" ? candidate.url : undefined,
      platform,
    );
    if (!url) continue;
    const roomNumber =
      typeof candidate.roomNumber === "string"
        ? candidate.roomNumber.trim().slice(0, 30)
        : undefined;
    normalized.push(roomNumber ? { url, roomNumber } : { url });
  }
  return normalized;
}


export function collectionPaused(platform: OtaPlatform): boolean {
  if (platform === "agoda") return true;
  return platform === "booking" ? process.env.RADAR_BOOKING_COLLECTION_ENABLED !== "true" : process.env.RADAR_TRIP_COLLECTION_ENABLED !== "true";
}
