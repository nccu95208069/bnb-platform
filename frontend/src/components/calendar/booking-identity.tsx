import { parseGuestRemarks } from "@/lib/guest-remarks";
import type { CalendarBooking } from "./calendar-types";
import { PLATFORM_LABELS } from "./calendar-utils";

export function realGuestName(booking: CalendarBooking): string {
  return booking.guest_name_kind === "real" ? booking.guest_name.trim() : "";
}

export function bookingIdentityText(booking: CalendarBooking): string {
  return [booking.source_conflict ? "待核對" : PLATFORM_LABELS[booking.platform] ?? "其他", realGuestName(booking), booking.room_number].filter(Boolean).join(" · ");
}

// Use the same ordering in week/day cards; aliases must never stand in for names.
export function BookingIdentity({ booking }: { booking: CalendarBooking }) {
  const guestName = realGuestName(booking);
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate">
      <span className="font-semibold">{booking.source_conflict ? "待核對" : PLATFORM_LABELS[booking.platform] ?? "其他"}</span>
      {guestName && <span className="ml-1.5 font-medium">{guestName}</span>}
      <span className="ml-1.5 opacity-80">{booking.room_number}</span>
      </span>
      <GuestRemarks booking={booking} />
    </span>
  );
}

export function remarksFor(booking: CalendarBooking) {
  return (booking.guest_name_kind === "real" || booking.guest_name_sources?.length) ? booking.guest_remarks ?? parseGuestRemarks(booking.guest_name) : [];
}
export function GuestRemarks({booking, compact = false, limit = 1}: {booking:CalendarBooking;compact?:boolean;limit?:number}) {
 const remarks=remarksFor(booking);
 if(!remarks.length)return null;
 const visible=compact?remarks.slice(0,limit):remarks;
 return <span aria-label={`重點備註：${remarks.map(r=>r.label).join('、')}`} className={compact?'mt-0.5 flex min-w-0 items-center gap-0.5 text-[9px] leading-[12px]':'mt-1 flex flex-wrap gap-1 text-xs leading-5'}>
  {visible.map(r=><span key={r.kind+r.label} className="rounded-sm border border-current/40 px-0.5 font-semibold">{compact ? (({ig_contact:"IG聯繫",influencer:"IG邀請",baby_bath:"澡盆",bath_chair:"浴室椅"} as Record<string,string>)[r.kind] ?? r.label) : r.label}</span>)}
  {compact&&remarks.length>limit&&<span className="shrink-0 text-[9px]">+{remarks.length-limit}</span>}
 </span>;
}
