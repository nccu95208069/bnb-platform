export type CalendarView = "month" | "week" | "day";
export type PaymentStatus = "paid" | "deposit" | "unpaid" | "unknown";
export type ReservationStatus = "confirmed" | "cancelled";
export type PaymentMethod = "cash" | "bank_transfer" | "credit_card" | "ota" | "other";
export type PaymentType = "deposit" | "balance" | "other" | "full";
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
  /** Stable manual-contact status identity; preserves marks from the former Sheet calendar. */
  notification_order_id?: string;
  /** Existing OS payment ledger identity for an unchanged imported Iron Gate order. */
  payment_order_id?: string;
  source_booking_version?: number;
  source_legacy_payment?: boolean;
  external_order_no: string | null;
  owlnest_order_no?: string | null;
  property_id: string;
  property_name: string;
  room_id: string;
  room_number: string;
  guest_name: string;
  guest_name_sources?: string[];
  guest_remarks?: import("@/lib/guest-remarks").GuestRemark[];
  // Private main-Sheet text, attached only after matching the live source row.
  source_notes?: { room_number: string; check_in: string; check_out: string; text: string }[];
  source_notes_unconfirmed?: boolean;
  // Only a server-authorized projection may mark a supplied source name as real.
  guest_name_kind?: "real" | "anonymous" | "missing";
  platform: string;
  check_in: string;
  check_out: string;
  booked_at: string | null;
  room_rate: number;
  /** Verified whole-order amount in cents; may lack a trustworthy per-room split. */
  source_order_total_cents?: number;
  source_amount_reconciliation?: import("../../lib/source-amount-reconciliation").SourceAmountBreakdown;
  payment_status: PaymentStatus;
  /** Separate from a cash-backed paid badge; supplied only by the SSOT readback. */
  legacy_settlement_status?: "settled_before_cutover_cash_details_unknown" | "review_required";
  /** Verified server projection for payment review while room prices remain hidden. */
  payment_review_status?: "paid" | "deposit";
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
  channel_sync_state?: "not_required" | "action_required" | "pending" | "verified" | "review_required";
  channel_pending_nights?: number;
  iron_gate_booking_id?: string;
  iron_gate_booking_version?: number;
  iron_gate_edit_mode?: "full" | "guest_name" | "none";
  iron_gate_source?: "os" | "line" | "website" | "external";
  iron_gate_card_managed?: boolean;
  iron_gate_channel_sync?: "not_required" | "action_required" | "awaiting_manual_sync" | "pending" | "verified" | "review_required" | "manually_confirmed";
  iron_gate_manual_confirmation_available?: boolean;
  iron_gate_manual_handling?: boolean;
  iron_gate_manual_confirmed_at?: string;
  iron_gate_source_review?: boolean;
  snapshot_only?: boolean;
  payment_unconfirmed?: boolean;
  requirements_known?: boolean;
  source_conflict?: boolean;
  source_issue_acknowledged?: boolean;
  source_payment_label?: string;
  source_payment_flag?: "done" | "not_yet" | "unknown";
  source_guest_count?: number;
  source_order_linked?: boolean;
  source_identity_kind?: "parent_order" | "row";
  nightly_amounts?: { date: string; amount: number }[];
  source_segment_ids?: string[];
  // Calendar-only span; the underlying rows keep independent order/payment IDs.
  visual_source_ids?: string[];
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
  source?: { kind?: "iron_gate" | "google_sheet_snapshot"; private_snapshot_at?: string; private_snapshot_version?: string; label: string; observed_at: string; read_only: boolean; automatic_sync: boolean; availability_authoritative: boolean;
    sync?: { status: "waiting" | "healthy" | "confirming" | "error" | "stale"; last_successful_check_at?: string | null; last_checked_at: string | null; last_published_at: string | null; cutoff: string; interval_seconds: number; error_code: string | null } };
  source_summary?: { rows: number; accepted_rows: number; quarantined_rows: number; new_issue_rows?: number; historical_issue_rows?: number; blocked_room_nights: number; missing_order_id: number; missing_payment_status: number };
  sources?: { property_id: string; source: NonNullable<CalendarResponse["source"]>; summary: CalendarResponse["source_summary"] }[];
  request_id?: string;
  source_warnings?: { property_id: string; label: string; phase: "snapshot" | "guest_details" | "payments" | "private_snapshot"; captured_at?: string }[];
  source_errors?: { property_id: string; label: string }[];
  guest_access?: { available: boolean; authenticated: boolean };
  data_mode?: string;
  price_hidden?: boolean;
  iron_gate_manual_enabled?: boolean;
  iron_gate_manual_payment_enabled?: boolean;
  finance_ssot_enabled?: boolean;
  finance_ssot_properties?: string[];
};

export type CalendarPeriod = {
  start: string;
  end: string;
  label: string;
};
