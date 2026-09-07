export type PlatformKey = "official" | "booking" | "agoda" | "trip";

export type PlatformCollectionStatus =
  | "discovered"
  | "adapter_pending"
  | "identity_review"
  | "fetch_failed";

export type IdentityStatus = "confirmed" | "review" | "rejected";

export type EvidenceStrength = "strong" | "supporting" | "weak" | "conflict";

export type RoomDraftOrigin =
  | "website_jsonld"
  | "website_listing"
  | "website_detail"
  | "golden_fixture"
  | "manual";

export type AvailabilityState =
  | "available_exact"
  | "available_capped"
  | "available_quantity_unknown"
  | "sold_out"
  | "room_not_listed"
  | "fetch_failed"
  | "identity_not_confirmed"
  | "date_mismatch"
  | "not_collected";

export interface ParsedTaiwanAddress {
  raw: string;
  normalized: string;
  city?: string;
  district?: string;
  village?: string;
  neighborhood?: string;
  road?: string;
  section?: string;
  lane?: string;
  alley?: string;
  number?: string;
  subNumber?: string;
  floor?: string;
  identityKey: string;
}

export interface AddressMatchEvidence {
  field: string;
  label: string;
  left?: string;
  right?: string;
  matched: boolean;
  optional?: boolean;
  detail: string;
}

export interface AddressMatchResult {
  score: number;
  status: "match" | "review" | "conflict" | "insufficient";
  evidence: AddressMatchEvidence[];
  conflicts: string[];
  left: ParsedTaiwanAddress;
  right: ParsedTaiwanAddress;
}

export interface PropertyIdentityInput {
  name?: string | null;
  address?: string | null;
  registrationNumber?: string | null;
  phone?: string | null;
  websiteUrl?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface IdentityEvidence {
  field:
    | "registration_number"
    | "address"
    | "phone"
    | "website"
    | "geolocation"
    | "name";
  label: string;
  strength: EvidenceStrength;
  score: number;
  detail: string;
}

export interface PropertyIdentityMatch {
  score: number;
  status: IdentityStatus;
  evidence: IdentityEvidence[];
  conflicts: string[];
}

export interface RegistryCandidateSummary {
  hotelId: string;
  registrationNumber?: string;
  name: string;
  matchedName: string;
  address?: string;
  phone?: string;
  websiteUrl?: string;
  latitude?: number;
  longitude?: number;
  totalRooms?: number;
  lowestPrice?: number;
  ceilingPrice?: number;
  updateTime?: string;
  score: number;
  status: IdentityStatus;
  evidence: IdentityEvidence[];
  conflicts: string[];
  platformUrls: Partial<Record<Exclude<PlatformKey, "official">, string>>;
}

export interface TourismRegistryMatch {
  status: "matched" | "review" | "not_found" | "unavailable";
  sourceUrl: string;
  selectedHotelId?: string;
  candidates: RegistryCandidateSummary[];
  message: string;
}

export interface RoomFeatures {
  roomNumber?: string;
  capacity?: number;
  bundle: boolean;
  noWindow?: boolean;
  views: string[];
  amenities: string[];
  tokens: string[];
}

export interface CanonicalRoomDraft {
  id: string;
  name: string;
  sourceName: string;
  sourceUrl?: string;
  roomNumber?: string;
  capacity?: number;
  bundle: boolean;
  features: string[];
  origin: RoomDraftOrigin;
  editable: true;
}

export interface RoomMappingSuggestion {
  canonicalRoomId: string;
  sourceRoomId: string;
  score: number;
  confidence: "high" | "medium" | "low";
  conflicts: string[];
  reasons: string[];
}

export interface PlatformRoomOffer {
  sourceRoomId: string;
  sourceRoomName: string;
  canonicalRoomId?: string;
  checkIn: string;
  checkOut: string;
  occupancy: number;
  availability: AvailabilityState;
  quantity?: number;
  quantityCap?: number;
  currency?: string;
  totalPrice?: number;
  refundable?: boolean;
  breakfastIncluded?: boolean;
}

export interface PlatformSourceDraft {
  platform: PlatformKey;
  label: string;
  status: PlatformCollectionStatus;
  sourceUrl?: string;
  matchedName?: string;
  identityConfidence?: number;
  identityEvidence: IdentityEvidence[];
  rooms: PlatformRoomOffer[];
  message: string;
}

export interface DiscoveredProperty {
  name: string;
  sourceUrl: string;
  websiteHost: string;
  description?: string;
  address?: string;
  normalizedAddress?: string;
  registrationNumber?: string;
  phone?: string;
  latitude?: number;
  longitude?: number;
  identityStatus: IdentityStatus;
  confidence: number;
}

export interface CompetitorRadarAnalysis {
  analysisId: string;
  analyzedAt: string;
  requestedUrl: string;
  finalUrl: string;
  property: DiscoveredProperty;
  identityEvidence: IdentityEvidence[];
  tourismRegistry?: TourismRegistryMatch;
  canonicalRooms: CanonicalRoomDraft[];
  platformSources: PlatformSourceDraft[];
  dateWindow: {
    start: string;
    end: string;
    days: number;
  };
  warnings: string[];
}
