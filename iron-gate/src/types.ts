export type BookingStatus = "held" | "confirmed" | "cancelled" | "retained";
export type ChannelSyncState = "not_required" | "action_required" | "awaiting_manual_sync" | "pending" | "verified" | "review_required" | "manually_confirmed";
export type OperationState = "sync_pending" | "sync_verified" | "review_required" | "retired_source_managed";
export type Action =
  | "booking:read"
  | "booking:aggregate"
  | "booking:create"
  | "booking:amend"
  | "booking:cancel"
  | "booking:manage_all"
  | "inventory:write"
  | "hold:write"
  | "card:sync"
  | "payment:write"
  | "finance:ledger"
  | "finance:read"
  | "finance:record_receipt"
  | "finance:record_expense"
  | "finance:correct"
  | "finance:refund"
  | "finance:import"
  | "finance:project"
  | "finance:status"
  | "finance:plan"
  | "finance:evidence"
  | "finance:settlement"
  | "event:read"
  | "occupancy:aggregate"
  | "housekeeping:read"
  | "source:write"
  | "channel:verify";
export type FieldGrant = "guest_name" | "contact" | "notes" | "money" | "payment_status";

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
  financeSourceInstanceId?: string;
  /** Stored credential restriction for general income and expense entries. */
  financeGeneralEntriesOnly?: true;
};

export type Stay = {
  checkIn: string;
  checkOut: string;
  roomIds: string[];
};

export type Night = { roomId: string; date: string };
export type NightPrice = Night & { amountCents: number };
export type DesiredCell = Night & { desired: "open" | "closed" };
export type ObservedCell = Night & { count: number; isLock: boolean };

/** A retained order has no current stay or price. This is historical evidence,
 * never a new payment, a refund, or permission to reopen provider stock. */
export type RetentionPeriod = {
  id: string;
  retainedAt: string;
  retainedBookingVersion: number;
  reason: string;
  expiresOn: string | null;
  previousStays: Stay[];
  previousTotalCents: number | null;
  previousRoomNightPrices?: NightPrice[];
  rescheduledAt?: string;
  rescheduledBookingVersion?: number;
  rescheduledRequestKey?: string;
  rescheduledStays?: Stay[];
  rescheduledTotalCents?: number;
  rescheduledRoomNightPrices?: NightPrice[];
};

export type BookingRetention = {
  schema: 1;
  lifecycleRevision: number;
  activeRetentionId: string | null;
  history: RetentionPeriod[];
  /** Private, immutable source ownership captured when the owner takes over.
   * It remains active after rescheduling, including for delayed cancellations. */
  sourceAliases: { sourceSystem: string; sourceAccount: string; externalOrderId: string }[];
  sourceOrderRef: string | null;
  sourceReviews: { requestKey: string; receivedAt: string; sourceSystem: string;
    sourceAccount: string; externalOrderId: string; sourceVersion: string;
    kind: "upsert" | "cancel" }[];
};

