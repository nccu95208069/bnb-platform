import { inflateRawSync } from "node:zlib";

import { normalizeTaiwanAddress, parseTaiwanAddress, textSimilarity } from "./address";
import { scorePropertyIdentity } from "./identity";
import type {
  CompetitorRadarAnalysis,
  IdentityEvidence,
  PlatformKey,
  PlatformSourceDraft,
  PropertyIdentityInput,
  PropertyIdentityMatch,
} from "./types";

const REGISTRY_ARCHIVE_URL =
  "https://media.taiwan.net.tw/XMLReleaseAll_public/v2.0/Zh_tw/Hotel-json.zip";
const REGISTRY_SOURCE_URL = "https://data.gov.tw/dataset/7780";
const REGISTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_FETCH_TIMEOUT_MS = 8_000;
const MAX_ARCHIVE_BYTES = 32_000_000;
const MAX_JSON_BYTES = 96_000_000;
const MAX_REGISTRY_CANDIDATES = 5;

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

let cache: RegistryCache | null = null;
let inFlight: Promise<TourismRegistryRecord[]> | null = null;

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

function normalizeRegistryRecord(raw: JsonRecord): TourismRegistryRecord | null {
  const hotelId = asString(getField(raw, "HotelID"));
  const name = asString(getField(raw, "HotelName"));
  if (!hotelId || !name) return null;

  const reservationUrls = collectUrls(getField(raw, "ReservationURLs", "ReservationURL"));
  const sameAsUrls = collectUrls(getField(raw, "SameAsURLs", "SameAsURL"));
  const websiteUrl = collectUrls(getField(raw, "WebsiteURL", "WebsiteURLs"))[0];

  return {
    hotelId,
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
    return JSON.parse(decoded.toString("utf8"));
  }

  throw new Error("registry_json_entry_not_found");
}

async function readLimitedBytes(response: Response, maximum: number): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximum) {
    throw new Error("registry_archive_too_large");
  }
  if (!response.body) throw new Error("registry_archive_empty");

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
      throw new Error("registry_archive_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function fetchRegistryRecords(): Promise<TourismRegistryRecord[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(REGISTRY_ARCHIVE_URL, {
      headers: { Accept: "application/zip,application/octet-stream" },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`registry_http_${response.status}`);
    const archive = await readLimitedBytes(response, MAX_ARCHIVE_BYTES);
    const payload = decodeRegistryArchive(archive);
    return collectHotelNodes(payload)
      .map(normalizeRegistryRecord)
      .filter((record): record is TourismRegistryRecord => Boolean(record));
  } finally {
    clearTimeout(timer);
  }
}

