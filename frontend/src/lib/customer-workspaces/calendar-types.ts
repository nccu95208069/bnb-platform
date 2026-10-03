import type { StaySegment } from "./types.ts";

export const CALENDAR_KINDS = [
  "google_calendar",
  "ios_calendar",
  "android_calendar",
] as const;
export type CalendarKind = (typeof CALENDAR_KINDS)[number];
export function isCalendarKind(value: unknown): value is CalendarKind {
  return (
    typeof value === "string" &&
    (CALENDAR_KINDS as readonly string[]).includes(value)
  );
}
export const CALENDAR_LABELS: Record<CalendarKind, string> = {
  google_calendar: "Google Calendar",
  ios_calendar: "iOS 日曆（iPhone／iPad）",
  android_calendar: "Android 日曆",
};
export type CalendarEvent = {
  key: string;
  calendarId: string;
  uid: string;
  eventId?: string;
  recurrenceId?: string;
  title: string;
  description: string;
  start: string;
  end: string;
  allDay: boolean;
  cancelled: boolean;
  color?: string;
  issue?: string;
  version: string;
};
export type CalendarSnapshot = {
  id: string;
  workspaceId: string;
  propertyId: string;
  actor: string;
  kind: CalendarKind;
  transport: "file" | "google";
  from: string;
  to: string;
  timezone: string;
  calendars: { id: string; name: string; count: number }[];
  events: CalendarEvent[];
  contentHash: string;
  createdAt: string;
  expiresAt: number;
  connectionId?: string;
};
export type CalendarEventOverride = {
  disposition?: "booking" | "block" | "ignore";
  reason?: string;
  roomIds?: string[];
  checkIn?: string;
  checkOut?: string;
  group?: string;
  guestName?: string;
  total?: number | null;
  paid?: number | null;
};
export type CalendarMapping = {
  calendarIds: string[];
  rooms: Record<string, string[]>;
  dateMode: "stay" | "arrival";
  titleRooms: boolean;
  extractLabels: boolean;
  overrides: Record<string, CalendarEventOverride>;
};
export type CalendarDraft = {
  kind: "booking" | "block";
  guestName: string | null;
  reason: string | null;
  externalId: string | null;
  checkIn: string;
  checkOut: string;
  roomIds: string[];
  stays: StaySegment[];
  total: number | null;
  paid: number | null;
};
export type CalendarPreviewRow = {
  id: string;
  eventKeys: string[];
  titles: string[];
  draft: CalendarDraft | null;
  issues: string[];
  disposition:
    "ready" | "ignored" | "existing" | "changed" | "cancelled" | "issue";
  fingerprint: string;
  existingId?: string;
};
export type CalendarReference = {
  bindingId: string;
  batchId: string;
  eventKeys: string[];
  references: {
    calendarId: string;
    uid: string;
    eventId?: string;
    recurrenceId?: string;
  }[];
  fingerprint: string;
  externalId: string | null;
  sourceVersion: string;
  financialEvidence?: { total: number | null; paid: number | null };
};
export type CalendarBinding = {
  id: string;
  propertyId: string;
  actor: string;
  kind: CalendarKind;
  transport: "file" | "google";
  name: string;
  calendarIds: string[];
  from: string;
  to: string;
  timezone: string;
  mapping: CalendarMapping;
  connectionId?: string;
  mode: "migration" | "connected";
  lastSuccessfulAt: string;
  coverageConfirmed: boolean;
  pendingCount: number;
  issueCount: number;
  pendingPreviewId?: string;
  error?: string;
};
export type InventoryBlock = {
  id: string;
  version: number;
  propertyId: string;
  checkIn: string;
  checkOut: string;
  roomIds: string[];
  stays: StaySegment[];
  reason: string;
  status: "active" | "released";
  createdAt: string;
  calendar: CalendarReference;
};
export type CalendarBatch = {
  id: string;
  actor: string;
  propertyId: string;
  bindingId: string;
  createdAt: string;
  requestHash: string;
  bookingIds: string[];
  blockIds: string[];
  unresolvedCount: number;
  undo?: { removed: string[]; skipped: string[] };
};
export type CalendarPreview = {
  id: string;
  snapshotId: string;
  bindingId: string;
  workspaceId: string;
  propertyId: string;
  actor: string;
  version: number;
  createdAt: string;
  expiresAt: number;
  mapping: CalendarMapping;
  rows: CalendarPreviewRow[];
};
