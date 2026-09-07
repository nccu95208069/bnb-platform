import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";

import { normalizeTaiwanAddress } from "./address";
import { extractRoomFeatures, SWEETFUN_GOLDEN_ROOMS } from "./rooms";
import type {
  CanonicalRoomDraft,
  CompetitorRadarAnalysis,
  IdentityEvidence,
  PlatformKey,
  PlatformSourceDraft,
  RoomDraftOrigin,
} from "./types";

const MAX_HTML_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const MAX_ROOM_PAGES = 12;
const FETCH_TIMEOUT_MS = 12_000;
const ROOM_FETCH_CONCURRENCY = 4;

const LODGING_TYPES = new Set([
  "lodgingbusiness",
  "hotel",
  "motel",
  "resort",
  "hostel",
  "bedandbreakfast",
  "vacationrental",
]);

const PLATFORM_HOSTS: Record<Exclude<PlatformKey, "official">, RegExp[]> = {
  booking: [/(^|\.)booking\.com$/i],
  agoda: [/(^|\.)agoda\.com$/i],
  trip: [/(^|\.)(trip|ctrip)\.com$/i],
};

export class PublicUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicUrlError";
  }
}

interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  html: string;
}

interface PinnedPublicTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

interface RawHttpPage {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface WebsiteMetadata {
  name: string;
  description?: string;
  address?: string;
  registrationNumber?: string;
  phone?: string;
  latitude?: number;
  longitude?: number;
}

interface DiscoveredLink {
  url: string;
  label: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return undefined;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match)
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function stripTags(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function attributeValue(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, "i");
  return pattern.exec(attributes)?.[2];
}

function extractMeta(html: string, key: string): string | undefined {
  const tagPattern = /<meta\b([^>]+)>/gi;
  for (const match of html.matchAll(tagPattern)) {
    const attributes = match[1] ?? "";
    const name = attributeValue(attributes, "name") ?? attributeValue(attributes, "property");
    if (name?.toLowerCase() !== key.toLowerCase()) continue;
    const content = attributeValue(attributes, "content");
    if (content) return decodeHtmlEntities(content).trim();
  }
  return undefined;
}

function extractFirstTag(html: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const value = pattern.exec(html)?.[1];
  return value ? stripTags(value) : undefined;
}

function flattenJsonLd(value: unknown, output: JsonRecord[]): void {
  if (Array.isArray(value)) {
    for (const item of value) flattenJsonLd(item, output);
    return;
  }
  if (!isRecord(value)) return;
  output.push(value);
  if (Array.isArray(value["@graph"])) flattenJsonLd(value["@graph"], output);
}

function parseJsonLd(html: string): JsonRecord[] {
  const nodes: JsonRecord[] = [];
  const pattern = /<script\b[^>]*type\s*=\s*(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    const raw = decodeHtmlEntities(match[2] ?? "").trim();
    if (!raw) continue;
    try {
      flattenJsonLd(JSON.parse(raw), nodes);
    } catch {
      // Invalid third-party JSON-LD should not fail the entire analysis.
    }
  }
  return nodes;
}

function jsonLdTypes(node: JsonRecord): string[] {
  const value = node["@type"];
  const types = Array.isArray(value) ? value : [value];
  return types
    .map(asString)
    .filter((item): item is string => Boolean(item))
    .map((item) => item.toLowerCase());
}

function findLodgingNode(nodes: JsonRecord[]): JsonRecord | undefined {
  return nodes.find((node) => jsonLdTypes(node).some((type) => LODGING_TYPES.has(type)));
}

function formatAddress(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct) return direct;
  if (!isRecord(value)) return undefined;
  return [
    asString(value.postalCode),
    asString(value.addressRegion),
    asString(value.addressLocality),
    asString(value.streetAddress),
  ]
    .filter(Boolean)
    .join("");
}

