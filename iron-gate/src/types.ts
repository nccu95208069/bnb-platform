export type BookingStatus = "held" | "confirmed" | "cancelled";
export type ChannelSyncState = "not_required" | "pending" | "verified" | "review_required";
export type OperationState = "sync_pending" | "sync_verified" | "review_required";
export type Action =
  | "booking:read"
  | "booking:create"
  | "booking:amend"
  | "booking:cancel"
  | "hold:write"
  | "payment:write"
  | "finance:ledger"
  | "event:read"
  | "occupancy:aggregate"
  | "housekeeping:read"
  | "source:write"
  | "channel:verify";
export type FieldGrant = "guest_name" | "contact" | "notes" | "money";

export type Principal = {
  /** Verified by the hosting auth adapter, never taken from a request body. */
  clientId: string;
  subjectId: string;
  origin: "os" | "line" | "website" | "guest" | "source" | "channel" | "service" | "finance";
  workspaceId: string;
  propertyIds: string[];
  actions: Action[];
  fields: FieldGrant[];
  /** Server-side routing generation; never a caller-asserted source of authority. */
  authorityEpoch: number;
  grantId?: string;
  bindingId?: string;
  /** Required for a guest's order-status credential; never supplied by a browser body. */
  bookingIdScope?: string;
  sourceSystem?: string;
  sourceAccount?: string;
};

export type Stay = {
  checkIn: string;
  checkOut: string;
  roomIds: string[];
};

export type Night = { roomId: string; date: string };
export type DesiredCell = Night & { desired: "open" | "closed" };
export type ObservedCell = Night & { count: number; isLock: boolean };

export type Booking = {
  id: string;
  workspaceId: string;
  propertyId: string;
  version: number;
  status: BookingStatus;
  channelSyncState: ChannelSyncState;
  channelOperationKey: string | null;
  stays: Stay[];
  guestName: string | null;
  contact: string | null;
  notes: string | null;
  totalCents: number | null;
  currency: "TWD";
  bookedAt: string | null;
  createdAt: string;
  source: "os" | "line" | "website" | "external";
  sourceKey: string | null;
  hold?: { schema: 1; scope: "platform_only"; startedAt: string; expiresAt: string;
    state: "active" | "converted" | "released"; convertedAt?: string; releasedAt?: string;
    latePaymentReview?: boolean };
  paymentEvents?: PaymentEvent[];
  /** Immutable source evidence for a read-only OS shadow import; never projected to API callers. */
  osSnapshot?: Record<string, unknown>;
  /** Restricted original room-night rows for a read-only Sweetfun Sheet candidate. */
  sweetfunSnapshot?: Record<string, unknown>;
};

export type PaymentEvent = {
  id: string;
  kind: "received" | "refunded";
  amountCents: number;
  currency: "TWD";
  evidenceRef: string;
  occurredAt: string;
  recordedAt: string;
  actorId: string;
};

export type SourceLink = {
  key: string;
  sourceSystem: string;
  sourceAccount: string;
  externalOrderId: string;
  bookingId: string | null;
  sourceVersion: string;
  lastAppliedBookingVersion: number;
  diverged: boolean;
  tombstoneNights: Night[];
};

export type ChannelOperation = {
  key: string;
  bookingId: string;
  bookingVersion: number;
  state: OperationState;
  cells: DesiredCell[];
  createdAt: string;
  verifiedAt: string | null;
  providerVersion: string | null;
  observations?: {
    observedAt: string;
    providerVersion: string;
    cells: ObservedCell[];
    exact: boolean;
    accepted: boolean;
  }[];
};

export type Fence = {
  key: string;
  cells: Night[];
  reason: "channel_pending" | "source_review";
};

export type RequestReceipt = {
  key: string;
  clientId: string;
  subjectId: string;
  grantId: string | null;
  propertyId: string;
  action: Action;
  requestHash: string;
  response: Record<string, unknown>;
};

