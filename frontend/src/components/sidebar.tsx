"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Menu,
  Search,
  ShieldCheck,
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
import { useActorPermissions } from "@/lib/access-control";
import { cn } from "@/lib/utils";

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
  const toggleProperty = useCalendarPreferences((state) => state.toggleProperty);
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

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const actorPermissions = useActorPermissions();

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex h-16 items-center gap-3 border-b px-4">
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

      <CalendarViewFilters />
      <PropertyFilters />

      {DEMO_MODE && (
        <div className="mx-3 mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-950">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em]">
            Demo Site
          </p>
          <p className="mt-1 text-xs font-medium">
            匿名資料 · 編輯僅儲存在此瀏覽器
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

        {actorPermissions.manageMembers && (
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
      </nav>

      <div className="border-t p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            className={cn(
              "size-2 rounded-full",
              DEMO_MODE ? "bg-amber-500" : "bg-emerald-500",
            )}
          />
          {DEMO_MODE ? "匿名化示範模式" : "系統連線正常"}
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">
          BnB Platform v0.4
        </p>
      </div>
    </div>
  );
}

export function Sidebar() {
  const properties = useCalendarPreferences((state) => state.properties);
  const selectedPropertyIds = useCalendarPreferences(
    (state) => state.selectedPropertyIds,
  );
  const mobileMenuOpen = useCalendarPreferences((state) => state.mobileMenuOpen);
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

      <header className="fixed inset-x-0 top-0 z-50 grid h-14 grid-cols-[40px_minmax(0,1fr)_120px] items-center gap-1 border-b bg-background/95 px-2 backdrop-blur md:hidden">
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
          <p className="truncate text-sm font-semibold">{mobilePeriodLabel}</p>
          <p className="truncate text-[10px] text-muted-foreground">
            {selectedNames.length ? selectedNames.join("、") : "選擇旅宿"}
          </p>
        </button>

        <div className="flex items-center justify-end gap-0.5">
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