async function loadRegistryRecords(): Promise<TourismRegistryRecord[]> {
  if (cache && Date.now() - cache.loadedAt < REGISTRY_CACHE_TTL_MS) return cache.records;
  if (inFlight) return inFlight;

  inFlight = fetchRegistryRecords()
    .then((records) => {
      if (!records.length) throw new Error("registry_contains_no_hotels");
      cache = { loadedAt: Date.now(), records };
      return records;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
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

function normalizedPhone(value: string | undefined): string {
  if (!value) return "";
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("886")) digits = `0${digits.slice(3)}`;
  return digits;
}

function quickCandidate(record: TourismRegistryRecord, seed: PropertyIdentityInput): boolean {
  const seedAddress = seed.address ? parseTaiwanAddress(seed.address) : null;
  const recordAddress = record.address ? parseTaiwanAddress(record.address) : null;
  if (seedAddress?.district && recordAddress?.district && seedAddress.district !== recordAddress.district) {
    return false;
  }

  const seedPhone = normalizedPhone(seed.phone ?? undefined);
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
    phone: record.phone,
    websiteUrl: record.websiteUrl,
    latitude: record.latitude,
    longitude: record.longitude,
  });

  for (const name of names.slice(1)) {
    const candidate = scorePropertyIdentity(seed, {
      name,
      address: record.address,
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

export async function findTourismRegistryCandidates(
  seed: PropertyIdentityInput,
): Promise<TourismRegistryCandidate[]> {
  const records = await loadRegistryRecords();
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

function registryEvidence(candidate: TourismRegistryCandidate): IdentityEvidence[] {
  const source: IdentityEvidence = {
    field: "website",
    label: "交通部觀光署旅宿資料",
    strength: candidate.match.status === "confirmed" ? "strong" : "supporting",
    score: candidate.match.score,
    detail: `HotelID ${candidate.record.hotelId}；名稱「${candidate.record.name}」${
      candidate.record.updateTime ? `；資料更新 ${candidate.record.updateTime}` : ""
    }。`,
  };
  return [
    source,
    ...candidate.match.evidence.map((item) => ({
      ...item,
      label: `政府資料：${item.label}`,
    })),
  ];
}

function enrichPlatformSources(
  sources: PlatformSourceDraft[],
  candidate: TourismRegistryCandidate,
): PlatformSourceDraft[] {
  return sources.map((source) => {
    if (source.platform === "official") return source;
    const registryUrl = candidate.platformUrls[source.platform];
    if (!registryUrl || source.sourceUrl) return source;
    return {
      ...source,
      sourceUrl: registryUrl,
      status: "identity_review",
      identityConfidence: candidate.match.score,
      identityEvidence: registryEvidence(candidate),
      message:
        "交通部觀光署旅宿資料提供此平台候選網址；仍需讀取 OTA 頁面並再次核對地址、電話或座標後才能確認。",
    };
  });
}

export async function enrichAnalysisWithTourismRegistry(
  analysis: CompetitorRadarAnalysis,
): Promise<CompetitorRadarAnalysis> {
  const candidates = await findTourismRegistryCandidates({
    name: analysis.property.name,
    address: analysis.property.address,
    phone: analysis.property.phone,
    websiteUrl: analysis.property.sourceUrl,
    latitude: analysis.property.latitude,
    longitude: analysis.property.longitude,
  });

  if (!candidates.length) {
    return {
      ...analysis,
      warnings: [
        ...analysis.warnings,
        "交通部觀光署旅宿資料未找到足以辨識的候選；不會僅因名稱相似而自動合併。",
      ],
    };
  }

  const best = candidates[0]!;
  const confirmed = best.match.status === "confirmed";
  const secondary = candidates.slice(1).filter((item) => item.match.score >= 0.55);
  const governmentAddress = best.record.address;
  const warnings = [...analysis.warnings];
  if (!confirmed) {
    warnings.push(
      `政府資料最佳候選為「${best.record.name}」（${Math.round(
        best.match.score * 100,
      )}%），仍需使用者確認。`,
    );
  }
  if (secondary.length) {
    warnings.push(
      `另有 ${secondary.length} 個政府資料候選達人工複核門檻；目前不自動選用。`,
    );
  }

  return {
    ...analysis,
    property: {
      ...analysis.property,
      address: analysis.property.address ?? governmentAddress,
      normalizedAddress:
        analysis.property.normalizedAddress ??
        (governmentAddress ? normalizeTaiwanAddress(governmentAddress) : undefined),
      phone: analysis.property.phone ?? best.record.phone,
      latitude: analysis.property.latitude ?? best.record.latitude,
      longitude: analysis.property.longitude ?? best.record.longitude,
      identityStatus: confirmed ? "confirmed" : analysis.property.identityStatus,
      confidence: confirmed
        ? Math.max(analysis.property.confidence, best.match.score)
        : analysis.property.confidence,
    },
    identityEvidence: [...analysis.identityEvidence, ...registryEvidence(best)],
    platformSources: enrichPlatformSources(analysis.platformSources, best),
    warnings,
  };
}

export const tourismRegistryMetadata = {
  archiveUrl: REGISTRY_ARCHIVE_URL,
  sourceUrl: REGISTRY_SOURCE_URL,
  cacheTtlMs: REGISTRY_CACHE_TTL_MS,
};
