import { textSimilarity } from "./address";
import type {
  CanonicalRoomDraft,
  RoomFeatures,
  RoomMappingSuggestion,
} from "./types";

const NUMBER_WORDS: Array<[RegExp, number]> = [
  [/(?:十|10)人/, 10],
  [/(?:九|9)人/, 9],
  [/(?:八|8)人/, 8],
  [/(?:七|7)人/, 7],
  [/(?:六|6)人/, 6],
  [/(?:五|5)人/, 5],
  [/(?:四|4)人/, 4],
  [/(?:三|3)人/, 3],
  [/(?:雙|二|2)人/, 2],
  [/(?:單|一|1)人/, 1],
];

const VIEW_FEATURES: Array<[RegExp, string]> = [
  [/(?:河景|river\s*view)/i, "river_view"],
  [/(?:海景|ocean\s*view|sea\s*view)/i, "ocean_view"],
  [/(?:山景|mountain\s*view)/i, "mountain_view"],
  [/(?:市景|city\s*view)/i, "city_view"],
  [/(?:花園景|garden\s*view)/i, "garden_view"],
];

const AMENITY_FEATURES: Array<[RegExp, string]> = [
  [/(?:浴缸|bathtub|bath\s*tub)/i, "bathtub"],
  [/(?:陽台|露台|balcony|terrace)/i, "balcony"],
  [/(?:天窗|skylight)/i, "skylight"],
  [/(?:無窗|no\s*window|windowless)/i, "no_window"],
  [/(?:和室|榻榻米|tatami)/i, "tatami"],
  [/(?:兩張|2\s*(?:double|queen|king)|two\s*beds?)/i, "two_beds"],
  [/(?:特大床|king\s*bed)/i, "king_bed"],
  [/(?:沙發床|sofa\s*bed)/i, "sofa_bed"],
  [/(?:寵物|pet[-\s]?friendly)/i, "pet_friendly"],
];