function isPlausibleRegistrationNumber(value: string | undefined): boolean {
  if (!value) return false;
  const compact = value.normalize("NFKC").replace(/\s+/g, "");
  const digitCount = (compact.match(/\d/g) ?? []).length;
  if (digitCount < 1) return false;
  if (/(?:電話|手機|fax|tel)/i.test(compact)) return false;
  return (
    /(?:民宿|旅館|hotel|registration|license|登記|證號|字號|編號)/i.test(compact) ||
    /^[A-Z]?\d{2,10}(?:-\d+)?號?$/i.test(compact)
  );
}

function extractIdentifier(value: unknown): string | undefined {
  const direct = asString(value);
  if (isPlausibleRegistrationNumber(direct)) return direct;

  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    if (!isRecord(item)) continue;
    const candidate = asString(item.value) ?? asString(item.identifier) ?? asString(item.name);
    if (isPlausibleRegistrationNumber(candidate)) return candidate;
  }
  return undefined;
}

function extractRegistrationNumber(text: string): string | undefined {
  const patterns = [
    /((?:臺|台|新北|宜蘭|花蓮|臺東|台東|澎湖|金門|連江)?[^，。;；\s]{0,8}(?:民宿|旅館)(?:登記證|登記|編號|證號|字號)?\s*[:：]?\s*(?:第\s*)?[A-Z]?\d{1,10}(?:-\d+)?\s*號?)/i,
    /(?:registration|license)\s*(?:no\.?|number)?\s*[:：#]?\s*([A-Z]?\d{1,12}(?:-\d+)?)/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] && isPlausibleRegistrationNumber(match[1])) return match[1].trim();
  }
  return undefined;
}

function extractAddressFromText(text: string): string | undefined {
  const chinese = text.match(
    /((?:臺|台)?[^\s，。]{1,5}[縣市][^\s，。]{0,12}(?:區|鄉|鎮|市)(?:[^\s，。]{0,12}(?:村|里))?(?:\d+鄰)?[^\s，。]{1,20}(?:大道|路|街)(?:\d+段)?(?:\d+巷)?(?:\d+弄)?\d+(?:-\d+|之\d+)?號(?:之\d+樓|\d+樓)?)/,
  );
  if (chinese?.[1]) return chinese[1];

  const english = text.match(
    /((?:No\.\s*)?\d+(?:-\d+)?\s*,?\s*[A-Za-z][A-Za-z .'-]{1,45}(?:Road|Rd\.|Street|St\.|Avenue|Ave\.)\s*,?\s*[A-Za-z .'-]{2,80})/i,
  );
  return english?.[1]?.trim();
}

function extractPhone(text: string): string | undefined {
  const match = text.match(/(?:\+?886[-\s]?)?(?:0?\d{1,2}[-\s]?)?\d{3,4}[-\s]?\d{3,4}/);
  if (!match?.[0]) return undefined;
  const digits = match[0].replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 12 ? match[0].trim() : undefined;
}

function simplifyTitle(title: string): string {
  return (
    title
      .split(/[|｜]/)[0]
      ?.split(/[-–—]\s*(?:官方|官網|住宿|訂房)/)[0]
      ?.trim() || title.trim()
  );
}

function getGeo(node: JsonRecord | undefined): { latitude?: number; longitude?: number } {
  if (!node || !isRecord(node.geo)) return {};
  const latitude = Number(node.geo.latitude);
  const longitude = Number(node.geo.longitude);
  return {
    latitude: Number.isFinite(latitude) ? latitude : undefined,
    longitude: Number.isFinite(longitude) ? longitude : undefined,
  };
}

function extractWebsiteMetadata(html: string, finalUrl: string): WebsiteMetadata {
  const nodes = parseJsonLd(html);
  const lodging = findLodgingNode(nodes);
  const visibleText = stripTags(html);
  const rawTitle = extractFirstTag(html, "title") ?? new URL(finalUrl).hostname;
  const title = simplifyTitle(rawTitle);
  const name =
    asString(lodging?.name) ??
    extractMeta(html, "og:site_name") ??
    extractMeta(html, "og:title")?.split(/[|｜]/)[0]?.trim() ??
    title;
  const identifier = extractIdentifier(lodging?.identifier);
  const geo = getGeo(lodging);

  return {
    name,
    description:
      asString(lodging?.description) ??
      extractMeta(html, "description") ??
      extractMeta(html, "og:description"),
    address: formatAddress(lodging?.address) ?? extractAddressFromText(visibleText),
    registrationNumber: identifier ?? extractRegistrationNumber(visibleText),
    phone: asString(lodging?.telephone) ?? extractPhone(visibleText),
    ...geo,
  };
}

function isBlockedIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return true;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

function isBlockedIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isBlockedIpv4(address);
  if (version !== 6) return true;

  const normalized = address.toLowerCase();
  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedIpv4) return isBlockedIpv4(mappedIpv4);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8")
  );
}

