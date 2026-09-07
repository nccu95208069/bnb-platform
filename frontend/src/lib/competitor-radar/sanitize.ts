import type { CompetitorRadarAnalysis } from "./types";

function isPlausibleRegistrationNumber(value: string | undefined): boolean {
  if (!value) return false;
  const compact = value.normalize("NFKC").replace(/\s+/g, "");
  const digitCount = (compact.match(/\d/g) ?? []).length;
  if (digitCount < 1) return false;
  if (/(?:電話|手機|fax|tel)/i.test(compact)) return false;

  const hasRegistrationContext =
    /(?:民宿|旅館|hotel|registration|license|登記|證號|字號|編號)/i.test(compact);
  const looksLikeStandaloneId = /^[A-Z]?\d{2,10}(?:-\d+)?號?$/i.test(compact);
  return hasRegistrationContext || looksLikeStandaloneId;
}

/**
 * Final fail-closed cleanup before analysis leaves the server boundary.
 * Public websites often use a generic JSON-LD `identifier` for their brand name;
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
  const addressConfirmed = Boolean(analysis.property.address);
  const warning = hadRegistrationCandidate
    ? "網站的 identifier 不含可驗證數字，未採用為民宿／旅館登記編號。"
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
