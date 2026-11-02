"use client";

import Link from "next/link";
import { LegacySettingsPage } from "@/components/settings/legacy-settings";
import { useT } from "@/components/i18n/language-provider";

export default function AdvancedSettingsPage() {
  const t = useT();
  if (process.env.NEXT_PUBLIC_CALENDAR_SOURCE === "sheet_snapshot") {
    return <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">{t("進階串接")}</h1>
      <p className="text-sm text-muted-foreground">{t("此工作台的串接由管理者統一設定。")}</p>
      <Link href="/settings" className="text-sm underline">{t("返回設定")}</Link>
    </main>;
  }
  return (
    <main className="mx-auto max-w-5xl space-y-6 pb-16 pt-2 sm:pt-4">
      <Link href="/settings" className="inline-flex rounded-lg text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        ← {t("返回設定")}
      </Link>
      <LegacySettingsPage />
    </main>
  );
}
