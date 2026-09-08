import type { OtaPlatformScan } from "./ota-types";

export interface ReturnedStayContext {
  checkIn?: string;
  checkOut?: string;
  adults?: number;
  children?: number;
  rooms?: number;
  currency?: string;
}
export function contextMatches(requested: Required<ReturnedStayContext>, returned: ReturnedStayContext): boolean {
  return Object.entries(requested).every(([key, value]) => returned[key as keyof ReturnedStayContext] === value);
}
export function sameListing(expected: string, returned: string | undefined): boolean {
  try {
    const a = new URL(expected), b = new URL(returned ?? "");
    return b.protocol === "https:" && !b.username && !b.password && (!b.port || b.port === "443") &&
      a.hostname === b.hostname && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
  } catch { return false; }
}


export const AGODA_EVIDENCE_VERSION = "property-offers-v2";

/** Retain the draft and other platforms, but never reuse the disputed legacy room-page results. */
export function currentScan(scan: OtaPlatformScan): OtaPlatformScan {
  if (scan.platform !== "agoda" || scan.evidenceVersion === AGODA_EVIDENCE_VERSION) return scan;
  return { ...scan, state: "partial", collectionState: "withdrawn", completedDays: 0, observations: [],
    identity: { ...scan.identity, status: "review", evidence: [] },
    warnings: ["先前逐房頁面的 Agoda 結果已撤回，需改由正確住宿頁重新核對。"],
  };
}
