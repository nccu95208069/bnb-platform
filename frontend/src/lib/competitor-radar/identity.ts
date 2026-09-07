import { compareTaiwanAddresses, textSimilarity } from "./address";
import type {
  IdentityEvidence,
  PropertyIdentityInput,
  PropertyIdentityMatch,
} from "./types";

function normalizeRegistrationNumber(value: string): string {
  return value
    .normalize("NFKC")
    .toUpperCase()
    .replaceAll("台", "臺")
    .replace(/旅館業|民宿|登記證|登記|編號|證號|字號|第|號|[:：\s-]/g, "")
    .trim();
}

function normalizePhone(value: string): string {
  let phone = value.normalize("NFKC").replace(/\D/g, "");
  if (phone.startsWith("886")) phone = `0${phone.slice(3)}`;
  return phone.replace(/^0+/, "0");
}

function hostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function distanceMeters(
  left: Pick<PropertyIdentityInput, "latitude" | "longitude">,
  right: Pick<PropertyIdentityInput, "latitude" | "longitude">,
): number | null {
  if (
    typeof left.latitude !== "number" ||
    typeof left.longitude !== "number" ||
    typeof right.latitude !== "number" ||
    typeof right.longitude !== "number"
  ) {
    return null;
  }

  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadius = 6_371_000;
  const dLat = radians(right.latitude - left.latitude);
  const dLon = radians(right.longitude - left.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(left.latitude)) *
      Math.cos(radians(right.latitude)) *
      Math.sin(dLon / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function addEvidence(
  evidence: IdentityEvidence[],
  field: IdentityEvidence["field"],
  label: string,
  score: number,
  detail: string,
  strength: IdentityEvidence["strength"],
): void {
  evidence.push({ field, label, score, detail, strength });
}

export function scorePropertyIdentity(
  left: PropertyIdentityInput,
  right: PropertyIdentityInput,
): PropertyIdentityMatch {
  const evidence: IdentityEvidence[] = [];
  const conflicts: string[] = [];
  let weightedScore = 0;
  let totalWeight = 0;
  let exactRegistration = false;
  let strongAddress = false;
  let corroboratingSignals = 0;
  let hardConflict = false;

  if (left.registrationNumber && right.registrationNumber) {
    const a = normalizeRegistrationNumber(left.registrationNumber);
    const b = normalizeRegistrationNumber(right.registrationNumber);
    totalWeight += 0.5;
    if (a && a === b) {
      weightedScore += 0.5;
      exactRegistration = true;
      addEvidence(
        evidence,
        "registration_number",
        "民宿／旅館登記編號",
        1,
        `登記編號完全一致：${left.registrationNumber}`,
        "strong",
      );
    } else {
      hardConflict = true;
      conflicts.push("登記編號不同");
      addEvidence(
        evidence,
        "registration_number",
        "民宿／旅館登記編號",
        0,
        `登記編號衝突：${left.registrationNumber} ≠ ${right.registrationNumber}`,
        "conflict",
      );
    }
  }

  if (left.address && right.address) {
    const address = compareTaiwanAddresses(left.address, right.address);
    totalWeight += 0.34;
    weightedScore += 0.34 * address.score;
    strongAddress = address.score >= 0.88 && address.conflicts.length === 0;
    if (address.conflicts.length) {
      hardConflict = true;
      conflicts.push(...address.conflicts);
    }
    addEvidence(
      evidence,
      "address",
      "標準化地址",
      address.score,
      strongAddress
        ? "行政區、道路與門牌高度一致；村里鄰缺漏已視為可省略欄位。"
        : address.conflicts.length
          ? address.conflicts.join("；")
          : "地址部分相符，仍需電話、經緯度或名稱等訊號補強。",
      address.conflicts.length ? "conflict" : strongAddress ? "strong" : "supporting",
    );
  }

  if (left.phone && right.phone) {
    const a = normalizePhone(left.phone);
    const b = normalizePhone(right.phone);
    const matched = a.length >= 8 && a === b;
    totalWeight += 0.08;
    if (matched) {
      weightedScore += 0.08;
      corroboratingSignals += 1;
    }
    addEvidence(
      evidence,
      "phone",
      "電話",
      matched ? 1 : 0,
      matched ? `電話一致：${left.phone}` : `電話不同：${left.phone} ≠ ${right.phone}`,
      matched ? "supporting" : "weak",
    );
  }

  if (left.websiteUrl && right.websiteUrl) {
    const a = hostname(left.websiteUrl);
    const b = hostname(right.websiteUrl);
    const matched = Boolean(a && b && a === b);
    totalWeight += 0.06;
    if (matched) {
      weightedScore += 0.06;
      corroboratingSignals += 1;
    }
    addEvidence(
      evidence,
      "website",
      "官網網域",
      matched ? 1 : 0,
      matched ? `官網網域一致：${a}` : `網域不同：${a ?? "未知"} ≠ ${b ?? "未知"}`,
      matched ? "supporting" : "weak",
    );
  }

  const meters = distanceMeters(left, right);
  if (meters !== null) {
    const geoScore = meters <= 50 ? 1 : meters <= 150 ? 0.82 : meters <= 500 ? 0.45 : 0;
    totalWeight += 0.12;
    weightedScore += 0.12 * geoScore;
    if (meters <= 150) corroboratingSignals += 1;
    if (meters > 1500) {
      hardConflict = true;
      conflicts.push(`經緯度相距 ${Math.round(meters)} 公尺`);
    }
    addEvidence(
      evidence,
      "geolocation",
      "經緯度",
      geoScore,
      `兩來源相距約 ${Math.round(meters)} 公尺。`,
      meters <= 150 ? "supporting" : meters > 1500 ? "conflict" : "weak",
    );
  }

  if (left.name && right.name) {
    const similarity = textSimilarity(left.name, right.name);
    totalWeight += 0.1;
    weightedScore += 0.1 * similarity;
    addEvidence(
      evidence,
      "name",
      "住宿名稱",
      similarity,
      similarity >= 0.72
        ? `名稱語意高度相似：${left.name} / ${right.name}`
        : `名稱差異較大：${left.name} / ${right.name}`,
      similarity >= 0.72 ? "supporting" : "weak",
    );
  }

  let score = totalWeight > 0 ? weightedScore / totalWeight : 0;
  if (hardConflict) score = Math.min(score, 0.35);
  score = Math.max(0, Math.min(1, score));

  let status: PropertyIdentityMatch["status"] = "review";
  if (hardConflict) {
    status = "rejected";
  } else if (
    exactRegistration ||
    strongAddress ||
    (score >= 0.82 && corroboratingSignals >= 2)
  ) {
    status = "confirmed";
  } else if (score < 0.45 && corroboratingSignals === 0) {
    status = "rejected";
  }

  return {
    score,
    status,
    evidence,
    conflicts: [...new Set(conflicts)],
  };
}
