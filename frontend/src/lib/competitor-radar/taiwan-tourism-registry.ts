import { inflateRawSync } from "node:zlib";

import { parseTaiwanAddress, textSimilarity } from "./address";
import { scorePropertyIdentity } from "./identity";
import type {
  PlatformKey,
  PropertyIdentityInput,
  PropertyIdentityMatch,
} from "./types";

const REGISTRY_ARCHIVE_URL =
  "https://media.taiwan.net.tw/XMLReleaseAll_public/v2.0/Zh_tw/Hotel-json.zip";
const REGISTRY_SOURCE_URL = "https://data.gov.tw/dataset/7780";
const REGISTRY_PORTAL_ORIGIN = "https://media.taiwan.net.tw";
const REGISTRY_SEARCH_PATH = "/zh-tw/portal/travel";
const REGISTRY_JSON_PREFIX = "/zh-tw/portal/travel/json/";
const REGISTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_FETCH_TIMEOUT_MS = 8_000;
const MAX_ARCHIVE_BYTES = 32_000_000;
const MAX_JSON_BYTES = 96_000_000;
const MAX_PORTAL_HTML_BYTES = 512_000;
const MAX_RECORD_JSON_BYTES = 512_000;
const MAX_REGISTRY_CANDIDATES = 5;
const MAX_PORTAL_SEARCHES = 3;
const MAX_PORTAL_RECORDS = 5;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const PLATFORM_HOSTS: Record<Exclude<PlatformKey, "official">, RegExp[]> = {
  booking: [/(^|\.)booking\.com$/i],
  agoda: [/(^|\.)agoda\.com$/i],
  trip: [/(^|\.)(trip|ctrip)\.com$/i],
};

interface JsonRecord {
  [key: string]: unknown;
}

export interface TourismRegistryRecord {
  hotelId: string;
  registrationNumber?: string;
  name: string;
  alternateNames: string[];
  address?: string;
  phone?: string;
  websiteUrl?: string;
  reservationUrls: string[];
  sameAsUrls: string[];
  latitude?: number;
  longitude?: number;
  totalRooms?: number;
  lowestPrice?: number;
  ceilingPrice?: number;
  updateTime?: string;
}

export interface TourismRegistryCandidate {
  record: TourismRegistryRecord;
  match: PropertyIdentityMatch;
  matchedName: string;
  platformUrls: Partial<Record<Exclude<PlatformKey, "official">, string>>;
}

interface RegistryCache {
  loadedAt: number;
  records: TourismRegistryRecord[];
}

interface TimedValue<T> {
  loadedAt: number;
  value: T;
}

let archiveCache: RegistryCache | null = null;
let archiveInFlight: Promise<TourismRegistryRecord[]> | null = null;
const portalSearchCache = new Map<string, TimedValue<string[]>>();
const portalRecordCache = new Map<string, TimedValue<TourismRegistryRecord>>();

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getField(record: JsonRecord, ...names: string[]): unknown {
  const lowerNames = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(record)) {
    if (lowerNames.has(key.toLowerCase())) return value;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = asString(value)?.replace(/,/g, "");
  if (!text) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function collectStrings(value: unknown, output: string[]): void {
  const direct = asString(value);
  if (direct) {
    output.push(direct);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
    return;
  }
  if (!isRecord(value)) return;
  for (const child of Object.values(value)) collectStrings(child, output);
}

function collectUrls(value: unknown): string[] {
  const values: string[] = [];
  collectStrings(value, values);
  return unique(
    values.flatMap((value) =>
      value
        .split(/[\s,，;；]+/)
        .map((part) => part.trim())
        .filter((part) => /^https?:\/\//i.test(part)),
    ),
  );
}

function collectAliases(value: unknown): string[] {
  const values: string[] = [];
  collectStrings(value, values);
  return unique(values.filter((item) => item.length >= 2 && item.length <= 120));
}

function firstPhone(value: unknown): string | undefined {
  const values: string[] = [];
  collectStrings(value, values);
  return values.find((item) => {
    const digits = item.replace(/\D/g, "");
    return digits.length >= 8 && digits.length <= 12;
  });
}

function formatPostalAddress(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct) return direct;
  if (!isRecord(value)) return undefined;

  const ordered = [
    getField(value, "City", "County", "AddressRegion", "CityName"),
    getField(value, "Town", "Township", "District", "AddressLocality", "TownName"),
    getField(value, "Village", "VillageName"),
    getField(value, "Neighborhood"),
    getField(value, "StreetAddress", "Address", "Street", "AddressLine"),
  ]
    .map(asString)
    .filter((item): item is string => Boolean(item));

  if (ordered.length) return ordered.join("");
  const fallback: string[] = [];
  collectStrings(value, fallback);
  const joined = fallback.join("");
  return joined || undefined;
}

function collectHotelNodes(value: unknown): JsonRecord[] {
  const result: JsonRecord[] = [];
  const stack: unknown[] = [value];
  const seen = new Set<object>();

  while (stack.length) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);

    if (asString(getField(current, "HotelID")) && asString(getField(current, "HotelName"))) {
      result.push(current);
      continue;
    }
    for (const child of Object.values(current)) {
      if (child && typeof child === "object") stack.push(child);
    }
  }
  return result;
}

