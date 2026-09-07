import { type NextRequest, NextResponse } from "next/server";
import { analyzeOfficialWebsite, PublicUrlError } from "@/lib/competitor-radar/website";
import { sanitizeCompetitorAnalysis } from "@/lib/competitor-radar/sanitize";
import { findTourismRegistryCandidates, tourismRegistryMetadata } from "@/lib/competitor-radar/taiwan-tourism-registry";
import { record, safeLink } from "@/lib/competitor-radar/preview-contract";
import { prioritizeRoomTitleCapacity } from "@/lib/competitor-radar/preview-room-draft";
import type { PropertyIdentityInput, TourismRegistryMatch } from "@/lib/competitor-radar/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const buckets = new Map<string, { started: number; count: number; active: boolean }>();
const WINDOW = 600_000;
function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}
export async function GET() {
  if (process.env.RADAR_PREVIEW_MODE !== "true") return reply({ detail: "測試端點未開啟。" }, 404);
  return reply({
    version: "radar-preview-v0.4",
    build: process.env.RADAR_BUILD_SHA ?? "local",
    liveOtaEndpoint: true,
    persistence: "none",
    providerCapabilities: {
      booking: "live_property_and_room_catalog_only",
      agoda: "live_dated_room_status",
      trip: "live_date_identity_only",
    },
  });
}
async function limitedJson(request: NextRequest): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new Error("請提供 JSON。");
  if (!request.body) throw new Error("請求內容為空。");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let total = 0;
  const timer = setTimeout(() => { void reader.cancel().catch(() => undefined); }, 3000);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 16_384) { await reader.cancel(); throw new Error("請求超過 16 KB。"); }
      chunks.push(value);
    }
    return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally { clearTimeout(timer); reader.releaseLock(); }
}
function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined;
}
export async function POST(request: NextRequest) {
  if (process.env.RADAR_PREVIEW_MODE !== "true") return reply({ detail: "測試端點未開啟。" }, 404);
  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) return reply({ detail: "只接受測試頁面發出的同來源請求。" }, 403);
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const now = Date.now();
  for (const [key, item] of buckets) if (now - item.started > WINDOW && !item.active) buckets.delete(key);
  if (buckets.size >= 1024 && !buckets.has(ip)) return reply({ detail: "測試站目前忙碌，請稍後重試。" }, 429);
  const bucket = buckets.get(ip) ?? { started: now, count: 0, active: false };
  if (bucket.count >= 12 || bucket.active) return reply({ detail: "分析頻率超過測試站限制；範例、編輯與匯入仍可使用。" }, 429);
  bucket.count++; bucket.active = true; buckets.set(ip, bucket);
  try {
    const body = await limitedJson(request);
    if (body.phase === "website") {
      if (typeof body.url !== "string" || !safeLink(body.url)) return reply({ detail: "請提供有效的公開 HTTP/HTTPS 官網網址。" }, 422);
      const result = prioritizeRoomTitleCapacity(sanitizeCompetitorAnalysis(await analyzeOfficialWebsite(body.url)));
      return reply(result);
    }
    if (body.phase !== "registry") return reply({ detail: "未知分析階段。" }, 422);
    const input = record(body.property);
    const seed: PropertyIdentityInput = {
      name: boundedString(input.name, 200), address: boundedString(input.address, 500),
      phone: boundedString(input.phone, 50), registrationNumber: boundedString(input.registrationNumber, 100),
      websiteUrl: safeLink(input.sourceUrl),
    };
    if (!seed.name && !seed.address && !seed.phone) return reply({ detail: "至少提供住宿名稱、地址或電話。" }, 422);
    let registry: TourismRegistryMatch;
    try {
      const matches = await findTourismRegistryCandidates(seed);
      const confirmed = matches.filter(c => c.match.status === "confirmed");
      registry = {
        status: confirmed.length === 1 ? "matched" : matches.length ? "review" : "not_found",
        sourceUrl: tourismRegistryMetadata.sourceUrl,
        selectedHotelId: confirmed.length === 1 ? confirmed[0].record.hotelId : undefined,
        message: confirmed.length === 1 ? "找到唯一高信心候選，請核對後確認；政府房間數不會覆蓋官網房型。" : "請檢查候選與反證；系統不會替你選擇多筆候選。",
        candidates: matches.map(c => ({ ...c.record, matchedName: c.matchedName, score: c.match.score, status: c.match.status, evidence: c.match.evidence, conflicts: c.match.conflicts, platformUrls: c.platformUrls })),
      };
    } catch {
      registry = { status: "unavailable", sourceUrl: tourismRegistryMetadata.sourceUrl, candidates: [], message: "政府資料暫時無法取得。官網結果與你的編輯仍保留，可單獨重新比對。" };
    }
    return reply(registry);
  } catch (error) {
    if (error instanceof PublicUrlError) return reply({ detail: error.message }, 422);
    if (error instanceof SyntaxError) return reply({ detail: "JSON 格式不正確。" }, 400);
    return reply({ detail: "未能完成這次分析。既有草稿未被覆蓋；可重試或使用完整範例測試。" }, 400);
  } finally { bucket.active = false; }
}
