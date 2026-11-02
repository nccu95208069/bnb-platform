"use client";

import Link from "next/link";
import { CalendarAppearanceSettings } from "@/components/calendar/calendar-appearance-settings";
import { useT } from "@/components/i18n/language-provider";

export default function CalendarSettingsPage() {
  const t = useT();
  return (
    <main className="mx-auto max-w-5xl space-y-6 pb-16 pt-2 sm:pt-4">
      <Link href="/settings" className="inline-flex rounded-lg text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        ← {t("返回設定")}
      </Link>
      <CalendarAppearanceSettings />
    </main>
  );
}
