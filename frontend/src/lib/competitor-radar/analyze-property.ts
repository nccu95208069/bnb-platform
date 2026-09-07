import { normalizeTaiwanAddress } from "./address";
import { sanitizeCompetitorAnalysis } from "./sanitize";
import {
  findTourismRegistryCandidates,
  tourismRegistryMetadata,
  type TourismRegistryCandidate,
} from "./taiwan-tourism-registry";
import type {
  CompetitorRadarAnalysis,
  IdentityEvidence,
  PlatformSourceDraft,
  PropertyIdentityInput,
  RegistryCandidateSummary,
} from "./types";
import { analyzeOfficialWebsite } from "./website";

function summarizeRegistryCandidate(
  candidate: TourismRegistryCandidate,
): RegistryCandidateSummary {
  return {
    hotelId: candidate.record.hotelId,
    registrationNumber: candidate.record.registrationNumber,
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

function registryEvidence(candidate: TourismRegistryCandidate): IdentityEvidence[] {
  const license = candidate.record.registrationNumber
    ? `；旅館民宿證號 ${candidate.record.registrationNumber}`
    : "";
  return [
    {
      field: "website",
      label: "交通部觀光署旅宿資料",
      strength: candidate.match.status === "confirmed" ? "strong" : "supporting",
      score: candidate.match.score,
      detail: `HotelID ${candidate.record.hotelId}${license}；候選名稱「${
        candidate.record.name
      }」${candidate.record.updateTime ? `；資料更新 ${candidate.record.updateTime}` : ""}。HotelID 是政府資料識別碼，不等同地方旅館民宿證號。`,
    },
    ...candidate.match.evidence.map((item) => ({
      ...item,
      label: `政府資料：${item.label}`,
    })),
  ];
}

function enrichPlatformCandidates(
  sources: PlatformSourceDraft[],
  candidate: TourismRegistryCandidate,
): PlatformSourceDraft[] {
  return sources.map((source) => {
    if (source.platform === "official" || source.sourceUrl) return source;
    const registryUrl = candidate.platformUrls[source.platform];
    if (!registryUrl) return source;
    return {
      ...source,
      sourceUrl: registryUrl,
      status: "identity_review",
      identityConfidence: candidate.match.score,
      identityEvidence: registryEvidence(candidate),
      message:
        "政府旅宿資料提供此 OTA 候選網址；必須再讀取 OTA 頁面並核對身分後，才可用於房型、價格與待售量監控。",
    };
  });
}

function registryUnavailable(
  websiteAnalysis: CompetitorRadarAnalysis,
  message: string,
): CompetitorRadarAnalysis {
  return {
    ...websiteAnalysis,
    tourismRegistry: {
      status: "unavailable",
      sourceUrl: tourismRegistryMetadata.sourceUrl,
      candidates: [],
      message,
    },
    warnings: [...websiteAnalysis.warnings, message],
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

  const identitySeed: PropertyIdentityInput = {
    name: websiteAnalysis.property.name,
    address: websiteAnalysis.property.address,
    registrationNumber: websiteAnalysis.property.registrationNumber,
    phone: websiteAnalysis.property.phone,
    websiteUrl: websiteAnalysis.property.sourceUrl,
    latitude: websiteAnalysis.property.latitude,
    longitude: websiteAnalysis.property.longitude,
  };

  try {
    const registryCandidates = await findTourismRegistryCandidates(identitySeed);
    const usableCandidates = registryCandidates.filter(
      (candidate) => candidate.match.status !== "rejected",
    );
    const confirmedCandidates = usableCandidates.filter(
      (candidate) => candidate.match.status === "confirmed",
    );
    const summaries = registryCandidates.map(summarizeRegistryCandidate);

    if (!usableCandidates.length) {
      return {
        ...websiteAnalysis,
        tourismRegistry: {
          status: "not_found",
          sourceUrl: tourismRegistryMetadata.sourceUrl,
          candidates: summaries,
          message:
            registryCandidates.length > 0
              ? "政府資料只找到具有強烈反證的候選，因此未採用任何資料或 OTA 網址。"
              : "政府旅宿資料沒有找到足以進入人工複核的候選；系統沒有使用名稱相似度強行合併。",
        },
        warnings: [
          ...websiteAnalysis.warnings,
          "交通部觀光署旅宿資料沒有可安全採用的候選；官網草稿保持不變。",
        ],
      };
    }

    if (confirmedCandidates.length > 1) {
      return {
        ...websiteAnalysis,
        tourismRegistry: {
          status: "review",
          sourceUrl: tourismRegistryMetadata.sourceUrl,
          candidates: summaries,
          message: `政府資料有 ${confirmedCandidates.length} 個候選同時達確認門檻，可能是同址多張旅宿執照；必須由使用者選擇，系統不會自行挑一筆。`,
        },
        warnings: [
          ...websiteAnalysis.warnings,
          `政府資料出現 ${confirmedCandidates.length} 個高信心候選；未寫入 HotelID、旅館民宿證號、地址、電話或 OTA 網址。`,
        ],
      };
    }

    const best = confirmedCandidates[0] ?? usableCandidates[0]!;
    const confirmed = confirmedCandidates.length === 1;
    const secondary = usableCandidates.filter((item) => item !== best && item.match.score >= 0.55);
    const evidence = registryEvidence(best);
    const warnings = [...websiteAnalysis.warnings];
    if (!confirmed) {
      warnings.push(
        `政府資料最佳候選為「${best.record.name}」（${Math.round(
          best.match.score * 100,
        )}%），仍需使用者確認。`,
      );
    }
    if (secondary.length) {
      warnings.push(`另有 ${secondary.length} 個政府資料候選達人工複核門檻。`);
    }

    return {
      ...websiteAnalysis,
      property: confirmed
        ? {
            ...websiteAnalysis.property,
            address: websiteAnalysis.property.address ?? best.record.address,
            normalizedAddress:
              websiteAnalysis.property.normalizedAddress ??
              (best.record.address ? normalizeTaiwanAddress(best.record.address) : undefined),
            registrationNumber:
              websiteAnalysis.property.registrationNumber ?? best.record.registrationNumber,
            phone: websiteAnalysis.property.phone ?? best.record.phone,
            latitude: websiteAnalysis.property.latitude ?? best.record.latitude,
            longitude: websiteAnalysis.property.longitude ?? best.record.longitude,
            identityStatus: "confirmed",
            confidence: Math.max(websiteAnalysis.property.confidence, best.match.score),
          }
        : websiteAnalysis.property,
      identityEvidence: [...websiteAnalysis.identityEvidence, ...evidence],
      platformSources: confirmed
        ? enrichPlatformCandidates(websiteAnalysis.platformSources, best)
        : websiteAnalysis.platformSources,
      tourismRegistry: {
        status: confirmed ? "matched" : "review",
        sourceUrl: tourismRegistryMetadata.sourceUrl,
        selectedHotelId: confirmed ? best.record.hotelId : undefined,
        candidates: summaries,
        message: confirmed
          ? `政府資料已找到唯一高信心候選「${best.record.name}」；HotelID 與旅館民宿證號分開保存。`
          : `政府資料最佳候選為「${best.record.name}」，但證據尚不足以自動確認，請人工複核。`,
      },
      warnings,
    };
  } catch (error) {
    console.warn(
      "competitor-radar registry enrichment unavailable",
      error instanceof Error ? error.message : "unknown_error",
    );
    return registryUnavailable(
      websiteAnalysis,
      "交通部觀光署旅宿資料目前無法取得；官網草稿仍保留，政府資料與 OTA 候選稍後可重新比對。",
    );
  }
}
