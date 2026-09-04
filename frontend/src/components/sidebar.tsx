"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, CalendarDays, Check, Menu, X } from "lucide-react";
import { useState } from "react";

import { useCalendarPreferences } from "@/components/calendar/calendar-preferences";
import type { CalendarProperty } from "@/components/calendar/calendar-types";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

const PROPERTY_COLORS: Record<CalendarProperty["color"], string> = {
  emerald: "bg-emerald-500",
  violet: "bg-violet-500",
  amber: "bg-amber-500",
  sky: "bg-sky-500",
};

function PropertyFilters() {
  const properties = useCalendarPreferences((state) => state.properties);
  const selectedPropertyIds = useCalendarPreferences((state) => state.selectedPropertyIds);
  const toggleProperty = useCalendarPreferences((state) => state.toggleProperty);
  const selectAllProperties = useCalendarPreferences((state) => state.selectAllProperties);
  const allSelected = properties.length > 0 && selectedPropertyIds.length === properties.length;

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
                  selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card",
                )}
              >
                {selected && <Check className="size-3.5" />}
              </span>
              <span className={cn("size-2.5 shrink-0 rounded-full", PROPERTY_COLORS[property.color])} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-foreground">{property.short_name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {property.location} · {property.room_count} {property.room_count === 1 ? "棟" : "間房"}
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

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex h-16 items-center gap-3 border-b px-4">
        <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm">
          SF
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">Sweetfun OS</h1>
          <p className="truncate text-[11px] text-muted-foreground">旅宿營運工作台</p>
        </div>
      </div>

      <PropertyFilters />

      {DEMO_MODE && (
        <div className="mx-3 mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-950">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em]">Demo Site</p>
          <p className="mt-1 text-xs font-medium">匿名資料 · 編輯僅儲存在此瀏覽器</p>
        </div>
      )}

      <nav className="flex-1 p-3">
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
      </nav>

      <div className="border-t p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn("size-2 rounded-full", DEMO_MODE ? "bg-amber-500" : "bg-emerald-500")} />
          {DEMO_MODE ? "匿名化示範模式" : "系統連線正常"}
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">BnB Platform v0.3</p>
      </div>
    </div>
  );
}

export function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const properties = useCalendarPreferences((state) => state.properties);
  const selectedPropertyIds = useCalendarPreferences((state) => state.selectedPropertyIds);
  const selectedNames = properties
    .filter((property) => selectedPropertyIds.includes(property.id))
    .map((property) => property.short_name);

  return (
    <>
      <aside className="hidden h-screen w-64 shrink-0 border-r bg-card md:block">
        <SidebarContent />
      </aside>

      <header className="fixed inset-x-0 top-0 z-40 flex h-14 items-center justify-between border-b bg-background/95 px-3 backdrop-blur md:hidden">
        <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} aria-label="開啟選單">
          <Menu className="size-5" />
        </Button>
        <div className="min-w-0 text-center">
          <p className="truncate text-sm font-semibold">Sweetfun OS</p>
          <p className="max-w-[220px] truncate text-[10px] text-muted-foreground">
            {selectedNames.length ? selectedNames.join("、") : "旅宿日曆"}
          </p>
        </div>
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-[11px] font-bold text-primary-foreground">
          SF
        </span>
      </header>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-[88vw] max-w-sm p-0 [&>button]:hidden">
          <SheetTitle className="sr-only">Sweetfun OS 導覽與旅宿篩選</SheetTitle>
          <div className="absolute right-3 top-3 z-10">
            <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)} aria-label="關閉選單">
              <X className="size-5" />
            </Button>
          </div>
          <SidebarContent onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>
    </>
  );
}
