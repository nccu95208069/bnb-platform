/** Public OS contract. Monetary values are integer cents; null always means unknown. */
export type RetainedStay = { checkIn: string; checkOut: string; roomNumbers: string[] };
export type RetainedNightPrice = { roomNumber: string; date: string; amountCents: number };
export type RetentionHistory = {
  id: string; retainedAt: string; reason: string; expiresOn: string | null;
  previousStays: RetainedStay[]; previousTotalCents: number | null;
  previousRoomNightPrices?: RetainedNightPrice[];
  rescheduledAt?: string; rescheduledBookingVersion?: number;
};
export type RetainedBookingDetail = {
  bookingId: string; version: number; status: 'confirmed' | 'retained' | 'cancelled';
  guestName: string; contact: string | null; externalOrderNo: string | null;
  sourceOrderRef: string | null; totalCents: number | null;
  sourceOrderAliases?: string[];
  originalTotalCents: number | null; stays: RetainedStay[]; originalStays: RetainedStay[];
  roomNightPrices?: RetainedNightPrice[];
  retention: { schema: 1; lifecycleRevision: number; activeRetentionId: string | null;
    history: RetentionHistory[] } | null;
  retainedAt: string | null; reason: string | null;
  netReceivedCents: number | null; retainedAmountReviewRequired: boolean;
  channelSyncState: string; externalRoomStatus?: string; externalRoomActionRequired: boolean;
  sourceReviewRequired: boolean; retentionEligible: boolean; rescheduleEligible: boolean;
  priceHidden: boolean;
};
export type RetainedBookingsResponse = {
  bookings: RetainedBookingDetail[]; canWrite: boolean; priceHidden: boolean;
  verifiedAt: string; inventoryVersion: number;
};
export type RetainedBookingPreview = {
  bookingId: string; bookingVersion: number; inventoryVersion: number; authorityEpoch: number;
  status: string; previousStays: RetainedStay[]; proposedStays: RetainedStay[];
  channelSyncState: string; externalRoomStatus?: string; externalRoomActionRequired: boolean;
  netReceivedCents: number | null; retainedAmountReviewRequired: boolean;
  remainingCents: number | null; creditCents: number | null;
};
export type RetainedBookingRequestResult = {
  outcome: 'applied' | 'not_applied'; requestKey: string; bookingId: string; bookingVersion: number;
  currentBookingVersion: number; currentStatus: string; channelSyncState: string; externalRoomStatus?: string;
  inventoryVersion: number; readbackVerified: true;
};
