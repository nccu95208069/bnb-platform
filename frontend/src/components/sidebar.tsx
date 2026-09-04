"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarDays,
  ClipboardList,
  ListChecks,
  MessageSquare,
  WalletCards,
} from "lucide-react";

import { cn } from "@/lib/utils";

const navItems = [
  {
    label: "訂單日曆",
    href: "/calendar",
    icon: CalendarDays,
    enabled: true,
  },
  {
    label: "訂單管理",
    icon: ClipboardList,
    enabled: false,
  },
  {
    label: "收款與財務",
    icon: WalletCards,
    enabled: false,
  },
  {
    label: "Agent 任務",
    icon: ListChecks,
    enabled: false,
  },
  {
    label: "房客訊息",
    icon: MessageSquare,
    enabled: false,
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r bg-card">
      <div className="flex h-16 items-center gap-3 border-b px-4">
        <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm">
          SF
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold">Sweetfun OS</h1>
            <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
              Preview
            </span>
          </div>
          <p className="truncate text-[11px] text-muted-foreground">旅宿營運工作台</p>
        </div>
      </div>

      <div className="px-3 pt-3">
        <div className="rounded-xl border bg-muted/35 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Property
          </p>
          <p className="mt-1 truncate text-sm font-semibold">水芳 Sweetfun</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">瑞芳 · 6 間房</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {navItems.map((item) => {
          const isActive =
            item.enabled &&
            item.href &&
            (pathname === item.href || pathname.startsWith(item.href + "/"));

          if (!item.enabled) {
            return (
              <div
                key={item.label}
                className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground/55"
              >
                <item.icon className="size-4" />
                <span className="flex-1">{item.label}</span>
                <span className="text-[9px] font-semibold uppercase tracking-wide">Soon</span>
              </div>
            );
          }

          return (
            <Link
              key={item.href}
              href={item.href ?? "/calendar"}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-2 rounded-full bg-emerald-500" />
          2026 年 9 月資料已載入
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">去識別化 SaaS 預覽環境</p>
      </div>
    </aside>
  );
}
