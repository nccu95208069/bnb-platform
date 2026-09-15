import type { CanonicalRoomDraft, PropertyIdentityInput } from "./types";

export type OtaPlatform = "booking" | "agoda" | "trip";
export type OtaScanState = "ready" | "partial" | "not_found" | "blocked" | "failed";
export type OtaAvailability = "available" | "sold_out" | "unknown";
export type OtaQuantityState = "exact" | "capped" | "unknown";

export interface OtaRoomObservation {
  sourceRoomId: string;
  sourceRoomName: string;
  canonicalRoomId?: string;
  ratePlan?: string;
  availability: OtaAvailability;
  quantityState: OtaQuantityState;
  quantity?: number;
  amount?: number;
  displayedAmount?: number;
  displayedPriceBasis?: "tax_excluded";
  priceBasis?: "tax_inclusive_stay_total";
  currency?: string;
  sourceText?: string;
  sourceUrl?: string;
  returnedContext?: import("./ota-evidence").ReturnedStayContext;
  contextVerified?: boolean;
  priceDetails?: { preTaxAmount?: number; taxesAndFees?: number; discounts: string[]; source: "property_offer" | "checkout_summary" };
}

export interface OtaDayObservation {
  observedAt?: string;
  priceReview?: boolean;
  provenance?: { repository: string; commit: string; jobId: string; attemptId: string; runId: string; path: string };
  roomIssues?: Record<string, string>;
  stayDate: string;
  checkOut: string;
  state: OtaScanState;
  availability: OtaAvailability;
  minAmount?: number;
  currency?: string;
  sourceUrl?: string;
  identityVerified: boolean;
  dateVerified: boolean;
  rooms: OtaRoomObservation[];
  message?: string;
}

export interface OtaPropertyIdentity {
  platform: OtaPlatform;
  sourceUrl?: string;
  sourcePropertyId?: string;
  sourceName?: string;
  sourceAddress?: string;
  sourceRegistrationNumber?: string;
  score?: number;
  status: "confirmed" | "review" | "rejected" | "not_found";
  evidence: string[];
}

export interface OtaPlatformScan {
  platform: OtaPlatform;
  state: OtaScanState;
  capturedAt: string;
  collectionState?: "attempted" | "paused" | "withdrawn";
  evidenceVersion?: string;
  requestedDays: number;
  completedDays: number;
  identity: OtaPropertyIdentity;
  observations: OtaDayObservation[];
  warnings: string[];
  durationMs: number;
  collector?: "desktop_computer_use" | "anonymous_browser";
}

export interface OtaSourceOverride {
  roomNumber?: string;
  url: string;
}

export interface OtaScanRequest {
  platform: OtaPlatform;
  startDate: string;
  days: number;
  adults: number;
  property: PropertyIdentityInput & {
    sourceUrl?: string | null;
    websiteHost?: string | null;
  };
  canonicalRooms: CanonicalRoomDraft[];
  sourceUrl?: string;
  sourceOverrides?: OtaSourceOverride[];
}

export interface OtaScanResponse {
  scan: OtaPlatformScan;
  capability: {
    source: "isolated_browser";
    live: boolean;
    physicalInventory: false;
    confirmedBookings: false;
  };
}

/**
 * Capacity confirmation for competitor-radar sell-through / heat (FE gate).
 * Phase 1 publish uses "confirmed" | "unconfirmed". "pending" / "draft" are legacy aliases
 * and must be treated like unconfirmed for rates/heat.
 */
export type CapacityStatus = "confirmed" | "unconfirmed" | "pending" | "draft";

export type InventorySource = "confirmed" | "estimated" | "user_confirmed";

/**
 * Phase 1 confirmed provenance is flat: confirmedBy / method / dailyTotalUnits / fingerprint / path.
 * Nested `source` and `confirmedAt` remain optional so older payloads still render.
 */
export interface CapacityProvenance {
  confirmedBy: string;
  method: string;
  dailyTotalUnits: number;
  roomCatalogFingerprint: string;
  path?: string;
  /** Legacy; prefer top-level inventoryAsOf on the import payload. */
  confirmedAt?: string;
  source?: { kind?: string; method?: string; note?: string };
}

/**
 * Capacity fields expected on github/receiver RadarImport payloads.
 * Unconfirmed payloads omit roomInventory, inventorySource, inventoryAsOf, inventoryNote, capacityProvenance.
 */
export interface RadarCapacityFields {
  capacityStatus?: CapacityStatus;
  roomInventory?: Record<string, number>;
  /** Display-only when present; NEVER used for rates/heat. */
  draftInventory?: Record<string, number>;
  inventorySource?: InventorySource;
  inventoryAsOf?: string;
  inventoryNote?: string;
  capacityProvenance?: CapacityProvenance;
  assumeUnlisted?: boolean;
  allowInventoryEditing?: boolean;
}

export function capacityProvenanceMethod(provenance?: CapacityProvenance | null): string | undefined {
  return provenance?.method || provenance?.source?.method;
}
