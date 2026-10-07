import type { Booking } from "../customer-workspaces/types.ts";

export type WebsiteConfig = {
  schema: 1; kind: "new"; sellingMode: "rooms" | "whole_house" | "mixed";
  currency: "TWD"; timezone: "Asia/Taipei"; holdHours: 24;
  opensOn: string; closesOn: string; transferInstructions: string;
  cancellationPolicy: string; availabilityConfirmed: true;
  wholeHouseNightly: string | number;
  rooms: { roomTypeId: string; enabled: boolean; units: string | number;
    capacity: string | number; nightly: string | number }[];
};
export type RoomRecord = { id: string; name: string };
export type WebsiteClient = { id: string; token_sha256: string; site_ids: string[]; editor_origin: string };
export type WebsiteConnection = {
  id: string; clientId: string; siteId: string; siteName: string; ownerEmail: string;
  hash: string; configurationHash: string; config: WebsiteConfig; roomRecords: RoomRecord[];
  createdAt: string; expiresAt: string; state: "awaiting_owner" | "connected";
  bindingRevision: number;
  bindingId?: string; approvedBy?: string; approvalKey?: string; approvalHash?: string;
};
export type RoomOffer = { id: string; name: string; roomIds: string[]; capacity: number; wholeHouse: boolean };
export type WebsiteBinding = {
  id: string; clientId: string; siteId: string; siteName: string;
  ownerAccountId: string; ownerEmail: string; workspaceId: string; slug: string; propertyId: string;
  configurationHash: string; config: WebsiteConfig; roomRecords: RoomRecord[]; offers: RoomOffer[];
  physicalMappings: { roomTypeId: string; roomIds: string[] }[];
  inventoryMode: "platform_only"; enabled: boolean; credentialGeneration: string;
  connectionId: string; revision: number; approvedAt: string;
  ownerLine?: { recipientId: string; verifiedAt: string; verifiedBy: string; pairingId?: string };
};
export type Stay = { checkIn: string; checkOut: string; roomTypeId: string; quantity: number; adults: number; children: number };
export type WebsiteObservation = { id: string; bindingId: string; configurationHash: string; stay: Stay; expiresAt: string };
export type WebsiteQuote = WebsiteObservation & {
  roomIds: string[]; pricingHash: string; currency: "TWD"; totalCents: number;
  nightly: { date: string; unitPriceCents: number; quantity: number }[];
  usedBy?: string;
};
export type WebsiteReceipt = { bindingId: string; workspaceId: string; orderId: string; reference: string; requestHash: string; createdAt: string };
export type NotificationChannel = "guestEmail" | "ownerEmail" | "ownerLine";
export type WebsiteNotification = {
  id: string; bindingId: string; workspaceId: string; bookingId: string; bookingVersion: number;
  channel: NotificationChannel; event: "hold_created" | "hold_expired" | "hold_extended" | "hold_converted" | "hold_released";
  state: "queued" | "sending" | "sent" | "failed" | "unknown";
  createdAt: string; attemptId?: string; claimedAt?: string; workerId?: string;
  providerId?: string; completedAt?: string; lastError?: string;
};
export type WebsiteBookingData = {
  bindingId: string; quoteId: string; requestId: string; reference: string;
  email: string; phone: string; adults: number; children: number;
  notificationIds: Partial<Record<NotificationChannel, string>>;
  expiryNotifiedFingerprint?: string;
};
export type WebsiteBooking = Booking & { website: WebsiteBookingData };
