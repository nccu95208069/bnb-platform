"use client";

import Link from "next/link";
import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { CALENDAR_PALETTES, CHANNELS, DEFAULT_PALETTE, type PaletteId } from "@/lib/calendar-palettes";
import { useCalendarAppearance } from "./calendar-appearance";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const SAMPLE_LABELS = ["Bkg 101", "直訂 201", "Ago 301", "Trip 102", "Owl 302", "Air 202", "其他"];

export function CalendarAppearanceSettings() {
  const { palette, scope, saving, error, reload, save } = useCalendarAppearance();
  const [draft, setDraft] = useState<PaletteId | null>(null);
  const [saved, setSaved] = useState(false);
  const selected = draft ?? palette;
  return <section className="mx-auto max-w-4xl space-y-5 pb-8">
    <div>
      <p className="text-xs font-medium tracking-widest text-muted-foreground">個人偏好</p>
      <h1 className="mt-1 text-2xl font-semibold">日曆配色</h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">選一組看得舒服的顏色。月、週、日曆與平台圖例會一起套用，訂單內容不變。</p>
    </div>
    <div className="rounded-xl border bg-card px-4 py-3 text-sm" aria-live="polite">
      {scope === "account" ? "私人帳號 · 配色會跨裝置保存，只影響你的畫面。" : scope === "device" ? <>目前未登入 · 配色只儲存在這個瀏覽器。<Link href="/calendar-access" className="ml-2 underline">登入後同步</Link></> : scope === "loading" ? "正在讀取你的配色…" : "暫時無法確認個人偏好。"}
    </div>
    <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="五種日曆配色">
      {CALENDAR_PALETTES.map((preset) => <button key={preset.id} type="button" aria-pressed={selected === preset.id} aria-label={preset.name} disabled={saving}
        onClick={() => { setDraft(preset.id); setSaved(false); }}
        className={cn("rounded-2xl border-2 bg-card p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60", selected === preset.id ? "border-slate-700" : "border-transparent ring-1 ring-border hover:border-slate-300")}>
        <span className="flex items-center justify-between gap-3">
          <span className="font-semibold">{preset.name}<span className="ml-2 text-xs font-normal text-muted-foreground">{preset.id === DEFAULT_PALETTE ? "預設" : preset.id === "jewel" ? "飽和款" : ""}</span></span>
          <span className={cn("flex size-5 items-center justify-center rounded-full border", selected === preset.id && "border-slate-700 bg-slate-700 text-white")}>{selected === preset.id && <Check className="size-3.5" />}</span>
        </span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">{preset.description}</span>
        <span className="mt-3 grid grid-cols-3 gap-1 rounded-xl border bg-white p-2" aria-hidden="true">
          {CHANNELS.slice(0, 6).map((channel, i) => <span key={channel} className="truncate rounded px-1.5 py-1 text-[11px] font-medium" style={{ backgroundColor: preset.colors[channel].background, color: preset.colors[channel].foreground }}>{SAMPLE_LABELS[i]}</span>)}
        </span>
      </button>)}
    </div>
    <p className="text-xs text-muted-foreground">以上為配色預覽。平台仍以文字標示，付款狀態與異常提醒維持原本顏色。</p>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}<button type="button" className="ml-3 underline" onClick={() => { setSaved(false); reload(); }}>重新讀取</button></div>}
    <div className="flex flex-wrap items-center gap-3">
      <Button disabled={saving || scope === "loading" || scope === "error"} onClick={async () => { setSaved(false); if (await save(selected)) { setDraft(null); setSaved(true); } }}>
        {saving && <Loader2 className="size-4 animate-spin" />}{saving ? "正在儲存…" : "套用配色"}
      </Button>
      <Button asChild variant="outline"><Link href="/calendar">回到日曆</Link></Button>
      <span role="status" className="text-sm text-muted-foreground">{saved ? scope === "account" ? "已儲存到私人帳號" : "已儲存到這個瀏覽器" : ""}</span>
    </div>
  </section>;
}
