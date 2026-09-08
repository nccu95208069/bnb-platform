import type {
  AddressMatchEvidence,
  AddressMatchResult,
  ParsedTaiwanAddress,
} from "./types";

const OPTIONAL_LOCALITY_PATTERN = /(?:[^縣市區鄉鎮路街大道巷弄號]{1,12})(?:村|里)/g;
const NEIGHBORHOOD_PATTERN = /\d+鄰/g;

function chineseNumber(value: string): string {
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (!/[十百千]/.test(value)) return [...value].map(char => digits[char]).join("");
  let total = 0, current = 0;
  for (const char of value) {
    const unit = ({ 十: 10, 百: 100, 千: 1000 } as Record<string, number>)[char];
    if (unit) { total += (current || 1) * unit; current = 0; }
    else current = digits[char] ?? 0;
  }
  return String(total + current);
}

function cleanText(value: string): string {
  return value
    .normalize("NFKC")
    .replaceAll("台", "臺")
    .replace(/[零〇一二兩三四五六七八九十百千]+(?=段|巷|弄|鄰|號|之|-)/g, chineseNumber)
    .replace(/(?<=之)[零〇一二兩三四五六七八九十百千]+(?=號|$)/g, chineseNumber)
    .replace(/[－–—]/g, "-")
    .replace(/(\d+)\s*號\s*之\s*(\d+)/g, "$1-$2號")
    .replace(/(\d+)\s*之\s*(\d+)\s*號/g, "$1-$2號")
    .replace(/(\d+)\s*之\s*(\d+)(?=\D|$)/g, "$1-$2")
    .replace(/[，,、；;。．·]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

export function normalizeTaiwanAddress(value: string): string {
  return cleanText(value)
    .replace(/^\d{3,6}/, "")
    .replace(/中華民國/g, "")
    .replace(/臺灣(?:省)?/g, "");
}

function takePrefix(
  rest: string,
  pattern: RegExp,
): { value?: string; rest: string } {
  const match = rest.match(pattern);
  if (!match || match.index !== 0 || !match[1]) {
    return { rest };
  }
  return { value: match[1], rest: rest.slice(match[0].length) };
}

export function parseTaiwanAddress(value: string): ParsedTaiwanAddress {
  const normalized = normalizeTaiwanAddress(value);
  let rest = normalized;

  const cityResult = takePrefix(rest, /^(.+?[縣市])/);
  const city = cityResult.value;
  rest = cityResult.rest;

  const districtResult = takePrefix(rest, /^(.+?(?:區|鄉|鎮|市))/);
  const district = districtResult.value;
  rest = districtResult.rest;

  const villageResult = takePrefix(rest, /^(.+?(?:村|里))/);
  const village = villageResult.value;
  rest = villageResult.rest;

  const neighborhoodResult = takePrefix(rest, /^(\d+鄰)/);
  const neighborhood = neighborhoodResult.value;
  rest = neighborhoodResult.rest;

  const roadResult = takePrefix(rest, /^(.+?(?:大道|路|街))/);
  const road = roadResult.value;
  rest = roadResult.rest;

  const sectionResult = takePrefix(rest, /^(\d+段)/);
  const section = sectionResult.value;
  rest = sectionResult.rest;

  const laneResult = takePrefix(rest, /^(\d+巷)/);
  const lane = laneResult.value;
  rest = laneResult.rest;

  const alleyResult = takePrefix(rest, /^(\d+弄)/);
  const alley = alleyResult.value;
  rest = alleyResult.rest;

  const houseMatch = rest.match(/(\d+)(?:-(\d+))?號/);
  const number = houseMatch?.[1];
  const subNumber = houseMatch?.[2];
  const floorMatch = rest.match(/(?:號)?([B\d]+(?:之\d+)?樓)/i);
  const floor = floorMatch?.[1];

  const identityKey = [
    city,
    district,
    road,
    section,
    lane,
    alley,
    number ? `${number}${subNumber ? `-${subNumber}` : ""}號` : undefined,
  ]
    .filter(Boolean)
    .join("");

  return {
    raw: value,
    normalized,
    city,
    district,
    village,
    neighborhood,
    road,
    section,
    lane,
    alley,
    number,
    subNumber,
    floor,
    identityKey,
  };
}

function bigrams(value: string): string[] {
  const normalized = cleanText(value).toLocaleLowerCase("zh-TW");
  if (normalized.length < 2) return normalized ? [normalized] : [];
  return Array.from({ length: normalized.length - 1 }, (_, index) =>
    normalized.slice(index, index + 2),
  );
}

export function textSimilarity(left: string, right: string): number {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.length || !b.length) return 0;

  const counts = new Map<string, number>();
  for (const gram of a) counts.set(gram, (counts.get(gram) ?? 0) + 1);

  let intersection = 0;
  for (const gram of b) {
    const remaining = counts.get(gram) ?? 0;
    if (remaining > 0) {
      intersection += 1;
      counts.set(gram, remaining - 1);
    }
  }
  return (2 * intersection) / (a.length + b.length);
}

function compactIdentityAddress(parsed: ParsedTaiwanAddress): string {
  return parsed.normalized
    .replace(OPTIONAL_LOCALITY_PATTERN, "")
    .replace(NEIGHBORHOOD_PATTERN, "")
    .replace(/(?:\d+樓|B\d+樓)$/i, "");
}

interface ComponentRule {
  key: keyof ParsedTaiwanAddress;
  label: string;
  weight: number;
  exact?: boolean;
  optional?: boolean;
}

const COMPONENT_RULES: ComponentRule[] = [
  { key: "city", label: "縣市", weight: 0.12, exact: true },
  { key: "district", label: "行政區", weight: 0.18, exact: true },
  { key: "road", label: "道路", weight: 0.28, exact: true },
  { key: "section", label: "段", weight: 0.05, exact: true, optional: true },
  { key: "lane", label: "巷", weight: 0.08, exact: true, optional: true },
  { key: "alley", label: "弄", weight: 0.06, exact: true, optional: true },
  { key: "number", label: "門牌", weight: 0.18, exact: true },
  { key: "subNumber", label: "附號", weight: 0.05, exact: true, optional: true },
];

function classifyScore(score: number, conflicts: string[]): AddressMatchResult["status"] {
  if (conflicts.length) return "conflict";
  if (score >= 0.88) return "match";
  if (score >= 0.6) return "review";
  return "insufficient";
}

export function compareTaiwanAddresses(leftRaw: string, rightRaw: string): AddressMatchResult {
  const left = parseTaiwanAddress(leftRaw);
  const right = parseTaiwanAddress(rightRaw);
  const evidence: AddressMatchEvidence[] = [];
  const conflicts: string[] = [];

  const compactLeft = compactIdentityAddress(left);
  const compactRight = compactIdentityAddress(right);
  const hasComparableCore = Boolean(
    left.district && right.district && left.road && right.road && left.number && right.number,
  );
  if (hasComparableCore && compactLeft === compactRight) {
    return {
      score: 1,
      status: "match",
      conflicts,
      evidence: [
        {
          field: "normalized",
          label: "標準化地址",
          left: compactLeft,
          right: compactRight,
          matched: true,
          detail: "移除村里鄰、空白與門牌格式差異後完全一致。",
        },
      ],
      left,
      right,
    };
  }

  let earned = 0;
  let possible = 0;
  let comparedCoreComponents = 0;

  for (const rule of COMPONENT_RULES) {
    const leftValue = left[rule.key];
    const rightValue = right[rule.key];
    if (typeof leftValue !== "string" || typeof rightValue !== "string") {
      if (rule.optional && (leftValue || rightValue)) {
        evidence.push({
          field: String(rule.key),
          label: rule.label,
          left: typeof leftValue === "string" ? leftValue : undefined,
          right: typeof rightValue === "string" ? rightValue : undefined,
          matched: true,
          optional: true,
          detail: `${rule.label}僅一方提供，不視為不一致。`,
        });
      }
      continue;
    }

    possible += rule.weight;
    if (["city", "district", "road", "number"].includes(String(rule.key))) {
      comparedCoreComponents += 1;
    }

    const similarity = rule.exact
      ? leftValue === rightValue
        ? 1
        : 0
      : textSimilarity(leftValue, rightValue);
    earned += rule.weight * similarity;

    const matched = rule.exact ? similarity === 1 : similarity >= 0.78;
    evidence.push({
      field: String(rule.key),
      label: rule.label,
      left: leftValue,
      right: rightValue,
      matched,
      optional: rule.optional,
      detail: matched
        ? `${rule.label}相符。`
        : `${rule.label}不同，需搭配其他身分訊號確認。`,
    });

    if (!matched && ["city", "district", "road", "number"].includes(String(rule.key))) {
      const conflict = `${rule.label}衝突：${leftValue} ≠ ${rightValue}`;
      conflicts.push(conflict);
    }
  }

  let score = possible > 0 ? earned / possible : 0;

  const roadComparable = Boolean(left.road && right.road);
  const numberComparable = Boolean(left.number && right.number);
  if (!roadComparable || !numberComparable) score = Math.min(score, 0.68);
  if (comparedCoreComponents < 3) score = Math.min(score, 0.7);
  if (left.number && right.number && left.number !== right.number) score = Math.min(score, 0.3);
  if (left.subNumber && right.subNumber && left.subNumber !== right.subNumber) {
    score = Math.min(score, 0.5);
    conflicts.push(`附號衝突：${left.subNumber} ≠ ${right.subNumber}`);
  }

  if (left.village || right.village) {
    evidence.push({
      field: "village",
      label: "村里",
      left: left.village,
      right: right.village,
      matched: true,
      optional: true,
      detail: "村里為可省略欄位；只有一方提供時不扣分。",
    });
  }

  score = Math.max(0, Math.min(1, score));
  return {
    score,
    status: classifyScore(score, conflicts),
    evidence,
    conflicts: [...new Set(conflicts)],
    left,
    right,
  };
}
