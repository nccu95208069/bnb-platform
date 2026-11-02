"use client";

import { useT } from "@/components/i18n/language-provider";
import type { CalendarBooking } from "./calendar-types";

export function BookingSourceNotes({ booking, orderSegments, viewPrices }: {
  booking: CalendarBooking;
  orderSegments: CalendarBooking[];
  viewPrices: boolean;
}) {
  const t = useT();
  if (!booking.source_read_only || !viewPrices || booking.price_hidden) return null;
  const segments = [booking, ...orderSegments].filter(segment =>
    segment.property_id === booking.property_id && segment.order_id === booking.order_id,
  );
  const grouped = new Map<string, Set<string>>();
  for (const segment of segments) {
    if (segment.price_hidden || segment.source_conflict) continue;
    for (const note of segment.source_notes ?? []) {
      if (!note.text.trim()) continue;
      const sources = grouped.get(note.text) ?? new Set<string>();
      sources.add(`${note.room_number} · ${note.check_in}–${note.check_out}`);
      grouped.set(note.text, sources);
    }
  }
  const unconfirmed = segments.some(segment => segment.source_conflict || segment.source_notes_unconfirmed || segment.source_notes === undefined);
  return (
    <section className="rounded-xl border p-4" aria-label={t("主表備註")}>
      <h3 className="text-sm font-semibold">{t("主表備註")}</h3>
      <div className="mt-3 space-y-3">
        {[...grouped].map(([text, sources]) => (
          <div key={text}>
            <p className="text-xs text-muted-foreground">{[...sources].sort().join("、")}</p>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{text}</p>
          </div>
        ))}
        {unconfirmed && <p className="text-sm text-amber-800">{t("部分備註待主表同步確認，請稍後重新整理。")}</p>}
        {!grouped.size && !unconfirmed && <p className="text-sm text-muted-foreground">{t("主表未填寫備註")}</p>}
      </div>
    </section>
  );
}
