"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, RotateCcw, Sun } from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useT } from "@/components/i18n/language-provider";
import { useCalendarPreferences } from "@/components/calendar/calendar-preferences";
import { MAX_MONTH_WEEK_SPACING } from "@/components/calendar/month-layout";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "sweetfun-font-scale";
const MIN_SCALE = 85;
const MAX_SCALE = 130;
const STEP = 5;

function validScale(value: number) {
  return Number.isInteger(value) &&
    value >= MIN_SCALE &&
    value <= MAX_SCALE &&
    value % STEP === 0;
}

function applyScale(value: number) {
  document.documentElement.style.setProperty("--sweetfun-root-size", `${(16 * value) / 100}px`);
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // The live preference still works when browser storage is unavailable.
  }
}

const MODES = [
  { id: "light", label: "明亮", Icon: Sun },
  { id: "dark", label: "黑暗", Icon: Moon },
  { id: "system", label: "跟隨系統", Icon: Monitor },
] as const;

export function AppearancePreferences() {
  const t = useT();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [fontScale, setFontScale] = useState(100);
  const monthWeekSpacing = useCalendarPreferences((state) => state.monthWeekSpacing);
  const setMonthWeekSpacing = useCalendarPreferences((state) => state.setMonthWeekSpacing);
  const weekSpacingLabel = monthWeekSpacing === 0
    ? t("自動")
    : monthWeekSpacing === MAX_MONTH_WEEK_SPACING
      ? t("全部顯示")
      : t("增加 {0} 列", [monthWeekSpacing]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setMounted(true);
      try {
        const saved = Number(localStorage.getItem(STORAGE_KEY));
        if (validScale(saved)) setFontScale(saved);
      } catch {
        // Use the default when browser storage is unavailable.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  function changeFontScale(value: number) {
    if (!validScale(value)) return;
    setFontScale(value);
    applyScale(value);
  }

  return (
    <div className="space-y-7">
      <div>
        <h3 className="text-base font-semibold">{t("顯示模式")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t("切換後會立即套用到工作台。")}</p>
        <div className="mt-3 grid grid-cols-3 gap-2" role="group" aria-label={t("顯示模式")}>
          {MODES.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTheme(id)}
              aria-pressed={mounted && theme === id}
              className={cn(
                "flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border px-2 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                mounted && theme === id
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-foreground hover:bg-accent",
              )}
            >
              <Icon className="size-5" aria-hidden="true" />
              {t(label)}
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-border pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor="sweetfun-font-scale" className="text-base font-semibold">{t("字體大小")}</label>
          <span className="text-sm font-semibold tabular-nums" aria-live="polite">{fontScale}%</span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{t("拖動滑桿調整整個工作台的文字與操作介面。")}</p>
        <input
          id="sweetfun-font-scale"
          type="range"
          min={MIN_SCALE}
          max={MAX_SCALE}
          step={STEP}
          value={fontScale}
          onChange={(event) => changeFontScale(Number(event.target.value))}
          aria-valuetext={`${fontScale}%`}
          className="mt-5 w-full accent-primary"
        />
        <div className="mt-1 flex justify-between text-xs text-muted-foreground" aria-hidden="true">
          <span>{t("較小")}</span>
          <span>{t("較大")}</span>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background px-4 py-3">
          <span className="text-sm text-foreground">{t("預覽文字：今天的訂房與房況一目了然。")}</span>
          <button
            type="button"
            onClick={() => changeFontScale(100)}
            disabled={fontScale === 100}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline disabled:cursor-default disabled:opacity-45"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {t("恢復預設")}
          </button>
        </div>
      </div>

      <div className="border-t border-border pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor="sweetfun-month-week-spacing" className="text-base font-semibold">{t("月曆每週間距")}</label>
          <span className="text-sm font-semibold" aria-live="polite">{weekSpacingLabel}</span>
        </div>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {t("拉高每週可顯示更多訂單與未售房間；最右端會顯示全部。月曆會隨之變長。")}
        </p>
        <input
          id="sweetfun-month-week-spacing"
          type="range"
          min={0}
          max={MAX_MONTH_WEEK_SPACING}
          step={1}
          value={monthWeekSpacing}
          onChange={(event) => setMonthWeekSpacing(Number(event.target.value))}
          aria-valuetext={weekSpacingLabel}
          className="mt-5 w-full accent-primary"
        />
        <div className="mt-1 flex justify-between text-xs text-muted-foreground" aria-hidden="true">
          <span>{t("自動")}</span>
          <span>{t("全部顯示")}</span>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background px-4 py-3">
          <Link href="/calendar" className="text-sm font-medium text-foreground underline-offset-4 hover:underline">
            {t("前往日曆查看效果")}
          </Link>
          <button
            type="button"
            onClick={() => setMonthWeekSpacing(0)}
            disabled={monthWeekSpacing === 0}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground underline-offset-4 hover:underline disabled:cursor-default disabled:opacity-45"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            {t("恢復自動")}
          </button>
        </div>
      </div>
    </div>
  );
}
