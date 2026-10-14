"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, RotateCcw, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useT } from "@/components/i18n/language-provider";
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
    </div>
  );
}
