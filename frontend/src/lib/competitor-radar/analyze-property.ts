import { sanitizeCompetitorAnalysis } from "./sanitize";
import { enrichAnalysisWithTourismRegistry } from "./taiwan-tourism-registry";
import type { CompetitorRadarAnalysis } from "./types";
import { analyzeOfficialWebsite } from "./website";

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
    return await enrichAnalysisWithTourismRegistry(websiteAnalysis);
  } catch (error) {
    console.warn(
      "competitor-radar registry enrichment unavailable",
      error instanceof Error ? error.message : "unknown_error",
    );
    return {
      ...websiteAnalysis,
      warnings: [
        ...websiteAnalysis.warnings,
        "交通部觀光署旅宿資料目前無法取得；官網草稿仍保留，政府資料與 OTA 候選稍後可重新比對。",
      ],
    };
  }
}