function normalizeRoomText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-TW")
    .replace(/[()（）【】\[\]·,，。/\\_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function inferCapacity(text: string): number | undefined {
  const numeric = text.match(/(?:最多|標準|可住|容納|max(?:imum)?\s*)?\s*(\d{1,2})\s*(?:位|人|guests?)/i);
  if (numeric?.[1]) return Number(numeric[1]);
  for (const [pattern, capacity] of NUMBER_WORDS) {
    if (pattern.test(text)) return capacity;
  }
  if (/(?:quad|quadruple)/i.test(text)) return 4;
  if (/(?:triple)/i.test(text)) return 3;
  if (/(?:double|twin)/i.test(text)) return 2;
  return undefined;
}

export function extractRoomFeatures(value: string): RoomFeatures {
  const normalized = normalizeRoomText(value);
  const roomNumber = normalized.match(/(?:^|\s)([1-9]\d{2})(?=\s|$)/)?.[1];
  const bundle = /(?:包棟|整棟|全棟|entire\s*(?:home|house|villa)|whole\s*(?:house|villa))/i.test(
    normalized,
  );
  const noWindow = /(?:無窗|no\s*window|windowless)/i.test(normalized)
    ? true
    : /(?:有窗|window\s*view|river\s*view|ocean\s*view|mountain\s*view)/i.test(normalized)
      ? false
      : undefined;
  const views = VIEW_FEATURES.filter(([pattern]) => pattern.test(normalized)).map(([, key]) => key);
  const amenities = AMENITY_FEATURES.filter(([pattern]) => pattern.test(normalized)).map(
    ([, key]) => key,
  );

  const tokens = normalized
    .split(" ")
    .filter((token) => token.length >= 2 && !/^(?:room|房型|客房|套房)$/.test(token));

  return {
    roomNumber,
    capacity: inferCapacity(normalized),
    bundle,
    noWindow,
    views: unique(views),
    amenities: unique(amenities),
    tokens: unique(tokens),
  };
}

function jaccard(left: string[], right: string[]): number | null {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (!union.size) return null;
  const intersection = [...a].filter((value) => b.has(value)).length;
  return intersection / union.size;
}

interface RoomMatchScore {
  score: number;
  confidence: RoomMappingSuggestion["confidence"];
  conflicts: string[];
  reasons: string[];
}

export function scoreRoomMatch(leftName: string, rightName: string): RoomMatchScore {
  const left = extractRoomFeatures(leftName);
  const right = extractRoomFeatures(rightName);
  const conflicts: string[] = [];
  const reasons: string[] = [];

  if (left.bundle !== right.bundle) conflicts.push("包棟商品與單一房型不可直接對應");
  if (left.roomNumber && right.roomNumber && left.roomNumber !== right.roomNumber) {
    conflicts.push(`房號不同：${left.roomNumber} ≠ ${right.roomNumber}`);
  }
  if (left.capacity && right.capacity && left.capacity !== right.capacity) {
    conflicts.push(`標準入住人數不同：${left.capacity} ≠ ${right.capacity}`);
  }
  if (
    typeof left.noWindow === "boolean" &&
    typeof right.noWindow === "boolean" &&
    left.noWindow !== right.noWindow
  ) {
    conflicts.push("有窗／無窗資訊衝突");
  }

  if (conflicts.length) {
    return { score: 0, confidence: "low", conflicts, reasons };
  }

  let earned = 0;
  let possible = 0;

  if (left.roomNumber && right.roomNumber) {
    possible += 0.46;
    if (left.roomNumber === right.roomNumber) {
      earned += 0.46;
      reasons.push(`房號相同：${left.roomNumber}`);
    }
  }

  if (left.capacity && right.capacity) {
    possible += 0.22;
    if (left.capacity === right.capacity) {
      earned += 0.22;
      reasons.push(`入住人數相同：${left.capacity} 人`);
    }
  }

  const viewScore = jaccard(left.views, right.views);
  if (viewScore !== null) {
    possible += 0.12;
    earned += 0.12 * viewScore;
    if (viewScore > 0) reasons.push("景觀特徵相符");
  }

  const amenityScore = jaccard(left.amenities, right.amenities);
  if (amenityScore !== null) {
    possible += 0.12;
    earned += 0.12 * amenityScore;
    if (amenityScore > 0) reasons.push("浴缸、陽台、天窗或無窗等特徵相符");
  }

  const nameScore = textSimilarity(leftName, rightName);
  possible += 0.08;
  earned += 0.08 * nameScore;
  if (nameScore >= 0.68) reasons.push("房型名稱語意相近");

  const score = possible > 0 ? Math.max(0, Math.min(1, earned / possible)) : 0;
  return {
    score,
    confidence: score >= 0.82 ? "high" : score >= 0.62 ? "medium" : "low",
    conflicts,
    reasons,
  };
}

export function suggestRoomMappings(
  canonicalRooms: CanonicalRoomDraft[],
  sourceRooms: Array<{ id: string; name: string }>,
): RoomMappingSuggestion[] {
  const candidates = canonicalRooms.flatMap((canonical) =>
    sourceRooms.map((source) => ({
      canonical,
      source,
      ...scoreRoomMatch(canonical.name, source.name),
    })),
  );

  const usedCanonical = new Set<string>();
  const usedSource = new Set<string>();
  const suggestions: RoomMappingSuggestion[] = [];

  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (candidate.score < 0.55 || candidate.conflicts.length) continue;
    if (usedCanonical.has(candidate.canonical.id) || usedSource.has(candidate.source.id)) continue;
    usedCanonical.add(candidate.canonical.id);
    usedSource.add(candidate.source.id);
    suggestions.push({
      canonicalRoomId: candidate.canonical.id,
      sourceRoomId: candidate.source.id,
      score: candidate.score,
      confidence: candidate.confidence,
      conflicts: candidate.conflicts,
      reasons: candidate.reasons,
    });
  }

  return suggestions;
}

export const SWEETFUN_GOLDEN_ROOMS: CanonicalRoomDraft[] = [
  {
    id: "sweetfun-101",
    name: "101 河景四人房",
    sourceName: "101 River View Quad Room",
    roomNumber: "101",
    capacity: 4,
    bundle: false,
    features: ["river_view", "tatami"],
    origin: "golden_fixture",
    editable: true,
  },
  {
    id: "sweetfun-102",
    name: "102 侘寂雙人房",
    sourceName: "102 Wabi-sabi Double Room",
    roomNumber: "102",
    capacity: 2,
    bundle: false,
    features: ["bathtub", "no_window"],
    origin: "golden_fixture",
    editable: true,
  },
  {
    id: "sweetfun-201",
    name: "201 河景雙人房",
    sourceName: "201 River View Double Room",
    roomNumber: "201",
    capacity: 2,
    bundle: false,
    features: ["river_view", "bathtub"],
    origin: "golden_fixture",
    editable: true,
  },
  {
    id: "sweetfun-202",
    name: "202 侘寂四人房",
    sourceName: "202 Wabi-sabi Quad Room",
    roomNumber: "202",
    capacity: 4,
    bundle: false,
    features: ["no_window"],
    origin: "golden_fixture",
    editable: true,
  },
  {
    id: "sweetfun-301",
    name: "301 河景雙人房",
    sourceName: "301 River View Double Room",
    roomNumber: "301",
    capacity: 2,
    bundle: false,
    features: ["river_view", "bathtub", "balcony"],
    origin: "golden_fixture",
    editable: true,
  },
  {
    id: "sweetfun-302",
    name: "302 天窗雙人房",
    sourceName: "302 Skylight Double Room",
    roomNumber: "302",
    capacity: 2,
    bundle: false,
    features: ["skylight"],
    origin: "golden_fixture",
    editable: true,
  },
];