export type Booking = {
  id: string;
  workspaceId: string;
  propertyId: string;
  version: number;
  status: BookingStatus;
  channelSyncState: ChannelSyncState;
  channelOperationKey: string | null;
  /** Owner-attested external handling. Never provider verification or permission to write stock. */
  manualRoomHandling?: { confirmedAt: string; confirmedBookingVersion: number;
    requestKey: string; closedNights: Night[]; pending: DesiredCell[] };
  /** LINE manual policy: provider-proven closed nights before any unconfirmed local edit. */
  lineChannelBaselineNights?: Night[];
  /** Exact room-night work still requiring a separate staff confirmation. */
  lineChannelPending?: DesiredCell[];
  /** When the current exact staff-action set first became required. */
  lineChannelActionRequiredAt?: string | null;
  stays: Stay[];
  guestName: string | null;
  contact: string | null;
  notes: string | null;
  totalCents: number | null;
  /** Exact, verified LINE room-night allocation; absent means unknown. */
  roomNightPrices?: NightPrice[];
  currency: "TWD";
  bookedAt: string | null;
  createdAt: string;
  source: "os" | "line" | "website" | "external";
  sourceKey: string | null;
  /** Owner has edited a legacy LINE order; preserve its identity and source evidence. */
  osDirectOverride?: boolean;
  /** Saved room changes wait for explicit synchronization; old nights stay fenced. */
  osManualRoomChange?: { baseline: Night[]; baselineState: ChannelSyncState;
    baselineOperationKey: string | null };
  /** A LINE override of an external source awaits upstream reconciliation. */
  lineOverridePending?: boolean;
  /** Contact and notes cannot be proven by the source event protocol. */
  lineOverrideUnverifiable?: boolean;
  /** Current source-event labels. Absent on legacy imports, whose immutable snapshot supplies labels. */
  sourceCalendar?: { platform: string | null; externalOrderNo: string | null };
  /** Private marker for a verified identity-only maintenance write; invalid after another booking mutation. */
  sourceAmountReconciliation?: import("./source-amount-reconciliation.ts").SourceAmountReconciliation;
  sourceIdentityEnrichment?: { schema: 1; bookingVersion: number; sourceOrderRef: string };
  hold?: { schema: 1; scope: "platform_only"; startedAt: string; expiresAt: string;
    state: "active" | "converted" | "released"; convertedAt?: string; releasedAt?: string;
    latePaymentReview?: boolean };
  retention?: BookingRetention;
  cardChargeResults?: import("./card-sync.ts").CardResult[];
  paymentEvents?: PaymentEvent[];
  /** Immutable source evidence for a read-only OS shadow import; never projected to API callers. */
  osSnapshot?: Record<string, unknown>;
  /** Restricted original room-night rows for a read-only Sweetfun Sheet candidate. */
  sweetfunSnapshot?: Record<string, unknown>;
  /** Restricted original room-night rows for an OFFLAND Sheet candidate. */
  offlandSnapshot?: Record<string, unknown>;
};

export type PaymentMetadata = {
  method?: "cash" | "bank_transfer" | "credit_card" | "other";
  refundOfEventId?: string;
};

export type PaymentEvent = PaymentMetadata & {
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
  /** Immutable first new-order mail evidence; never replaced by later source versions. */
  firstNewOrderNotification?: FirstNewOrderNotification;
};

export type FirstNewOrderNotification = Readonly<{
  schema: 1;
  receivedAt: string;
  sourceVersion: string;
  requestKey: string;
}>;

export type ChannelOperation = {
  /** Staff-confirmed provider control; never changes OS occupancy or booking sync. */
  controlMode?: "provider_only";
  key: string;
  bookingId: string | null;
  bookingVersion: number;
  state: OperationState;
  cells: DesiredCell[];
  createdAt: string;
  verifiedAt: string | null;
  providerVersion: string | null;
  /** Present only for staff-confirmed LINE operations. */
  lineGrantId?: string;
  lineActorId?: string;
  /** A pre-existing closed cell cannot prove it was closed for this booking. */
  ownCloseWriteRequired?: boolean;
  /** Bounded owner-login failures before a manual review, with no provider write. */
  preflightFailures?: number;
  /** A successful alert callback acknowledgement; retry until it is recorded. */
  reviewAlertedAt?: string;
  /** Manual OS close must observe every night open before any provider write. */
  manualInitialClose?: boolean;
  initialOpenPreflight?: { status: "open" | "blocked"; observedAt: string;
    providerVersion: string; cells: ObservedCell[] };
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
  reason: "channel_pending" | "source_review" | "line_action_required";
};

export type ChannelDispatchClaim = {
  claimId: string; operationKey: string;
  state: "active" | "review_required"; claimedAt: string;
  /** Only this dispatcher version can automatically isolate its settled reviews. */
  scopeVersion?: 1;
  /** Written only after this claim's provider runner has returned or thrown. */
  settledAt?: string;
};

