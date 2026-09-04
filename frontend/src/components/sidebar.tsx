"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CalendarDays,
  FileText,
  ListTodo,
  MessageCircle,
  MessageSquare,
  Settings,
} from "lucide-react";

import { cn } from "@/lib/utils";

const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

const allNavItems = [
  {
    label: "訂單日曆",
    href: "/calendar",
    icon: CalendarDays,
  },
  {
    label: "對話管理",
    href: "/conversations",
    icon: MessageSquare,
  },
  {
    label: "文件管理",
    href: "/documents",
    icon: FileText,
  },
  {
    label: "對話測試",
    href: "/chat-test",
    icon: MessageCircle,
  },
  {
    label: "待辦事項",
    href: "/todos",
    icon: ListTodo,
  },
  {
    label: "設定",
    href: "/settings",
    icon: Settings,
  },
];

const navItems = DEMO_MODE ? allNavItems.slice(0, 1) : allNavItems;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col border-r bg-card">
      <div className="flex h-16 items-center gap-3 border-b px-4">
        <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-sm font-bold text-primary-foreground shadow-sm">
          SF
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">Sweetfun OS</h1>
          <p className="truncate text-[11px] text-muted-foreground">旅宿營運工作台</p>
        </div>
      </div>

      <div className="space-y-2 px-3 pt-3">
        <div className="rounded-xl border bg-muted/35 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Property
          </p>
          <p className="mt-1 truncate text-sm font-semibold">水芳 Sweetfun</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">瑞芳 · 6 間房</p>
        </div>

        {DEMO_MODE && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-amber-950">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em]">
              Demo Site
            </p>
            <p className="mt-1 text-xs font-medium">2026 年 9 月匿名化訂單</p>
          </div>
        )}
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {navItems.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
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
          <span
            className={cn(
              "size-2 rounded-full",
              DEMO_MODE ? "bg-amber-500" : "bg-emerald-500",
            )}
          />
          {DEMO_MODE ? "匿名化示範模式" : "系統連線正常"}
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground">BnB Platform v0.2</p>
      </div>
    </aside>
  );
}