async function validateAndPinPublicUrl(value: string): Promise<PinnedPublicTarget> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicUrlError("網址格式不正確。");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new PublicUrlError("只支援 http 或 https 網址。");
  }
  if (url.username || url.password) throw new PublicUrlError("網址不可包含帳號或密碼。");
  if (url.port && !["80", "443"].includes(url.port)) {
    throw new PublicUrlError("不支援非標準連接埠。");
  }

  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan")
  ) {
    throw new PublicUrlError("不可分析內部網路網址。");
  }

  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (isBlockedIp(hostname)) throw new PublicUrlError("不可分析私有或保留 IP。");
    return { url, address: hostname, family: literalFamily as 4 | 6 };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = (await lookup(hostname, { all: true, verbatim: true })) as Array<{
      address: string;
      family: number;
    }>;
  } catch {
    throw new PublicUrlError("無法解析這個網址的網域。");
  }

  if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
    throw new PublicUrlError("網址解析到私有或保留網路位址。");
  }

  const pinned = addresses.find(({ family }) => family === 4) ?? addresses[0];
  if (!pinned || (pinned.family !== 4 && pinned.family !== 6)) {
    throw new PublicUrlError("網域沒有可安全連線的位址。");
  }
  return { url, address: pinned.address, family: pinned.family };
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function requestPinnedPage(target: PinnedPublicTarget): Promise<RawHttpPage> {
  return new Promise((resolve, reject) => {
    const { url, address, family } = target;
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      response?.destroy();
      request?.destroy();
      reject(error);
    };

    const succeed = (page: RawHttpPage) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(page);
    };

    const onResponse = (incoming: IncomingMessage) => {
      response = incoming;
      const contentLength = Number(headerValue(incoming.headers["content-length"]));
      if (Number.isFinite(contentLength) && contentLength > MAX_HTML_BYTES) {
        fail(new PublicUrlError("網頁內容超過 2 MB，已停止分析。"));
        return;
      }

      incoming.on("data", (chunk: Buffer) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.byteLength;
        if (bytes > MAX_HTML_BYTES) {
          fail(new PublicUrlError("網頁內容超過 2 MB，已停止分析。"));
          return;
        }
        chunks.push(buffer);
      });
      incoming.once("aborted", () => fail(new PublicUrlError("網站在回傳內容時中斷連線。")));
      incoming.once("error", () => fail(new PublicUrlError("讀取網站內容失敗。")));
      incoming.once("end", () =>
        succeed({
          status: incoming.statusCode ?? 0,
          headers: incoming.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    };

    const path = `${url.pathname || "/"}${url.search}`;
    const commonOptions = {
      protocol: url.protocol,
      hostname: address,
      family,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      method: "GET",
      path,
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Encoding": "identity",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.7",
        Connection: "close",
        Host: url.host,
        "User-Agent":
          "Mozilla/5.0 (compatible; SweetfunCompetitorRadar/0.1; +https://sweetfun-os.vercel.app)",
      },
    };

    try {
      request =
        url.protocol === "https:"
          ? httpsRequest(
              {
                ...commonOptions,
                servername: isIP(url.hostname) ? undefined : url.hostname,
                checkServerIdentity: (_hostname, certificate) =>
                  checkServerIdentity(url.hostname, certificate),
              },
              onResponse,
            )
          : httpRequest(commonOptions, onResponse);
    } catch {
      fail(new PublicUrlError("無法建立網站連線。"));
      return;
    }

    request.once("error", (error) => {
      if (error instanceof PublicUrlError) {
        fail(error);
      } else {
        fail(new PublicUrlError("無法連線到這個網站。"));
      }
    });
    timer = setTimeout(
      () => fail(new PublicUrlError("網站回應逾時。")),
      FETCH_TIMEOUT_MS,
    );
    request.end();
  });
}