export function normalizeRegistryRecord(raw: JsonRecord): TourismRegistryRecord | null {
  const hotelId = asString(getField(raw, "HotelID"));
  const name = asString(getField(raw, "HotelName"));
  if (!hotelId || !name) return null;

  const reservationUrls = collectUrls(getField(raw, "ReservationURLs", "ReservationURL"));
  const sameAsUrls = collectUrls(
    getField(raw, "SameAsURLs", "SameAsURL", "SocialMediaURLs"),
  );
  const websiteUrl = collectUrls(
    getField(raw, "WebsiteURL", "WebsiteUrl", "WebsiteURLs"),
  )[0];

  return {
    hotelId,
    registrationNumber: asString(
      getField(
        raw,
        "HotelLicenseNumber",
        "RegistrationNumber",
        "RegistrationNo",
        "LicenseNumber",
      ),
    ),
    name,
    alternateNames: collectAliases(getField(raw, "AlternateNames", "AlternateName")),
    address: formatPostalAddress(getField(raw, "PostalAddress", "Address")),
    phone: firstPhone(getField(raw, "Telephones", "Telephone", "Phone")),
    websiteUrl,
    reservationUrls,
    sameAsUrls,
    latitude: asNumber(getField(raw, "PositionLat", "Latitude", "Lat")),
    longitude: asNumber(getField(raw, "PositionLon", "Longitude", "Lon", "Lng")),
    totalRooms: asNumber(getField(raw, "TotalRooms")),
    lowestPrice: asNumber(getField(raw, "LowestPrice")),
    ceilingPrice: asNumber(getField(raw, "CeilingPrice")),
    updateTime: asString(getField(raw, "UpdateTime")),
  };
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("registry_zip_eocd_not_found");
}

/** Decode the first JSON entry from the official ZIP without writing to disk. */
export function decodeRegistryArchive(buffer: Buffer): unknown {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("registry_zip_central_directory_invalid");
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const fileNameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const fileName = buffer
      .subarray(cursor + 46, cursor + 46 + fileNameLength)
      .toString("utf8");

    cursor += 46 + fileNameLength + extraLength + commentLength;
    if (!fileName.toLowerCase().endsWith(".json") || fileName.endsWith("/")) continue;
    if (flags & 0x1) throw new Error("registry_zip_encrypted");
    if (uncompressedSize > MAX_JSON_BYTES) throw new Error("registry_json_too_large");
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("registry_zip_local_header_invalid");
    }

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error("registry_zip_entry_truncated");

    const compressed = buffer.subarray(dataStart, dataEnd);
    const decoded =
      method === 0
        ? Buffer.from(compressed)
        : method === 8
          ? inflateRawSync(compressed, { maxOutputLength: MAX_JSON_BYTES })
          : null;
    if (!decoded) throw new Error(`registry_zip_method_${method}_unsupported`);
    if (decoded.length > MAX_JSON_BYTES) throw new Error("registry_json_too_large");
    if (uncompressedSize && decoded.length !== uncompressedSize) {
      throw new Error("registry_zip_size_mismatch");
    }
    return JSON.parse(decoded.toString("utf8").replace(/^\uFEFF/, ""));
  }

  throw new Error("registry_json_entry_not_found");
}

