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
  currency?: string;
  sourceText?: string;
}

export interface OtaDayObservation {
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
  requestedDays: number;
  completedDays: number;
  identity: OtaPropertyIdentity;
  observations: OtaDayObservation[];
  warnings: string[];
  durationMs: number;
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
    live: true;
    physicalInventory: false;
    confirmedBookings: false;
  };
}
