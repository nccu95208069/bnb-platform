export type CalendarView = "month" | "week" | "day";
export type PaymentStatus = "paid" | "deposit" | "unpaid" | "unknown";
export type ReservationStatus = "confirmed" | "cancelled";
export type PaymentMethod = "cash" | "bank_transfer" | "credit_card";
export type PaymentType = "deposit" | "balance" | "other";
export type BabySupplyKey =
  | "baby_bath"
  | "sterilizer"
  | "baby_bed"
  | "bed_rail"
  | "bottle_warmer"
  | "other";

export type CalendarProperty = {
  id: string;
  name: string;
  short_name: string;
  location: string;
  room_count: number;
  color: "emerald" | "violet" | "amber" | "sky";
};

export type CalendarRoom = {
  id: string;
  property_id: string;
  room_number: string;
  label: string;
};

export type PaymentRecord = {
  id: string;
  amount: number;
  payment_type: PaymentType;
  payment_method: PaymentMethod;
  received_at: string;
  created_at: string;
};

export type BookingAuditEvent = {
  id: string;
  action: "record_payment" | "update_booking" | "cancel_booking";
  summary: string;
  occurred_at: string;
};

export type CalendarBooking = {
  id: string;
  sheet_row_id: string;
  order_id: string;
  external_order_no: string | null;
  property_id: string;
  property_name: string;
  room_id: string;
  room_number: string;
  guest_name: string;
  guest_name_sources?: string[];
  guest_remarks?: import("@/lib/guest-remarks").GuestRemark[];
  // Only a server-authorized projection may mark a supplied source name as real.
  guest_name_kind?: "real" | "anonymous" | "missing";
  platform: string;
  check_in: string;
  check_out: string;
  booked_at: string | null;
  room_rate: number;
  payment_status: PaymentStatus;
  reservation_status: ReservationStatus;
  notes: string | null;
  payments: PaymentRecord[];
  audit_log: BookingAuditEvent[];
  extra_guest_count: number;
  extra_bed_count: number;
  pet_count: number;
  baby_supplies: BabySupplyKey[];
  service_note: string | null;
  source_read_only?: boolean;
  requirements_known?: boolean;
  source_conflict?: boolean;
  source_issue_acknowledged?: boolean;
  source_payment_label?: string;
  source_guest_count?: number;
  source_order_linked?: boolean;
  source_identity_kind?: "parent_order" | "row";
  nightly_amounts?: { date: string; amount: number }[];
  source_segment_ids?: string[];
  stay_nights?: number;
  price_hidden?: boolean;
};

export type CalendarResponse = {
  year: number;
  month: number;
  month_start: string;
  month_end: string;
  period_start: string;
  period_end: string;
  properties: CalendarProperty[];
  rooms: CalendarRoom[];
  order_count: number;
  booking_segment_count: number;
  total_amount: number;
  bookings: CalendarBooking[];
  source?: { label: string; observed_at: string; read_only: boolean; automatic_sync: boolean; availability_authoritative: boolean;
    sync?: { status: "waiting" | "healthy" | "confirming" | "error" | "stale"; last_checked_at: string | null; last_published_at: string | null; cutoff: string; interval_seconds: number; error_code: string | null } };
  source_summary?: { rows: number; accepted_rows: number; quarantined_rows: number; new_issue_rows?: number; historical_issue_rows?: number; blocked_room_nights: number; missing_order_id: number; missing_payment_status: number };
  sources?: { property_id: string; source: NonNullable<CalendarResponse["source"]>; summary: CalendarResponse["source_summary"] }[];
  source_errors?: { property_id: string; label: string }[];
  guest_access?: { available: boolean; authenticated: boolean };
  data_mode?: string;
  price_hidden?: boolean;
};

export type CalendarPeriod = {
  start: string;
  end: string;
  label: string;
};