async function readLimitedBytes(response: Response, maximum: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximum) {
    throw new Error("registry_resource_too_large");
  }
  if (!response.body) throw new Error("registry_resource_empty");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > maximum) {
      await reader.cancel();
      throw new Error("registry_resource_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function looksLikeTransportRejection(buffer: Buffer): boolean {
  const prefix = buffer.subarray(0, Math.min(buffer.length, 2_000)).toString("utf8");
  return /Request Rejected|安全性因素暫時被鎖定|requested URL was rejected/i.test(prefix);
}

async function fetchOfficialResource(
  url: URL,
  accept: string,
  maximumBytes: number,
): Promise<{ body: Buffer; contentType: string }> {
  if (url.origin !== REGISTRY_PORTAL_ORIGIN) throw new Error("registry_origin_rejected");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: accept,
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.7",
        "User-Agent": BROWSER_USER_AGENT,
      },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`registry_http_${response.status}`);
    const body = await readLimitedBytes(response, maximumBytes);
    if (looksLikeTransportRejection(body)) throw new Error("registry_transport_rejected");
    return { body, contentType: response.headers.get("content-type")?.toLowerCase() ?? "" };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchArchiveRecords(): Promise<TourismRegistryRecord[]> {
  const { body, contentType } = await fetchOfficialResource(
    new URL(REGISTRY_ARCHIVE_URL),
    "application/zip,application/octet-stream,*/*;q=0.5",
    MAX_ARCHIVE_BYTES,
  );
  if (body.length < 4 || body.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(
      contentType.includes("text/html")
        ? "registry_transport_rejected"
        : "registry_archive_not_zip",
    );
  }
  const payload = decodeRegistryArchive(body);
  const records = collectHotelNodes(payload)
    .map(normalizeRegistryRecord)
    .filter((record): record is TourismRegistryRecord => Boolean(record));
  if (!records.length) throw new Error("registry_contains_no_hotels");
  return records;
}

async function loadArchiveRecords(): Promise<TourismRegistryRecord[]> {
  if (archiveCache && Date.now() - archiveCache.loadedAt < REGISTRY_CACHE_TTL_MS) {
    return archiveCache.records;
  }
  if (archiveInFlight) return archiveInFlight;

  archiveInFlight = fetchArchiveRecords()
    .then((records) => {
      archiveCache = { loadedAt: Date.now(), records };
      return records;
    })
    .finally(() => {
      archiveInFlight = null;
    });
  return archiveInFlight;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
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

export function parsePortalSearchHotelIds(html: string): string[] {
  const ids: string[] = [];
  const patterns = [
    /\/zh-tw\/portal\/travel\/details\/(hotel_[a-z0-9_]+)/gi,
    /ID:\s*(Hotel_[A-Z0-9_]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      if (match[1]) ids.push(match[1]);
    }
  }
  return unique(ids.map((id) => id.toLowerCase())).slice(0, MAX_PORTAL_RECORDS);
}

function normalizedPhone(value: string | undefined | null): string {
  if (!value) return "";
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("886")) digits = `0${digits.slice(3)}`;
  return digits;
}

function portalSearchTerms(seed: PropertyIdentityInput): string[] {
  const terms: string[] = [];
  const phone = normalizedPhone(seed.phone);
  if (phone.length >= 8) terms.push(phone);

  if (seed.name) {
    const chineseName = seed.name.match(/[\u3400-\u9fff]{2,24}/)?.[0];
    if (chineseName) terms.push(chineseName);
    else terms.push(seed.name.normalize("NFKC").trim().slice(0, 80));
  }

  if (seed.address) {
    const parsed = parseTaiwanAddress(seed.address);
    if (parsed.road && parsed.number) {
      terms.push(
        `${parsed.district ?? ""}${parsed.road}${parsed.number}${
          parsed.subNumber ? `之${parsed.subNumber}` : ""
        }號`,
      );
    }
  }

  return unique(terms).slice(0, MAX_PORTAL_SEARCHES);
}

