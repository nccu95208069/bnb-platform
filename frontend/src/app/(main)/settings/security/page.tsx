"use client";

import Link from "next/link";
import { KeyRound, Users } from "lucide-react";
import { LoginDevices } from "@/components/account/login-devices";
import { useT } from "@/components/i18n/language-provider";
import { useAccessControl } from "@/lib/access-control";

export default function SecuritySettingsPage() {
  const t = useT();
  const role = useAccessControl((state) => state.membership?.role);
  const canManage = role === "owner" || role === "admin" || role === "god";

  return (
    <main className="mx-auto max-w-3xl space-y-6 pb-16 pt-2 sm:pt-4">
      <Link href="/settings" className="inline-flex rounded-lg text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
        ← {t("返回設定")}
      </Link>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t("帳號與安全")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("在這裡管理登入方式和可使用這個工作台的成員。")}</p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2">
        <Link href="/calendar-password" className="rounded-xl border bg-card p-4 transition-colors hover:bg-accent/50">
          <KeyRound className="mb-3 size-5" aria-hidden="true" />
          <span className="block font-semibold">{t("變更密碼")}</span>
          <span className="mt-1 block text-sm text-muted-foreground">{t("更新自己的登入密碼。")}</span>
        </Link>
        {canManage && (
          <Link href="/settings/access" className="rounded-xl border bg-card p-4 transition-colors hover:bg-accent/50">
            <Users className="mb-3 size-5" aria-hidden="true" />
            <span className="block font-semibold">{t("成員與權限")}</span>
            <span className="mt-1 block text-sm text-muted-foreground">{t("邀請成員並核對旅宿存取範圍。")}</span>
          </Link>
        )}
      </div>
      <LoginDevices />
    </main>
  );
}
