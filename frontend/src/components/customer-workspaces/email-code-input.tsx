"use client";
import { useRef } from "react";

export function EmailCodeInput({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  function put(index: number, text: string) {
    const digits = text.replace(/\D/g, "").slice(0, 6);
    if (!digits) return;
    const next = Array.from({ length: 6 }, (_, i) => value[i] || " ");
    const start = digits.length === 6 ? 0 : index;
    for (let i = 0; i < digits.length && start + i < 6; i++) next[start + i] = digits[i];
    onChange(next.join("").trimEnd());
    inputs.current[Math.min(5, start + digits.length)]?.focus();
  }
  return <div role="group" aria-label="信件中的 6 位登入碼" className="grid w-full max-w-xs grid-cols-6 gap-1.5 sm:gap-2">
    {Array.from({ length: 6 }, (_, index) => <input key={index} ref={node => { inputs.current[index] = node; }}
      className="h-12 w-full min-w-0 rounded-lg border border-slate-300 text-center text-xl tabular-nums focus:border-teal-700 focus:outline-2 focus:outline-teal-700"
      aria-label={`登入碼第 ${index + 1} 位`} inputMode="numeric" autoComplete={index === 0 ? "one-time-code" : "off"}
      value={(value[index] || "").trim()} disabled={disabled}
      onFocus={event => event.currentTarget.select()}
      onPaste={event => { event.preventDefault(); put(index, event.clipboardData.getData("text")); }}
      onChange={event => { if (event.target.value) put(index, event.target.value); else { const next = value.padEnd(6, " ").split(""); next[index] = " "; onChange(next.join("").trimEnd()); } }}
      onKeyDown={event => { if (event.key === "Backspace" && !(value[index] || "").trim() && index > 0) inputs.current[index - 1]?.focus(); if (event.key === "ArrowLeft") inputs.current[Math.max(0, index - 1)]?.focus(); if (event.key === "ArrowRight") inputs.current[Math.min(5, index + 1)]?.focus(); }} />)}
  </div>;
}