export type ChannelReviewHold = {
  schemaVersion: 1;
  claim: ChannelDispatchClaim;
  cells: DesiredCell[];
  isolatedAt: string;
  reason: string;
  /** A recovery observation is evidence, never proof that the old writer succeeded. */
  observation?: { observedAt: string; providerVersion: string; cells: ObservedCell[] };
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
  /** First guaranteed full Taipei day with immutable first-notification capture. */
  reportingPolicy?: { schema: 1; authorityEpoch: number; notificationCoverageFrom: string; recordedAt: string };
  /** Restricted provenance for a prepared OS candidate. Never included in API projections. */
  osImport?: { sourceHash: string; workspaceVersion: number; propertySnapshot: Record<string, unknown> };
  /** Restricted source and exception evidence for a read-only Sweetfun Sheet candidate. */
  sweetfunImport?: Record<string, unknown>;
  /** Restricted provenance for a read-only OFFLAND Sheet candidate. */
  offlandImport?: Record<string, unknown>;
  channel: { mode: "none" | "owlnest"; ready: boolean; websiteSalesEnabled: boolean;
    /** Disabled until source events have a durable OwlNest operation dispatcher. */
    sourceReadbackEnabled?: boolean;
    /** Last date whose complete room stock was observed at mode activation. */
    stockObservedThrough?: string;
    /** First date of the same complete activation snapshot. */
    stockObservedFrom?: string;
    grantId: string | null; websiteBindingId: string | null };
  /** Private durable dispatcher claim. Never auto-expire across an unknown provider write. */
  channelDispatch?: ChannelDispatchClaim | null;
  /** Unresolved provider outcomes block only these exact room nights. */
  channelReviewHolds?: ChannelReviewHold[];
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
  roomNightPrices?: NightPrice[];
  bookedAt: string | null;
  source: "os" | "line" | "website";
  /** Opt-in rollout policy, bound into the LINE preview and request receipt. */
  channelPolicy?: "manual";
  acknowledgedClosedNights?: Night[];
};

export type LineInventoryInput = {
  expectedInventoryVersion: number;
  roomId: string;
  date: string;
  desired: "closed" | "open";
};

export type LineInventoryBatchInput = {
  expectedInventoryVersion: number;
  cells: { roomId: string; date: string }[];
  desired: "closed" | "open";
};

export type LineChannelActionInput = {
  expectedBookingVersion: number;
  expectedInventoryVersion: number;
  desired: "closed" | "open";
  cells: Night[];
};

export type CreateHoldInput = Omit<CreateBookingInput, "source">;

export type ExtendHoldInput = {
  expectedBookingVersion: number;
  newExpiresAt: string;
};

export type AmendBookingInput = {
  expectedBookingVersion: number;
  expectedInventoryVersion: number;
  changes: Partial<Pick<Booking, "stays" | "guestName" | "contact" | "notes" | "totalCents" | "roomNightPrices" | "bookedAt">>;
  channelPolicy?: "manual";
  acknowledgedClosedNights?: Night[];
  reason?: string;
};

export type RetainBookingPreviewInput = { reason: string; expiresOn?: string | null };
export type RetainBookingInput = RetainBookingPreviewInput & {
  expectedBookingVersion: number;
  expectedInventoryVersion: number;
};
export type RescheduleBookingPreviewInput = {
  stays: Stay[];
  totalCents: number;
  roomNightPrices?: NightPrice[];
  reason: string;
};
export type RescheduleBookingInput = RescheduleBookingPreviewInput & {
  expectedBookingVersion: number;
  expectedInventoryVersion: number;
};

export type LineBulkCancelInput = {
  expectedInventoryVersion: number;
  bookings: { bookingId: string; expectedBookingVersion: number }[];
  channelPolicy?: "manual";
};

