"use client";

import Link from "next/link";
import { ArrowUpRight, CalendarDays, CreditCard, Mail, PlugZap, ShieldCheck } from "lucide-react";
import { AppearancePreferences } from "@/components/settings/appearance-preferences";
import { LanguageSettings } from "@/components/i18n/language-settings";
import { useT } from "@/components/i18n/language-provider";
import { useAccessControl } from "@/lib/access-control";
import { maySeeFinance } from "@/lib/workspace-navigation";

function SettingsLink({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string;
  icon: typeof CalendarDays;
  title: string;
  description: string;
}) {
  const t = useT();
  return (
    <Link
      href={href}
      className="group flex min-h-20 items-start gap-3 rounded-xl border border-border bg-background p-4 transition-colors hover:border-primary/35 hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-foreground">{t(title)}</span>
        <span className="mt-1 block text-sm leading-5 text-muted-foreground">{t(description)}</span>
      </span>
      <ArrowUpRight className="mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" aria-hidden="true" />
    </Link>
  );
}

export default function SettingsPage() {
  const t = useT();
  const member = useAccessControl((state) => state.membership);
  const canManage = member?.role === "owner" || member?.role === "admin" || member?.role === "god";
  const canSeeFinance = maySeeFinance(member?.role);
  const hasLegacyIntegrations = process.env.NEXT_PUBLIC_CALENDAR_SOURCE !== "sheet_snapshot";

  return (
    <main className="mx-auto max-w-5xl space-y-7 pb-16 pt-2 sm:space-y-8 sm:pt-4">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Sweetfun OS</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">{t("設定")}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          {t("調整個人畫面與常用操作。帳號、營運和進階串接各有自己的位置。")}
        </p>
      </header>

      <section aria-labelledby="appearance-heading" className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="border-b border-border px-5 py-5 sm:px-6">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">01 / Display</p>
          <h2 id="appearance-heading" className="mt-1 text-xl font-semibold">{t("外觀與閱讀")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("明暗與字體調整立即生效，並保存在這台裝置。")}</p>
        </div>
        <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(260px,0.9fr)]">
          <AppearancePreferences />
          <div className="space-y-5 rounded-xl bg-muted/35 p-4 sm:p-5">
            <LanguageSettings compact />
            <div className="border-t border-border pt-4">
              <SettingsLink href="/settings/calendar" icon={CalendarDays} title="日曆配色" description="調整平台與訂單在月、週、日曆上的顏色。" />
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="account-heading" className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">02 / Account</p>
          <h2 id="account-heading" className="mt-1 text-xl font-semibold">{t("帳號與安全")}</h2>
          <p className="mb-5 mt-1 text-sm text-muted-foreground">{t("密碼、登入裝置與成員權限。")}</p>
          <div className="space-y-3">
            <SettingsLink href="/settings/security" icon={ShieldCheck} title="帳號安全" description="查看登入裝置，管理密碼與存取權。" />
            {canManage && <SettingsLink href="/settings/access" icon={ShieldCheck} title="成員與權限" description="邀請成員並設定可存取的旅宿。" />}
          </div>
        </section>

        <section aria-labelledby="operations-heading" className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">03 / Operations</p>
          <h2 id="operations-heading" className="mt-1 text-xl font-semibold">{t("營運設定")}</h2>
          <p className="mb-5 mt-1 text-sm text-muted-foreground">{t("與訂房和收款相關的設定集中管理。")}</p>
          <div className="space-y-3">
            {canSeeFinance && <SettingsLink href="/settings/payment-accounts" icon={CreditCard} title="付款帳戶" description="管理旅客匯款時看到的帳戶資訊。" />}
            {canManage && <SettingsLink href="/settings/email" icon={Mail} title="Gmail 寄信" description="查看邀請與通知寄件狀態。" />}
            {!canSeeFinance && <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("目前帳號沒有營運設定權限。")}</p>}
          </div>
        </section>
      </div>

      {hasLegacyIntegrations && (
        <details className="group rounded-2xl border border-border bg-card shadow-sm">
          <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:px-6 [&::-webkit-details-marker]:hidden">
            <PlugZap className="size-5 text-muted-foreground" aria-hidden="true" />
            <span className="flex-1">
              <span className="block font-semibold">{t("進階與串接")}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{t("較少使用的模型、LINE 與 Google 串接設定。")}</span>
            </span>
            <span className="text-sm text-muted-foreground group-open:hidden">{t("展開")}</span>
            <span className="hidden text-sm text-muted-foreground group-open:inline">{t("收起")}</span>
          </summary>
          <div className="border-t border-border p-4 sm:p-5">
            <SettingsLink href="/settings/advanced" icon={PlugZap} title="管理進階串接" description="集中查看憑證、渠道開關和系統提示詞。" />
          </div>
        </details>
      )}
    </main>
  );
}
