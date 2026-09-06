"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { DEFAULT_PALETTE, isPaletteId, paletteCss, type PaletteId } from "@/lib/calendar-palettes";

const DEVICE_KEY = "sweetfun-calendar-device-palette-v1";
type Appearance = { palette: PaletteId; scope: "account" | "device" | "loading" | "error"; saving: boolean; error: string; reload: () => void; save: (id: PaletteId) => Promise<boolean> };
const AppearanceContext = createContext<Appearance | null>(null);
export function CalendarAppearanceProvider({ children }: { children: React.ReactNode }) {
  const [palette, setPalette] = useState<PaletteId>(DEFAULT_PALETTE);
  const [scope, setScope] = useState<Appearance["scope"]>("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const pathname = usePathname();

  const reload = useCallback(async () => {
    if (savingRef.current) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const response = await fetch("/api/calendar-appearance", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail);
      if (controller.signal.aborted) return;
      if (data.scope === "account" && isPaletteId(data.palette)) {
        setPalette(data.palette);
        setScope("account");
      } else if (data.scope === "device") {
        let local;
        try { local = localStorage.getItem(DEVICE_KEY); } catch { /* Private browsing may deny storage. */ }
        setPalette(isPaletteId(local) ? local : DEFAULT_PALETTE);
        setScope("device");
      } else throw new Error("配色資料格式不正確。");
      setError("");
    } catch (err) {
      if (controller.signal.aborted) return;
      setScope("error");
      setError(err instanceof Error ? err.message : "暫時無法讀取配色。");
    }
  }, []);

  useEffect(() => {
    void reload();
    const focus = () => { void reload(); };
    window.addEventListener("focus", focus);
    window.addEventListener("pageshow", focus);
    window.addEventListener("storage", focus);
    return () => {
      requestRef.current?.abort();
      window.removeEventListener("focus", focus);
      window.removeEventListener("pageshow", focus);
      window.removeEventListener("storage", focus);
    };
  }, [reload, pathname]);

  async function save(id: PaletteId) {
    if (savingRef.current || !isPaletteId(id) || (scope !== "account" && scope !== "device")) return false;
    requestRef.current?.abort();
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      if (scope === "account") {
        const response = await fetch("/api/calendar-appearance", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ palette: id }), signal: AbortSignal.timeout(20000) });
        const data = await response.json();
        if (!response.ok || data.palette !== id) throw new Error(data.detail || "配色儲存尚未確認。");
      } else {
        localStorage.setItem(DEVICE_KEY, id);
        if (localStorage.getItem(DEVICE_KEY) !== id) throw new Error("瀏覽器無法保存配色。");
      }
      setPalette(id);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "配色未儲存，請再試一次。");
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return <AppearanceContext.Provider value={{ palette, scope, saving, error, reload, save }}>
    <style data-calendar-palette={palette}>{paletteCss(palette)}</style>
    {children}
  </AppearanceContext.Provider>;
}
export function useCalendarAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("CalendarAppearanceProvider is required");
  return value;
}
