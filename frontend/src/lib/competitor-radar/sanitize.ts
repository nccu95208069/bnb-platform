import { parseTaiwanAddress } from "./address";
import type { CompetitorRadarAnalysis } from "./types";

function isPlausibleRegistrationNumber(value: string | undefined): boolean {
  if (!value) return false;
  const compact = value.normalize("NFKC").replace(/\s+/g, "");
  const digitCount = (compact.match(/\d/g) ?? []).length;
  if (digitCount < 1 || digitCount > 12) return false;
  if (/https?:|www\.|@|(?:電話|手機|fax|tel)/i.test(compact)) return false;

  // The website extractor only emits a standalone value after validating the
  // surrounding label/text as registration context. Keep that clean ID while
  // continuing to reject arbitrary JSON-LD brand identifiers at extraction.
  if (/^[A-Z]?\d{1,12}(?:-\d+)?號?$/i.test(compact)) return true;

  return /(?:民宿|旅館|registration|license|登記|證號|字號|編號)/i.test(compact);
}

function hasCompleteTaiwanAddress(value: string | undefined): boolean {
  if (!value) return false;
  const parsed = parseTaiwanAddress(value);
  return Boolean(parsed.district && parsed.road && parsed.number);
}

/**
 * Final fail-closed cleanup before analysis leaves the server boundary.
 * Public websites often use a generic JSON-LD `identifier` for a brand name;
 * such text must not be promoted to a Taiwan lodging registration number.
 */
export function sanitizeCompetitorAnalysis(
  analysis: CompetitorRadarAnalysis,
): CompetitorRadarAnalysis {
  if (isPlausibleRegistrationNumber(analysis.property.registrationNumber)) {
    return analysis;
  }

  const hadRegistrationCandidate = Boolean(analysis.property.registrationNumber);
  const identityEvidence = analysis.identityEvidence.filter(
    (evidence) => evidence.field !== "registration_number",
  );
  const addressConfirmed = hasCompleteTaiwanAddress(analysis.property.address);
  const warning = hadRegistrationCandidate
    ? "網站的 identifier 不符合旅宿登記編號格式，未採用為民宿／旅館登記編號。"
    : null;

  return {
    ...analysis,
    property: {
      ...analysis.property,
      registrationNumber: undefined,
      identityStatus: addressConfirmed ? "confirmed" : "review",
      confidence: addressConfirmed ? Math.min(analysis.property.confidence, 0.9) : 0.62,
    },
    identityEvidence,
    warnings: warning ? [...analysis.warnings, warning] : analysis.warnings,
  };
}