async function fetchPublicHtml(input: string): Promise<FetchedPage> {
  let current = await validateAndPinPublicUrl(input);
  const requestedUrl = current.url.toString();

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await requestPinnedPage(current);

    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers.location);
      if (!location) throw new PublicUrlError("網站重新導向但沒有提供目的地。");
      if (redirectCount === MAX_REDIRECTS) {
        throw new PublicUrlError("網站重新導向次數過多。");
      }
      current = await validateAndPinPublicUrl(new URL(location, current.url).toString());
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new PublicUrlError(`網站回傳 HTTP ${response.status}，無法分析。`);
    }
    const contentType = headerValue(response.headers["content-type"]).toLowerCase();
    if (contentType && !contentType.includes("text/html") && !contentType.includes("xhtml")) {
      throw new PublicUrlError("網址不是 HTML 網頁。");
    }
    const contentEncoding = headerValue(response.headers["content-encoding"]).toLowerCase();
    if (contentEncoding && contentEncoding !== "identity") {
      throw new PublicUrlError("網站未依要求回傳未壓縮 HTML，為避免解壓縮風險已停止分析。");
    }

    return {
      requestedUrl,
      finalUrl: current.url.toString(),
      html: response.body,
    };
  }

  throw new PublicUrlError("網站重新導向次數過多。");
}

function likelyRoomLabel(value: string): boolean {
  const text = stripTags(value);
  if (text.length < 2 || text.length > 100) return false;
  if (/^(?:房型|客房|rooms?|住宿|stay|view rooms?|查看更多|立即訂房|book now)$/i.test(text)) {
    return false;
  }
  return /(?:\b[1-9]\d{2}\b|雙人|四人|三人|家庭|套房|包棟|整棟|河景|海景|山景|天窗|無窗|double|twin|quad|triple|suite|villa|room)/i.test(
    text,
  );
}

function extractLinks(html: string, baseUrl: string): DiscoveredLink[] {
  const output: DiscoveredLink[] = [];
  const seen = new Set<string>();
  const pattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const href = attributeValue(match[1] ?? "", "href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      continue;
    }
    try {
      const url = new URL(href, baseUrl);
      url.hash = "";
      const normalized = url.toString();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      output.push({ url: normalized, label: stripTags(match[2] ?? "") });
    } catch {
      // Ignore malformed page links.
    }
  }
  return output;
}

function roomDetailLinks(links: DiscoveredLink[], baseUrl: string): DiscoveredLink[] {
  const base = new URL(baseUrl);
  return links
    .filter(({ url, label }) => {
      const candidate = new URL(url);
      if (candidate.hostname !== base.hostname) return false;
      const pathLooksSpecific = /\/(?:rooms?|room-types?|accommodations?|stay)\/[^/?#]+/i.test(
        candidate.pathname,
      );
      return pathLooksSpecific || (likelyRoomLabel(label) && candidate.pathname !== base.pathname);
    })
    .slice(0, MAX_ROOM_PAGES);
}

function platformForUrl(url: string): Exclude<PlatformKey, "official"> | null {
  const host = new URL(url).hostname;
  for (const [platform, patterns] of Object.entries(PLATFORM_HOSTS) as Array<
    [Exclude<PlatformKey, "official">, RegExp[]]
  >) {
    if (patterns.some((pattern) => pattern.test(host))) return platform;
  }
  return null;
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-TW")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return normalized || randomUUID().slice(0, 8);
}

function roomFromText(
  name: string,
  sourceUrl: string | undefined,
  origin: RoomDraftOrigin,
  context = name,
): CanonicalRoomDraft {
  const features = extractRoomFeatures(`${name} ${context}`);
  return {
    id: `room-${features.roomNumber ?? slug(name)}`,
    name,
    sourceName: name,
    sourceUrl,
    roomNumber: features.roomNumber,
    capacity: features.capacity,
    bundle: features.bundle,
    features: [...new Set([...features.views, ...features.amenities])],
    origin,
    editable: true,
  };
}