export type PropertyState = {
  workspaceId: string;
  propertyId: string;
  roomIds: string[];
  version: number;
  authorityEpoch: number;
  /** A prepared import remains unable to accept writes until a separate cutover gate lifts it. */
  readOnly?: boolean;
  /** Restricted provenance for a prepared OS candidate. Never included in API projections. */
  osImport?: { sourceHash: string; workspaceVersion: number; propertySnapshot: Record<string, unknown> };
  /** Restricted source and exception evidence for a read-only Sweetfun Sheet candidate. */
  sweetfunImport?: Record<string, unknown>;
  channel: { mode: "none" | "owlnest"; ready: boolean; websiteSalesEnabled: boolean;
    grantId: string | null; websiteBindingId: string | null };
  sourceGrants: { grantId: string; sourceSystem: string; sourceAccount: string; active: boolean }[];
  bookings: Booking[];
  sourceLinks: SourceLink[];
  operations: ChannelOperation[];
  fences: Fence[];
  manualBlocks: Night[];
  receipts: RequestReceipt[];
};

export type CreateBookingInput = {
  expectedInventoryVersion: number;
  stays: Stay[];
  guestName: string | null;
  contact: string | null;
  notes: string | null;
  totalCents: number | null;
  bookedAt: string | null;
  source: "os" | "line" | "website";
};

export type CreateHoldInput = Omit<CreateBookingInput, "source">;

export type ExtendHoldInput = {
  expectedBookingVersion: number;
  newExpiresAt: string;
};

export type AmendBookingInput = {
  expectedBookingVersion: number;
  expectedInventoryVersion: number;
  changes: Partial<Pick<Booking, "stays" | "guestName" | "contact" | "notes" | "totalCents">>;
};

export type PaymentEventInput = {
  expectedBookingVersion: number;
  eventId: string;
  kind: "received" | "refunded";
  amountCents: number;
  currency: "TWD";
  evidenceRef: string;
  occurredAt: string;
};

export type SourceEventInput = {
  propertyId: string;
  sourceSystem: string;
  sourceAccount: string;
  externalOrderId: string;
  sourceVersion: string;
  previousSourceVersion: string | null;
  kind: "upsert" | "cancel";
  expectedInventoryVersion: number;
  stays: Stay[];
  guestName: string | null;
  bookedAt: string | null;
};

export type SourceOrderLookupInput = Pick<SourceEventInput,
  "propertyId" | "sourceSystem" | "sourceAccount" | "externalOrderId">;

export type ReadbackInput = {
  propertyId: string;
  operationKey: string;
  providerVersion: string;
  observedAt: string;
  cells: ObservedCell[];
};

export type BookingReceipt = {
  bookingId: string;
  bookingVersion: number;
  inventoryVersion: number;
  operationState: OperationState | "local_only";
  operationKey: string | null;
  refundReviewRequired: boolean;
};

export type EventType =
  | "booking.created" | "booking.amended" | "booking.cancelled"
  | "hold.created" | "hold.extended" | "hold.converted" | "hold.released"
  | "payment.recorded" | "source.applied" | "source.review_required"
  | "channel.verified" | "channel.review_required";

export type PendingEvent = {
  eventId: string;
  at: string;
  type: EventType;
  propertyId: string;
  bookingId: string | null;
  bookingVersion: number | null;
  inventoryVersion: number;
};

export type BookingEvent = PendingEvent & { cursor: number };

export type AuditRecord = {
  auditId: string;
  at: string;
  type: EventType;
  workspaceId: string;
  propertyId: string;
  bookingId: string | null;
  bookingVersion: number | null;
  bookingStatus: BookingStatus | null;
  inventoryVersion: number;
  actorOrigin: Principal["origin"];
  actorClientId: string;
  actorSubjectId: string;
  actorGrantId: string | null;
  requestKey: string | null;
};

export type TransactionContext = {
  emit(event: PendingEvent): void;
  audit(record: AuditRecord): void;
};

export interface PropertyRepository {
  read(propertyId: string): Promise<PropertyState | null>;
  /** Must commit the whole draft or none of it under one serializable property lock/CAS. */
  transact<T>(propertyId: string, fn: (draft: PropertyState, tx: TransactionContext) => Promise<T> | T): Promise<T>;
  events(propertyId: string, after: number, limit: number): Promise<BookingEvent[]>;
}