async function searchPortalHotelIds(keyword: string): Promise<string[]> {
  const key = keyword.toLocaleLowerCase("zh-TW");
  const cached = portalSearchCache.get(key);
  if (cached && Date.now() - cached.loadedAt < REGISTRY_CACHE_TTL_MS) return cached.value;

  const url = new URL(REGISTRY_SEARCH_PATH, REGISTRY_PORTAL_ORIGIN);
  url.searchParams.set("Keyword", keyword);
  const { body, contentType } = await fetchOfficialResource(
    url,
    "text/html,application/xhtml+xml",
    MAX_PORTAL_HTML_BYTES,
  );
  if (contentType && !contentType.includes("text/html")) {
    throw new Error("registry_portal_search_not_html");
  }
  const ids = parsePortalSearchHotelIds(decodeHtmlEntities(body.toString("utf8")));
  portalSearchCache.set(key, { loadedAt: Date.now(), value: ids });
  return ids;
}

async function fetchPortalRecord(hotelId: string): Promise<TourismRegistryRecord> {
  const normalizedId = hotelId.toLowerCase();
  if (!/^hotel_[a-z0-9_]+$/.test(normalizedId)) {
    throw new Error("registry_hotel_id_invalid");
  }
  const cached = portalRecordCache.get(normalizedId);
  if (cached && Date.now() - cached.loadedAt < REGISTRY_CACHE_TTL_MS) return cached.value;

  const url = new URL(`${REGISTRY_JSON_PREFIX}${normalizedId}`, REGISTRY_PORTAL_ORIGIN);
  const { body, contentType } = await fetchOfficialResource(
    url,
    "application/json,text/plain,*/*;q=0.5",
    MAX_RECORD_JSON_BYTES,
  );
  if (contentType && !contentType.includes("json")) {
    throw new Error("registry_portal_record_not_json");
  }
  const text = body.toString("utf8").replace(/^\uFEFF/, "").trim();
  if (!text.startsWith("{") && !text.startsWith("[")) {
    throw new Error("registry_portal_record_not_json");
  }
  const nodes = collectHotelNodes(JSON.parse(text));
  const raw = nodes.find(
    (node) => asString(getField(node, "HotelID"))?.toLowerCase() === normalizedId,
  );
  const record = raw ? normalizeRegistryRecord(raw) : null;
  if (!record) throw new Error("registry_portal_record_invalid");
  portalRecordCache.set(normalizedId, { loadedAt: Date.now(), value: record });
  return record;
}