export type PaymentEventInput = PaymentMetadata & {
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
  /** Optional for older writers; a missing value is unknown, never zero. */
  totalCents?: number | null;
  currency?: "TWD";
  /** Null/omitted identity is absent evidence; linked updates preserve known labels. */
  platform?: string | null;
  externalOrderNo?: string | null;
  /** Gmail's aligned DKIM/DMARC verdict, asserted by the bound Gmail writer. */
  sourceIdentityEvidence?: {
    kind: "gmail-owlnest-dkim-v1" | "gmail-owljourney-dkim-v1";
    signedDomain: "owlting.com";
    deliveredTo: "sweetfuntw@gmail.com";
  };
};

export type SourceOrderLookupInput = Pick<SourceEventInput,
  "propertyId" | "sourceSystem" | "sourceAccount" | "externalOrderId">;

/** Metadata-only repair for an already applied, still-current source email. */
export type SourceFactsInput = SourceOrderLookupInput & {
  sourceVersion: string;
  expectedInventoryVersion: number;
  expectedBookingVersion: number;
  totalCents: number;
  currency: "TWD";
  platform: string;
  externalOrderNo: string | null;
};

export type ReadbackInput = {
  propertyId: string;
  operationKey: string;
  providerVersion: string;
  observedAt: string;
  cells: ObservedCell[];
  /** Cells with an acknowledged PUT by this exact operation. */
  appliedClosedCells?: Night[];
};

export type BookingReceipt = {
  bookingId: string;
  bookingVersion: number;
  inventoryVersion: number;
  operationState: OperationState | "local_only" | "not_required" | "action_required" | "awaiting_manual_sync" | "manually_confirmed" | "not_applied";
  operationKey: string | null;
  refundReviewRequired: boolean;
  sourceReviewRequired?: boolean;
  status?: BookingStatus;
  lifecycleRevision?: number;
  retainedAmountCents?: number | null;
  retainedAmountReviewRequired?: boolean;
  externalRoomActionRequired?: boolean;
  externalRoomStatus?: "not_integrated" | ChannelSyncState;
  outcome?: "not_applied";
};

export type EventType =
  | "booking.created" | "booking.amended" | "booking.cancelled"
  | "booking.retained" | "booking.rescheduled" | "booking.retention_request_abandoned" | "source.lifecycle_review_required"
  | "channel.sync_requested" | "channel.preflight_open"
  | "channel.manually_confirmed"
  | "hold.created" | "hold.extended" | "hold.converted" | "hold.released"
  | "card.result_recorded"
  | "payment.recorded" | "source.applied" | "source.review_required"
  | "inventory.blocked" | "inventory.opened"
  | "source.facts_enriched"
  | "source.notification_recorded"
  | "reporting.policy_recorded"
  | "channel.requested" | "channel.verified" | "channel.review_required"
  | "channel.review_claim_released" | "channel.review_isolated" | "channel.source_operation_retired";

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
  reason?: string;
  manualRoomHandling?: { closedNights: Night[]; handledCells: DesiredCell[] };
  acknowledgedClosedNights?: Night[];
  retention?: { retentionId: string; lifecycleRevision: number;
    previousStays: Stay[]; currentStays: Stay[] };
};

export type TransactionContext = {
  emit(event: PendingEvent): void;
  audit(record: AuditRecord): void;
  /** Optional Postgres-only same-transaction finance mirror after property cutover. */
  financeNative?(intent: Record<string, unknown>): void;
};

export interface PropertyRepository {
  read(propertyId: string): Promise<PropertyState | null>;
  /** Must commit the whole draft or none of it under one serializable property lock/CAS. */
  transact<T>(propertyId: string, fn: (draft: PropertyState, tx: TransactionContext) => Promise<T> | T): Promise<T>;
  events(propertyId: string, after: number, limit: number): Promise<BookingEvent[]>;
}
