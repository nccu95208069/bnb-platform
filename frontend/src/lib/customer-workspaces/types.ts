import type { CustomerCredential } from "./identity.ts";
import type {
  CalendarKind,
  CalendarReference,
  CalendarBinding,
  CalendarBatch,
  InventoryBlock,
} from "./calendar-types.ts";
export type Account = {
  id: string;
  email: string;
  credential: CustomerCredential;
  googleSubject?: string;
  emailVerifiedAt?: string;
  workspaces: {
    id: string;
    slug: string;
    name: string;
    creationKey: string;
    creationHash: string;
  }[];
};
export type Role =
  "owner" | "admin" | "housekeeper" | "viewer" | "viewer_no_price";
export type Membership = {
  accountId: string;
  email?: string;
  role: Role;
  active: boolean;
  allProperties: boolean;
  propertyIds: string[];
};
export type OrderTag = {
  id: string;
  name: string;
  short: string;
  color: "blue" | "orange" | "purple" | "green" | "rose" | "slate";
};
export type ReceiptAccount = { id: string; name: string; last4: string };
export type Property = {
  tags?: OrderTag[];
  receiptAccounts?: ReceiptAccount[];
  id: string;
  name: string;
  kind: "villa" | "rooms" | "mixed";
  rooms: { id: string; name: string }[];
  villaRoomIds: string[];
  sourceMode: "native";
  setup?: {
    mode: "empty" | "sheet" | "calendar";
    calendarKind?: CalendarKind;
    readyAt?: string;
    unresolvedCount?: number;
    coverageFrom?: string;
    coverageTo?: string;
    sheetUrl?: string;
    readableAt?: string;
    approvedByEmail?: string;
    approvedByOperator?: string;
  };
  pricing?: Pricing;
};
export type Pricing = {
  currency: "TWD";
  enabled: boolean;
  base: Record<string, number>;
  overrides: { roomId: string; from: string; to: string; amount: number }[];
};
export type StaySegment = {
  checkIn: string;
  checkOut: string;
  roomIds: string[];
};
export type Payment = {
  id: string;
  amount: number;
  kind: "deposit" | "balance" | "full" | "other" | "refund";
  receivedAt: string;
  method: string | null;
  actor: string;
  allocation?: "room" | "extra";
  receiptAccount?: ReceiptAccount;
  note?: string | null;
};
export type Booking = {
  platform?: string | null;
  bookedAt?: string | null; // Source booking date, never the import/creation date.
  bookedAtSource?: "manual" | "sheet";
  bookedAtTimeZone?: "Asia/Taipei";
  tagIds?: string[];
  id: string;
  version: number;
  propertyId: string;
  guestName: string | null;
  checkIn: string;
  checkOut: string;
  roomIds: string[];
  stays?: StaySegment[];
  nightlyPrices?: { roomId: string; date: string; amount: number }[];
  total: number | null;
  expectedDeposit?: number | null;
  openingReceived?: { amount: number; asOf: string; note: string | null };
  payments: Payment[];
  contact: string | null;
  notes: string | null;
  status: "confirmed" | "cancelled";
  guestNotified: false;
  createdAt: string;
  actor: string;
  entry: "os" | "sheet" | "calendar";
  calendar?: CalendarReference;
  imported?: {
    batchId: string;
    sourceKey: string;
    fingerprint: string;
    externalId: string | null;
    row: number;
    sourceRows?: number[];
    references?: { row: number; column?: number }[];
    normalizationVersion?: number;
  };
  importedFinance?: {
    currency: "TWD";
    amountBasis: "order" | "line" | "night" | "room-night" | "none";
    sourceAmount: number | null;
    receivedMeaning: "source" | "property" | "guest" | "none";
    propertyReceived: number | null;
    guestPaid: number | null;
    sourcePaid?: number | null;
  };
  requestKey: string;
  requestHash: string;
};
export type OrderReviewRecord = {
  id: string;
  propertyId: string;
  sourceId: string;
  source: "sheet" | "calendar";
  label: string;
  guestName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  roomIds: string[];
  issues: string[];
};
export type Workspace = {
  reviewRecords?: OrderReviewRecord[];
  id: string;
  slug: string;
  name: string;
  version: number;
  onboarding?: {
    requestId: string;
    sheetUrl?: string;
    calendarKind?: CalendarKind;
    approvedAt?: string;
    readyAt?: string;
    unresolvedCount?: number;
  };
  members: Membership[];
  properties: Property[];
  bookings: Booking[];
  blocks?: InventoryBlock[];
  calendarSources?: CalendarBinding[];
  calendarBatches?: CalendarBatch[];
  invitations?: Invitation[];
  availabilityLists?: AvailabilityList[];
  operations?: {
    key: string;
    actor: string;
    hash: string;
    action: string;
    targetId: string;
  }[];
  importBatches?: {
    id: string;
    actor: string;
    propertyId: string;
    createdAt: string;
    sourceTitle: string;
    source: {
      spreadsheetId: string;
      sheetId: number;
      headerRow: number;
      columns: Record<string, number>;
    };
    selectionHash: string;
    bookingIds: string[];
    undo?: { cancelled: string[]; skipped: string[] };
  }[];
  audit: { at: string; actor: string; action: string; targetId: string }[];
};
export type WorkspaceView = {
  reviewRecords?: OrderReviewRecord[];
  id: string;
  slug: string;
  name: string;
  version: number;
  role: Role;
  onboarding?: { complete: boolean; unresolvedCount: number };
  properties: Property[];
  bookings: Omit<Booking, "requestKey" | "requestHash" | "actor">[];
  blocks?: Omit<InventoryBlock, "calendar">[];
  readiness?: Record<
    string,
    {
      complete: boolean;
      unresolvedCount: number;
      coverageFrom?: string;
      coverageTo?: string;
      connected?: boolean;
      stale?: boolean;
      sourceUpdatedAt?: string;
    }
  >;
};
export type Invitation = {
  id: string;
  email: string;
  role: Exclude<Role, "owner">;
  allProperties: boolean;
  propertyIds: string[];
  generation: string;
  expiresAt: number;
  createdAt: string;
  revokedAt?: string;
  acceptedAt?: string;
  accountId?: string;
};
export type AvailabilityList = {
  id: string;
  title: string;
  propertyId: string;
  from: string;
  to: string;
  showPrices: boolean;
};