function roomsFromJsonLd(html: string, sourceUrl: string): CanonicalRoomDraft[] {
  const rooms: CanonicalRoomDraft[] = [];
  for (const node of parseJsonLd(html)) {
    if (!jsonLdTypes(node).some((type) => ["hotelroom", "room", "suite"].includes(type))) continue;
    const name = asString(node.name);
    if (!name) continue;
    rooms.push(
      roomFromText(name, sourceUrl, "website_jsonld", JSON.stringify(node).slice(0, 3000)),
    );
  }
  return rooms;
}

function roomsFromListingLinks(links: DiscoveredLink[]): CanonicalRoomDraft[] {
  return links
    .filter(({ label }) => likelyRoomLabel(label))
    .map(({ label, url }) => roomFromText(label, url, "website_listing"));
}

function roomFromDetailPage(page: FetchedPage): CanonicalRoomDraft | null {
  const name = extractFirstTag(page.html, "h1") ?? extractMeta(page.html, "og:title");
  if (!name || !likelyRoomLabel(name)) return null;
  return roomFromText(name, page.finalUrl, "website_detail", stripTags(page.html).slice(0, 8000));
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index]!) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}

function mergeRooms(rooms: CanonicalRoomDraft[]): CanonicalRoomDraft[] {
  const priority: Record<RoomDraftOrigin, number> = {
    website_detail: 4,
    website_jsonld: 3,
    website_listing: 2,
    golden_fixture: 1,
    manual: 5,
  };
  const byKey = new Map<string, CanonicalRoomDraft>();
  for (const room of rooms) {
    const key = room.roomNumber ?? slug(room.name);
    const current = byKey.get(key);
    if (!current || priority[room.origin] > priority[current.origin]) byKey.set(key, room);
  }
  return [...byKey.values()].sort((left, right) => {
    if (left.roomNumber && right.roomNumber) return left.roomNumber.localeCompare(right.roomNumber);
    if (left.roomNumber) return -1;
    if (right.roomNumber) return 1;
    return left.name.localeCompare(right.name, "zh-TW");
  });
}

