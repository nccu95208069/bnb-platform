import { after, type NextRequest, NextResponse } from "next/server";
import { radarSameOrigin } from "@/lib/competitor-radar/request-origin";

import { createScanJob, readScanJob } from "@/lib/competitor-radar/scan-jobs";
import { desktopDirectory, enqueueDesktop, readDesktop } from "@/lib/competitor-radar/desktop-queue";
import { collectionPaused, normalizeSourceOverrides, scanOtaPlatform } from "@/lib/competitor-radar/ota-sandbox";
import type { OtaScanRequest, OtaScanResponse } from "@/lib/competitor-radar/ota-types";
import { record, safeLink } from "@/lib/competitor-radar/preview-contract";
import type { CanonicalRoomDraft } from "@/lib/competitor-radar/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const WINDOW_MS = 15 * 60 * 1_000;
const buckets = new Map<string, { startedAt: number; count: number; active: number }>();
const cache = new Map<string, { expiresAt: number; response: OtaScanResponse }>();

function reply(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

async function limitedJson(request: NextRequest): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new Error("請提供 JSON。");
  }
  if (!request.body) throw new Error("請求內容為空。");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const timer = setTimeout(() => void reader.cancel().catch(() => undefined), 4_000);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 65_536) {
        await reader.cancel();
        throw new Error("請求超過 64 KB。");
      }
      chunks.push(value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

function text(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= maximum
    ? value.trim()
    : undefined;
}

function dateOnly(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

function daysFromToday(value: string): number {
  const now = new Date();
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return Math.floor((Date.parse(`${value}T00:00:00Z`) - today.valueOf()) / 86_400_000);
}

function rooms(value: unknown): CanonicalRoomDraft[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 30).flatMap((item, index) => {
    const room = record(item);
    const name = text(room.name, 200);
    if (!name) return [];
    const capacity =
      typeof room.capacity === "number" &&
      Number.isSafeInteger(room.capacity) &&
      room.capacity >= 1 &&
      room.capacity <= 100
        ? room.capacity
        : undefined;
    return [
      {
        id: text(room.id, 120) ?? `room-${index}`,
        name,
        sourceName: text(room.sourceName, 200) ?? name,
        sourceUrl: safeLink(room.sourceUrl),
        roomNumber: text(room.roomNumber, 30),
        capacity,
        bundle: room.bundle === true,
        features: Array.isArray(room.features)
          ? room.features.filter((feature): feature is string => typeof feature === "string").slice(0, 30)
          : [],
        origin: "manual",
        editable: true,
      } satisfies CanonicalRoomDraft,
    ];
  });
}

function buildRequest(body: Record<string, unknown>): OtaScanRequest {
  const platform = body.platform;
  if (platform !== "booking" && platform !== "agoda" && platform !== "trip") {
    throw new Error("不支援的平台。");
  }
  const startDate = dateOnly(body.startDate);
  if (!startDate) throw new Error("開始日期格式錯誤。");
  const distance = daysFromToday(startDate);
  if (distance < -1 || distance > 90) throw new Error("測試版只支援今天起 90 天內的入住日。");
  const requestedDays = body.days === undefined ? 14 : Number(body.days);
  if (!Number.isSafeInteger(requestedDays) || requestedDays < 1 || requestedDays > 14) {
    throw new Error("測試版最多掃描 14 天。");
  }
  const adults = body.adults === undefined ? 2 : Number(body.adults);
  if (!Number.isSafeInteger(adults) || adults < 1 || adults > 8) {
    throw new Error("成人數需為 1 至 8。");
  }
  const rawProperty = record(body.property);
  const name = text(rawProperty.name, 200);
  if (!name) throw new Error("缺少住宿名稱。");
  const canonicalRooms = rooms(body.canonicalRooms);
  if (!canonicalRooms.length) throw new Error("至少需要一個標準房型。");
  const request: OtaScanRequest = {
    platform,
    startDate,
    days: requestedDays,
    adults,
    property: {
      name,
      address: text(rawProperty.address, 500),
      registrationNumber: text(rawProperty.registrationNumber, 100),
      phone: text(rawProperty.phone, 50),
      websiteUrl: safeLink(rawProperty.websiteUrl ?? rawProperty.sourceUrl),
      sourceUrl: safeLink(rawProperty.sourceUrl),
      websiteHost: text(rawProperty.websiteHost, 200),
    },
    canonicalRooms,
    sourceUrl: safeLink(body.sourceUrl),
    sourceOverrides: normalizeSourceOverrides(platform, body.sourceOverrides),
  };
  return request;
}

function cacheKey(request: OtaScanRequest): string {
  return JSON.stringify({
    platform: request.platform,
    startDate: request.startDate,
    days: request.days,
    adults: request.adults,
    name: request.property.name,
    address: request.property.address,
    registrationNumber: request.property.registrationNumber,
    rooms: request.canonicalRooms.map((room) => [room.id, room.name, room.roomNumber]),
    sourceUrl: request.sourceUrl,
    sourceOverrides: request.sourceOverrides,
  });
}

export async function GET(request: NextRequest) {
  if (process.env.RADAR_PREVIEW_MODE !== "true") {
    return reply({ detail: "測試端點未開啟。" }, 404);
  }
  const jobId = request.nextUrl.searchParams.get("job");
  if (jobId) {
    if (request.headers.get("sec-fetch-site") !== "same-origin") return reply({ detail: "只接受同來源查詢。" }, 403);
    try { return reply(await (jobId.startsWith("desktop-") ? readDesktop : readScanJob)(jobId, request.headers.get("x-radar-job-token") ?? "")); }
    catch { return reply({ detail: "掃描已過期或無法恢復，已保存結果仍可查看。" }, 404); }
  }
  return reply({
    version: "radar-live-ota-v0.5",
    desktop: Boolean(desktopDirectory()),
    source: "isolated_browser",
    live: (["booking", "agoda", "trip"] as const).some((platform) => !collectionPaused(platform)),
    maxDays: 14,
    physicalInventory: false,
    confirmedBookings: false,
  });
}

export async function POST(request: NextRequest) {
  if (process.env.RADAR_PREVIEW_MODE !== "true") {
    return reply({ detail: "測試端點未開啟。" }, 404);
  }
  const origin = request.headers.get("origin");
  if (!radarSameOrigin(origin, request.nextUrl.origin, request.headers.get("host"))) {
    return reply({ detail: "只接受測試頁面發出的同來源請求。" }, 403);
  }
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const now = Date.now();
  for (const [key, item] of buckets) {
    if (now - item.startedAt > WINDOW_MS && !item.active) buckets.delete(key);
  }
  if (buckets.size >= 1_024 && !buckets.has(ip)) {
    return reply({ detail: "測試站目前忙碌，請稍後重試。" }, 429);
  }
  const bucket = buckets.get(ip) ?? { startedAt: now, count: 0, active: 0 };
  if (now - bucket.startedAt > WINDOW_MS) {
    bucket.startedAt = now;
    bucket.count = 0;
  }
  if (bucket.active >= 3 || bucket.count >= 9) {
    return reply({ detail: "同一來源的掃描過於頻繁，請先查看已取得的結果。" }, 429);
  }
  bucket.active += 1;
  bucket.count += 1;
  buckets.set(ip, bucket);

  let background = false;
  try {
    const body = await limitedJson(request);
    const scanRequest = buildRequest(body);
    if (desktopDirectory() && scanRequest.platform === "agoda") {
      if (!["localhost", "127.0.0.1"].includes(request.nextUrl.hostname)) return reply({ detail: "桌面收集只接受本機頁面。" }, 403);
      return reply({ job: await enqueueDesktop(scanRequest) }, 202);
    }
    const key = cacheKey(scanRequest);
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      return reply({ ...cached.response, cached: true });
    }
    if (body.async === true && !collectionPaused(scanRequest.platform)) {
      const { job, write } = await createScanJob();
      background = true;
      after(async () => {
        try { await write({ state: "done", scan: await scanOtaPlatform(scanRequest) }); }
        catch { await write({ state: "failed", detail: "平台暫時無法取得資料。" }).catch(() => undefined); }
        finally { bucket.active = Math.max(0, bucket.active - 1); }
      });
      return reply({ job }, 202);
    }
    const scan = await scanOtaPlatform(scanRequest);
    const response: OtaScanResponse = {
      scan,
      capability: {
        source: "isolated_browser",
        live: scan.collectionState !== "paused" && scan.collectionState !== "withdrawn",
        physicalInventory: false,
        confirmedBookings: false,
      },
    };
    cache.set(key, { expiresAt: Date.now() + 10 * 60 * 1_000, response });
    while (cache.size > 64) cache.delete(cache.keys().next().value as string);
    return reply(response);
  } catch (error) {
    return reply(
      {
        detail:
          error instanceof Error
            ? error.message.slice(0, 300)
            : "無法完成這次平台掃描。",
      },
      422,
    );
  } finally {
    if (!background) bucket.active = Math.max(0, bucket.active - 1);
  }
}