async function loadPortalRecords(seed: PropertyIdentityInput): Promise<TourismRegistryRecord[]> {
  const terms = portalSearchTerms(seed);
  if (!terms.length) return [];

  const idResults = await Promise.allSettled(terms.map(searchPortalHotelIds));
  if (idResults.some(result => result.status === "rejected")) throw new Error("registry_search_incomplete");
  const ids = unique(
    idResults.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
  ).slice(0, MAX_PORTAL_RECORDS);
  if (!ids.length) {
    const failed = idResults.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    return [];
  }

  const recordResults = await Promise.allSettled(ids.map(fetchPortalRecord));
  if (recordResults.some(result => result.status === "rejected")) throw new Error("registry_records_incomplete");
  const records = recordResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (!records.length) {
    const failed = recordResults.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  return records;
}

function platformForUrl(value: string): Exclude<PlatformKey, "official"> | null {
  try {
    const host = new URL(value).hostname;
    for (const [platform, patterns] of Object.entries(PLATFORM_HOSTS) as Array<
      [Exclude<PlatformKey, "official">, RegExp[]]
    >) {
      if (patterns.some((pattern) => pattern.test(host))) return platform;
    }
  } catch {
    return null;
  }
  return null;
}

function platformUrls(record: TourismRegistryRecord) {
  const result: Partial<Record<Exclude<PlatformKey, "official">, string>> = {};
  for (const url of [...record.reservationUrls, ...record.sameAsUrls]) {
    const platform = platformForUrl(url);
    if (platform && !result[platform]) result[platform] = url;
  }
  return result;
}

function quickCandidate(record: TourismRegistryRecord, seed: PropertyIdentityInput): boolean {
  const seedAddress = seed.address ? parseTaiwanAddress(seed.address) : null;
  const recordAddress = record.address ? parseTaiwanAddress(record.address) : null;
  if (seedAddress?.district && recordAddress?.district && seedAddress.district !== recordAddress.district) {
    return false;
  }

  if (
    seed.registrationNumber &&
    record.registrationNumber &&
    seed.registrationNumber.normalize("NFKC").replace(/\D/g, "") ===
      record.registrationNumber.normalize("NFKC").replace(/\D/g, "")
  ) {
    return true;
  }

  const seedPhone = normalizedPhone(seed.phone);
  const recordPhone = normalizedPhone(record.phone);
  if (seedPhone && recordPhone && seedPhone === recordPhone) return true;

  if (seedAddress?.road && recordAddress?.road && seedAddress.road === recordAddress.road) return true;
  const names = [record.name, ...record.alternateNames];
  return Boolean(seed.name && names.some((name) => textSimilarity(seed.name ?? "", name) >= 0.45));
}

function matchRecord(
  record: TourismRegistryRecord,
  seed: PropertyIdentityInput,
): TourismRegistryCandidate {
  const names = unique([record.name, ...record.alternateNames]);
  let bestName = record.name;
  let best = scorePropertyIdentity(seed, {
    name: record.name,
    address: record.address,
    registrationNumber: record.registrationNumber,
    phone: record.phone,
    websiteUrl: record.websiteUrl,
    latitude: record.latitude,
    longitude: record.longitude,
  });

  for (const name of names.slice(1)) {
    const candidate = scorePropertyIdentity(seed, {
      name,
      address: record.address,
      registrationNumber: record.registrationNumber,
      phone: record.phone,
      websiteUrl: record.websiteUrl,
      latitude: record.latitude,
      longitude: record.longitude,
    });
    if (candidate.score > best.score) {
      best = candidate;
      bestName = name;
    }
  }

  return { record, match: best, matchedName: bestName, platformUrls: platformUrls(record) };
}

function rankCandidates(
  records: TourismRegistryRecord[],
  seed: PropertyIdentityInput,
): TourismRegistryCandidate[] {
  return records
    .filter((record) => quickCandidate(record, seed))
    .map((record) => matchRecord(record, seed))
    .filter((candidate) => candidate.match.status !== "rejected" || candidate.match.score >= 0.35)
    .sort((left, right) => {
      const statusOrder = { confirmed: 2, review: 1, rejected: 0 } as const;
      return (
        statusOrder[right.match.status] - statusOrder[left.match.status] ||
        right.match.score - left.match.score
      );
    })
    .slice(0, MAX_REGISTRY_CANDIDATES);
}

export async function findTourismRegistryCandidates(
  seed: PropertyIdentityInput,
): Promise<TourismRegistryCandidate[]> {
  let portalError: unknown;
  try {
    const portalRecords = await loadPortalRecords(seed);
    const portalCandidates = rankCandidates(portalRecords, seed);
    if (portalCandidates.length) return portalCandidates;
  } catch (error) {
    portalError = error;
  }

  try {
    return rankCandidates(await loadArchiveRecords(), seed);
  } catch (archiveError) {
    if (portalError) {
      throw new AggregateError(
        [portalError, archiveError],
        "registry_portal_and_archive_unavailable",
      );
    }
    throw archiveError;
  }
}

export const tourismRegistryMetadata = {
  archiveUrl: REGISTRY_ARCHIVE_URL,
  sourceUrl: REGISTRY_SOURCE_URL,
  portalOrigin: REGISTRY_PORTAL_ORIGIN,
  cacheTtlMs: REGISTRY_CACHE_TTL_MS,
};
