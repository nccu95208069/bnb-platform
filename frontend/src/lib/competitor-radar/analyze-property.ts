import { sanitizeCompetitorAnalysis } from "./sanitize";
import {
  enrichAnalysisWithTourismRegistry,
  findTourismRegistryCandidates,
  tourismRegistryMetadata,
  type TourismRegistryCandidate,
} from "./taiwan-tourism-registry";
import type {
  CompetitorRadarAnalysis,
  RegistryCandidateSummary,
} from "./types";
import { analyzeOfficialWebsite } from "./website";

function summarizeRegistryCandidate(
  candidate: TourismRegistryCandidate,
): RegistryCandidateSummary {
  return {
    hotelId: candidate.record.hotelId,
    name: candidate.record.name,
    matchedName: candidate.matchedName,
    address: candidate.record.address,
    phone: candidate.record.phone,
    websiteUrl: candidate.record.websiteUrl,
    latitude: candidate.record.latitude,
    longitude: candidate.record.longitude,
    totalRooms: candidate.record.totalRooms,
    lowestPrice: candidate.record.lowestPrice,
    ceilingPrice: candidate.record.ceilingPrice,
    updateTime: candidate.record.updateTime,
    score: candidate.match.score,
    status: candidate.match.status,
    evidence: candidate.match.evidence,
    conflicts: candidate.match.conflicts,
    platformUrls: candidate.platformUrls,
  };
}

/**
 * Builds the editable website draft first, then adds best-effort evidence from
 * the Taiwan Tourism Administration's official lodging dataset. Registry
 * downtime must never turn a valid website analysis into a failed request.
 */
export async function analyzeCompetitorProperty(
  inputUrl: string,
): Promise<CompetitorRadarAnalysis> {
  const websiteAnalysis = sanitizeCompetitorAnalysis(
    await analyzeOfficialWebsite(inputUrl),
  );

  try {
    const registryCandidates = await findTourismRegistryCandidates({
      name: websiteAnalysis.property.name,
      address: websiteAnalysis.property.address,
      phone: websiteAnalysis.property.phone,
      websiteUrl: websiteAnalysis.property.sourceUrl,
      latitude: websiteAnalysis.property.latitude,
      longitude: websiteAnalysis.property.longitude,
    });
    const enriched = await enrichAnalysisWithTourismRegistry(websiteAnalysis);
    const best = registryCandidates[0];

    if (!best) {
      return {
        ...enriched,
        tourismRegistry: {
          status: "not_found",
          sourceUrl: tourismRegistryMetadata.sourceUrl,
          candidates: [],
          message:
            "政府旅宿資料沒有找到足以進入人工複核的候選；系統沒有使用名稱相似度強行合併。",
        },
      };
    }

    return {
      ...enriched,
      tourismRegistry: {
        status: best.match.status === "confirmed" ? "matched" : "review",
        sourceUrl: tourismRegistryMetadata.sourceUrl,
        selectedHotelId:
          best.match.status === "confirmed" ? best.record.hotelId : undefined,
        candidates: registryCandidates.map(summarizeRegistryCandidate),
        message:
          best.match.status === "confirmed"
            ? `政府資料已找到高信心候選「${best.record.name}」；HotelID 是政府資料識別碼，不等同地方民宿登記證號。`
            : `政府資料最佳候選為「${best.record.name}」，但證據尚不足以自動確認，請人工複核。`,
      },
    };
  } catch (error) {
    console.warn(
      "competitor-radar registry enrichment unavailable",
      error instanceof Error ? error.message : "unknown_error",
    );
    return {
      ...websiteAnalysis,
      tourismRegistry: {
        status: "unavailable",
        sourceUrl: tourismRegistryMetadata.sourceUrl,
        candidates: [],
        message:
          "交通部觀光署旅宿資料目前無法取得；官網草稿仍保留，政府資料與 OTA 候選稍後可重新比對。",
      },
      warnings: [
        ...websiteAnalysis.warnings,
        "交通部觀光署旅宿資料目前無法取得；官網草稿仍保留，政府資料與 OTA 候選稍後可重新比對。",
      ],
    };
  }
}
