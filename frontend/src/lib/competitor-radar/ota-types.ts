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

/** Capacity confirmation for competitor-radar sell-through / heat (FE gate). */
export type CapacityStatus = "confirmed" | "pending" | "draft";

export type InventorySource = "confirmed" | "estimated" | "user_confirmed";

export interface CapacityProvenance {
  confirmedAt: string;
  confirmedBy: string;
  source: { kind: "manual_confirmed"; method: string; note?: string };
  roomCatalogFingerprint: string;
  path?: string;
  dailyTotalUnits: number;
}

/**
 * Capacity fields expected on github/receiver RadarImport payloads.
 * Prefer attaching these on RadarImport in radar-dashboard; kept here for shared typing.
 */
export interface RadarCapacityFields {
  capacityStatus?: CapacityStatus;
  roomInventory?: Record<string, number>;
  /** Display-only when present; NEVER used for rates/heat. */
  draftInventory?: Record<string, number>;
  inventorySource?: InventorySource;
  capacityProvenance?: CapacityProvenance;
  assumeUnlisted?: boolean;
  allowInventoryEditing?: boolean;
}
