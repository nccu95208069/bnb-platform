"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import {
  LogOut,
  CalendarDays,
  ClipboardList,
  Check,
  ChevronLeft,
  ChevronRight,
  Menu,
  Search,
  ShieldCheck,
  Settings,
  X,
} from "lucide-react";

import { useCalendarPreferences } from "@/components/calendar/calendar-preferences";
import type {
  CalendarProperty,
  CalendarView,
} from "@/components/calendar/calendar-types";
import { VIEW_LABELS } from "@/components/calendar/calendar-utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useAccessControl, useActorPermissions } from "@/lib/access-control";
import { PAYMENT_SANDBOX } from "@/lib/payment-workflow";
import { cn } from "@/lib/utils";

const SHEET_SNAPSHOT = process.env.NEXT_PUBLIC_CALENDAR_SOURCE === "sheet_snapshot";
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

const PROPERTY_COLORS: Record<CalendarProperty["color"], string> = {
  emerald: "bg-emerald-500",
  violet: "bg-violet-500",
  amber: "bg-amber-500",
  sky: "bg-sky-500",
};

function CalendarViewFilters() {
  const view = useCalendarPreferences((state) => state.view);
  const setView = useCalendarPreferences((state) => state.setView);

  return (
    <section className="px-3 pt-4 md:hidden">
      <p className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        日曆檢視
      </p>
      <div className="mt-2 grid grid-cols-3 rounded-xl border bg-muted/35 p-1">
        {(Object.keys(VIEW_LABELS) as CalendarView[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setView(option)}
            className={cn(
              "rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors",
              view === option
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={view === option}
          >
            {VIEW_LABELS[option]}
          </button>
        ))}
      </div>
    </section>
  );
}

function PropertyFilters() {
  const properties = useCalendarPreferences((state) => state.properties);
  const selectedPropertyIds = useCalendarPreferences(
    (state) => state.selectedPropertyIds,
  );
  const toggleProperty = useCalendarPreferences(
    (state) => state.toggleProperty,
  );
  const selectAllProperties = useCalendarPreferences(
    (state) => state.selectAllProperties,
  );
  const allSelected =
    properties.length > 0 && selectedPropertyIds.length === properties.length;

  return (
    <section className="px-3 pt-4">
      <div className="flex items-center justify-between px-1">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          我的旅宿
        </p>
        {properties.length > 1 && !allSelected && (
          <button
            type="button"
            onClick={selectAllProperties}
            className="text-[11px] font-medium text-primary hover:underline"
          >
            全部顯示
          </button>
        )}
      </div>

      <div className="mt-2 space-y-1">
        {properties.length === 0 && (
          <div className="rounded-xl border border-dashed px-3 py-4 text-xs text-muted-foreground">
            正在載入旅宿資料
          </div>
        )}

        {properties.map((property) => {
          const selected = selectedPropertyIds.includes(property.id);
          return (
            <button
              key={property.id}
              type="button"
              onClick={() => toggleProperty(property.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                selected
                  ? "border-border bg-background shadow-xs"
                  : "border-transparent bg-muted/35 text-muted-foreground",
              )}
              aria-pressed={selected}
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-md border",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card",
                )}
              >
                {selected && <Check className="size-3.5" />}
              </span>
              <span
                className={cn(
                  "size-2.5 shrink-0 rounded-full",
                  PROPERTY_COLORS[property.color],
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-foreground">
                  {property.short_name}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {property.location} · {property.room_count}{" "}
                  {property.room_count === 1 ? "棟" : "間房"}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function SidebarAccount() {
  const membership = useAccessControl(state => state.membership);
  const initialized = useAccessControl(state => state.initialized);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function logout() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/calendar-session", { method: "DELETE", signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error();
      window.location.replace("/calendar-access");
    } catch { setBusy(false); setError("登出未完成，請再試一次。"); }
  }
  if (!initialized) return <p className="text-xs text-muted-foreground">正在確認帳號…</p>;
  if (!membership) return <Link href="/calendar-access" className="flex min-h-11 items-center justify-center rounded-lg border text-sm font-medium">登入帳號</Link>;
  return <div className="space-y-3">
    <div className="min-w-0"><p className="text-[11px] text-muted-foreground">目前登入帳號</p><p className="mt-1 truncate text-sm font-semibold">{membership.displayName}</p><p className="break-all text-xs text-muted-foreground">{membership.email}</p></div>
    <div className="grid grid-cols-2 gap-2">
      <Link href="/calendar-password" className="flex min-h-11 items-center justify-center rounded-lg border text-sm font-medium">變更密碼</Link>
      <button type="button" disabled={busy} onClick={logout} className="flex min-h-11 items-center justify-center gap-2 rounded-lg border text-sm font-medium disabled:opacity-50"><LogOut className="size-4" />{busy ? "登出中…" : "登出"}</button>
    </div>
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
  </div>;
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const actorPermissions = useActorPermissions();

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b px-4">
        <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm">
          SF
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">Sweetfun OS</h1>
          <p className="truncate text-[11px] text-muted-foreground">
            旅宿營運工作台
          </p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
      <CalendarViewFilters />
      <PropertyFilters />

      {DEMO_MODE && !PAYMENT_SANDBOX && (
        <div className="mx-3 mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-950">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em]">
            {SHEET_SNAPSHOT ? "訂單自動同步" : "Demo Site"}
          </p>
          <p className="mt-1 text-xs font-medium">
            {SHEET_SNAPSHOT ? "資料來自訂房表，目前可查看；修改訂單請到原訂房表操作。" : "匿名資料 · 編輯僅儲存在此瀏覽器"}
          </p>
        </div>
      )}

      <nav className="flex-1 space-y-1 p-3">
        <Link
          href="/calendar"
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
            pathname === "/calendar" || pathname.startsWith("/calendar/")
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
        >
          <CalendarDays className="size-4" />
          訂單日曆
        </Link>

        {PAYMENT_SANDBOX && (
          <Link
            href="/missions"
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium",
              pathname === "/missions"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            <ClipboardList className="size-4" />
            任務中心
          </Link>
        )}
        {actorPermissions.manageMembers && !PAYMENT_SANDBOX && (
          <Link
            href="/access"
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              pathname === "/access" || pathname.startsWith("/access/")
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <ShieldCheck className="size-4" />
            權限管理
          </Link>
        )}
        <Link href="/settings" onClick={onNavigate} className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
          pathname.startsWith("/settings") ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        )}>
          <Settings className="size-4" />設定
        </Link>
      </nav>

      </div>
      <div className="shrink-0 border-t p-4">
        {SHEET_SNAPSHOT ? <SidebarAccount /> : <p className="text-xs text-muted-foreground">{PAYMENT_SANDBOX ? "隔離測試 · 固定管理者身分" : DEMO_MODE ? "匿名化示範模式" : "Sweetfun OS"}</p>}
      </div>
    </div>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const isCalendar = pathname.startsWith("/calendar");
  const properties = useCalendarPreferences((state) => state.properties);
  const selectedPropertyIds = useCalendarPreferences(
    (state) => state.selectedPropertyIds,
  );
  const mobileMenuOpen = useCalendarPreferences(
    (state) => state.mobileMenuOpen,
  );
  const setMobileMenuOpen = useCalendarPreferences(
    (state) => state.setMobileMenuOpen,
  );
  const mobilePeriodLabel = useCalendarPreferences(
    (state) => state.mobilePeriodLabel,
  );
  const mobileSearchOpen = useCalendarPreferences(
    (state) => state.mobileSearchOpen,
  );
  const setMobileSearchOpen = useCalendarPreferences(
    (state) => state.setMobileSearchOpen,
  );
  const requestCalendarNavigation = useCalendarPreferences(
    (state) => state.requestCalendarNavigation,
  );

  const selectedNames = properties
    .filter((property) => selectedPropertyIds.includes(property.id))
    .map((property) => property.short_name);

  return (
    <>
      <aside className="hidden h-screen w-64 shrink-0 border-r bg-card md:block">
        <SidebarContent />
      </aside>

      <header className="fixed inset-x-0 top-0 z-50 grid h-14 grid-cols-[40px_minmax(0,1fr)_152px] items-center gap-1 border-b bg-background/95 px-2 backdrop-blur md:hidden">
        <Button
          variant="ghost"
          size="icon"
          className="size-9"
          onClick={() => setMobileMenuOpen(true)}
          aria-label="開啟日曆與旅宿選單"
        >
          <Menu className="size-5" />
        </Button>

        <button
          type="button"
          onClick={() => requestCalendarNavigation("today")}
          className="min-w-0 px-1 text-center"
          aria-label="回到今天"
        >
          <p className="truncate text-sm font-semibold">
            {isCalendar ? mobilePeriodLabel : pathname.startsWith("/settings") ? "設定" : pathname === "/access" ? "權限管理" : "任務中心"}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {selectedNames.length ? selectedNames.join("、") : "選擇旅宿"}
          </p>
        </button>

        <div className="flex items-center justify-end gap-0.5">
          {isCalendar ? (
            <>
              <Button variant="ghost" size="sm" className="px-1.5" onClick={() => requestCalendarNavigation("today")}>今天</Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-9"
                onClick={() => requestCalendarNavigation("previous")}
                aria-label="上一個日期區間"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-9"
                onClick={() => requestCalendarNavigation("next")}
                aria-label="下一個日期區間"
              >
                <ChevronRight className="size-4" />
              </Button>
              <Button
                variant={mobileSearchOpen ? "secondary" : "ghost"}
                size="icon"
                className="size-9"
                onClick={() => setMobileSearchOpen(true)}
                aria-label="搜尋訂單"
              >
                <Search className="size-4" />
              </Button>
            </>
          ) : (
            <Button asChild variant="ghost" size="sm">
              <Link href="/calendar">日曆</Link>
            </Button>
          )}
        </div>
      </header>

      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent
          side="left"
          className="w-[88vw] max-w-sm p-0 pb-[env(safe-area-inset-bottom)] [&>button]:hidden"
        >
          <SheetTitle className="sr-only">
            Sweetfun OS 日曆顯示與旅宿篩選
          </SheetTitle>
          <div className="absolute right-3 top-3 z-10">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileMenuOpen(false)}
              aria-label="關閉選單"
            >
              <X className="size-5" />
            </Button>
          </div>
          <SidebarContent onNavigate={() => setMobileMenuOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
