"use client";

import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { dateAfter, stayNights } from "@/lib/booking-sources/manual-booking-form";

export function StayDateFields({ checkIn, checkOut, onChange, label = "", disabled = false }:
  { checkIn: string; checkOut: string; onChange: (checkIn: string, checkOut: string) => void;
    label?: string; disabled?: boolean }) {
  const id = useId();
  const [selecting, setSelecting] = useState<"in" | "out" | null>(null);
  const [month, setMonth] = useState(checkIn.slice(0, 7));
  const outButton = useRef<HTMLButtonElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const year = Number(month.slice(0, 4)), monthNumber = Number(month.slice(5));
  const first = new Date(Date.UTC(year, monthNumber - 1, 1));
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const shiftMonth = (amount: number) => setMonth(new Date(Date.UTC(year,
    monthNumber - 1 + amount, 1)).toISOString().slice(0, 7));
  const select = (date: string) => {
    if (selecting === "in") {
      onChange(date, checkOut > date ? checkOut : dateAfter(date));
      setSelecting("out");
      // The same calendar immediately becomes the checkout picker, including on iOS.
      setMonth(date.slice(0, 7));
      outButton.current?.focus();
    } else {
      onChange(checkIn, date);
      setSelecting(null);
      outButton.current?.focus();
    }
  };
  return <div className="min-w-0 space-y-2">
    <div className="grid min-w-0 grid-cols-2 gap-3">
      {(["in", "out"] as const).map(part => <div key={part} className="min-w-0 space-y-1">
        <p id={`${id}-${part}`} className="text-sm font-medium">{part === "in" ? "入住" : "退房"}</p>
        <Button type="button" ref={part === "out" ? outButton : undefined} variant="outline"
          className={`h-11 w-full min-w-0 justify-start px-3 text-base ${selecting === part ? "border-blue-500 ring-1 ring-blue-500" : ""}`}
          aria-label={`${label}${part === "in" ? "入住日期" : "退房日期"}`}
          aria-expanded={selecting === part} aria-controls={`${id}-calendar`} disabled={disabled}
          onClick={() => {
            setSelecting(selecting === part ? null : part);
            setMonth((part === "in" ? checkIn : checkOut).slice(0, 7));
          }}>{(part === "in" ? checkIn : checkOut).replaceAll("-", "/")}</Button>
      </div>)}
    </div>
    {selecting && !disabled && <div id={`${id}-calendar`} className="rounded-xl border bg-background p-3"
      role="group" aria-label={`${label}選擇${selecting === "in" ? "入住" : "退房"}日期`}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setSelecting(null); outButton.current?.focus(); } }}>
      <p role="status" className="mb-2 text-sm font-medium text-blue-700">
        {selecting === "in" ? "選擇入住日，再選退房日" : "接著選擇退房日"}
      </p>
      <div className="mb-2 flex items-center justify-between">
        <Button type="button" variant="ghost" size="sm" aria-label="上個月" onClick={() => shiftMonth(-1)}>‹</Button>
        <span className="text-sm font-medium">{year} 年 {monthNumber} 月</span>
        <Button type="button" variant="ghost" size="sm" aria-label="下個月" onClick={() => shiftMonth(1)}>›</Button>
      </div>
      <div className="grid grid-cols-7 text-center text-xs text-muted-foreground" aria-hidden="true">
        {["日", "一", "二", "三", "四", "五", "六"].map(day => <span key={day} className="py-1">{day}</span>)}
      </div>
      <div ref={grid} className="grid grid-cols-7 gap-1" onKeyDown={event => {
        const offset = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 } as Record<string, number>)[event.key];
        if (!offset) return;
        const buttons = [...(grid.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        const target = buttons[buttons.indexOf(event.target as HTMLButtonElement) + offset];
        if (target && !target.disabled) { event.preventDefault(); target.focus(); }
      }}>
        {Array.from({ length: first.getUTCDay() }, (_, index) => <span key={`blank-${index}`} />)}
        {Array.from({ length: days }, (_, index) => {
          const date = `${month}-${String(index + 1).padStart(2, "0")}`;
          const endpoint = date === checkIn || date === checkOut;
          return <button key={date} type="button" aria-label={date} aria-pressed={endpoint}
            disabled={selecting === "out" && date <= checkIn}
            className={`h-10 min-w-0 rounded-md text-sm outline-offset-2 disabled:opacity-30 ${endpoint ? "bg-blue-600 text-white" : date > checkIn && date < checkOut ? "bg-blue-50 text-blue-900" : "hover:bg-muted"}`}
            onClick={() => select(date)}>{index + 1}</button>;
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{stayNights(checkIn, checkOut).length} 晚 · 退房日不計房費</p>
    </div>}
  </div>;
}
