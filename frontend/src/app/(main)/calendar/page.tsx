import { BookingCalendarResponsive } from "@/components/calendar/booking-calendar-responsive";

export default function CalendarPage() {
  const snapshotPreviewConfigured = process.env.CALENDAR_SOURCE === "sheet_snapshot" &&
    process.env.IRON_GATE_SWEETFUN_CALENDAR_PREVIEW_ENABLED === "true";
  return <BookingCalendarResponsive snapshotPreviewConfigured={snapshotPreviewConfigured} />;
}