function dateInTaipei(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function platformDrafts(
  propertyName: string,
  finalUrl: string,
  links: DiscoveredLink[],
): PlatformSourceDraft[] {
  const candidateLinks = new Map<Exclude<PlatformKey, "official">, string>();
  for (const link of links) {
    const platform = platformForUrl(link.url);
    if (platform && !candidateLinks.has(platform)) candidateLinks.set(platform, link.url);
  }

  const labels: Record<PlatformKey, string> = {
    official: "官網",
    booking: "Booking.com",
    agoda: "Agoda",
    trip: "Trip.com",
  };

  return (["official", "booking", "agoda", "trip"] as PlatformKey[]).map((platform) => {
    if (platform === "official") {
      return {
        platform,
        label: labels[platform],
        status: "discovered",
        sourceUrl: finalUrl,
        matchedName: propertyName,
        identityConfidence: 1,
        identityEvidence: [],
        rooms: [],
        message: "已完成官網住宿資訊與房型草稿擷取。",
      };
    }
    const candidate = candidateLinks.get(platform);
    return {
      platform,
      label: labels[platform],
      status: candidate ? "identity_review" : "adapter_pending",
      sourceUrl: candidate,
      identityEvidence: [],
      rooms: [],
      message: candidate
        ? "官網中找到平台候選網址；下一步會用登記編號＋模糊地址雙軌確認同一住宿。"
        : "平台搜尋與價格／待售量 adapter 尚未接入；本版不會填入推測價格。",
    };
  });
}

function seedIdentityEvidence(metadata: WebsiteMetadata, finalUrl: string): IdentityEvidence[] {
  const evidence: IdentityEvidence[] = [
    {
      field: "website",
      label: "輸入官網",
      strength: "supporting",
      score: 1,
      detail: `成功載入 ${new URL(finalUrl).hostname}。`,
    },
    {
      field: "name",
      label: "住宿名稱",
      strength: "supporting",
      score: metadata.name ? 1 : 0,
      detail: metadata.name ? `辨識為「${metadata.name}」。` : "網站未提供可辨識名稱。",
    },
  ];
  if (metadata.registrationNumber) {
    evidence.push({
      field: "registration_number",
      label: "民宿／旅館登記編號",
      strength: "strong",
      score: 1,
      detail: `官網找到登記資訊：${metadata.registrationNumber}`,
    });
  }
  if (metadata.address) {
    evidence.push({
      field: "address",
      label: "地址",
      strength: "strong",
      score: 1,
      detail: `官網找到地址：${metadata.address}`,
    });
  }
  if (metadata.phone) {
    evidence.push({
      field: "phone",
      label: "電話",
      strength: "supporting",
      score: 1,
      detail: `官網找到電話：${metadata.phone}`,
    });
  }
  return evidence;
}

export async function analyzeOfficialWebsite(inputUrl: string): Promise<CompetitorRadarAnalysis> {
  const root = await fetchPublicHtml(inputUrl);
  const metadata = extractWebsiteMetadata(root.html, root.finalUrl);
  const links = extractLinks(root.html, root.finalUrl);
  const details = roomDetailLinks(links, root.finalUrl);
  const detailResults = await mapWithConcurrency(details, ROOM_FETCH_CONCURRENCY, ({ url }) =>
    fetchPublicHtml(url),
  );

  const detailRooms = detailResults.flatMap((result) => {
    if (result.status !== "fulfilled") return [];
    const room = roomFromDetailPage(result.value);
    return room ? [room] : [];
  });

  let canonicalRooms = mergeRooms([
    ...roomsFromJsonLd(root.html, root.finalUrl),
    ...roomsFromListingLinks(details),
    ...detailRooms,
  ]);
  const warnings: string[] = [];

  const host = new URL(root.finalUrl).hostname.replace(/^www\./, "").toLowerCase();
  if (host === "sweetfuntw.com" || host.endsWith(".sweetfuntw.com")) {
    const before = canonicalRooms.length;
    canonicalRooms = mergeRooms([...canonicalRooms, ...SWEETFUN_GOLDEN_ROOMS]);
    if (canonicalRooms.length > before) {
      warnings.push(
        "部分水芳房型未能從本次網頁回應完整擷取，已用公開安全的 golden fixture 補足；補入列已標示來源，可由使用者編輯。",
      );
    }
  }

  if (!canonicalRooms.length) {
    warnings.push("官網未提供可辨識的房型頁或結構化資料，請由使用者手動新增房型。");
  }
  const failedDetails = detailResults.filter((result) => result.status === "rejected").length;
  if (failedDetails) {
    warnings.push(`${failedDetails} 個房型詳情頁擷取失敗；其餘成功資料仍保留。`);
  }

  const identityEvidence = seedIdentityEvidence(metadata, root.finalUrl);
  const hasStrongIdentity = Boolean(metadata.registrationNumber || metadata.address);
  const confidence = metadata.registrationNumber ? 0.98 : metadata.address ? 0.9 : 0.62;
  const start = dateInTaipei();

  return {
    analysisId: randomUUID(),
    analyzedAt: new Date().toISOString(),
    requestedUrl: inputUrl,
    finalUrl: root.finalUrl,
    property: {
      name: metadata.name,
      sourceUrl: root.finalUrl,
      websiteHost: new URL(root.finalUrl).hostname,
      description: metadata.description,
      address: metadata.address,
      normalizedAddress: metadata.address ? normalizeTaiwanAddress(metadata.address) : undefined,
      registrationNumber: metadata.registrationNumber,
      phone: metadata.phone,
      latitude: metadata.latitude,
      longitude: metadata.longitude,
      identityStatus: hasStrongIdentity ? "confirmed" : "review",
      confidence,
    },
    identityEvidence,
    canonicalRooms,
    platformSources: platformDrafts(metadata.name, root.finalUrl, links),
    dateWindow: { start, end: addDays(start, 13), days: 14 },
    warnings,
  };
}
