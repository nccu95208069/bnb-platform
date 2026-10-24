"use client";

import { useState } from "react";
import { CheckCheck, Copy } from "lucide-react";
import { useT } from "@/components/i18n/language-provider";

export function CopyableValue({ label, value, missing = "未提供正式訂單編號", showValue = true }: {
  label: string;
  value: string | null | undefined;
  missing?: string;
  showValue?: boolean;
}) {
  const uiText = useT();
  const [result, setResult] = useState<{ value: string; status: "copied" | "failed" } | null>(null);
  const text = value?.trim() || null;
  const status = result?.value === text ? result.status : "idle";

  async function copy() {
    if (!text) return;
    try {
      let copied = false;
      if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(text); copied = true; } catch { /* Older mobile browsers can still use selection copy. */ }
      }
      if (!copied) {
        const input = document.createElement("textarea");
        input.value = text;
        input.setAttribute("readonly", "");
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        copied = document.execCommand("copy");
        input.remove();
        if (!copied) throw Error("COPY_FAILED");
      }
      setResult({ value: text, status: "copied" });
    } catch {
      setResult({ value: text, status: "failed" });
    }
  }

  return <span className="inline-flex max-w-full flex-wrap items-center gap-2">
    {showValue && <span className="min-w-0 break-all">{text || uiText(missing)}</span>}
    {text && <button type="button" onClick={() => void copy()}
      aria-label={uiText("複製{0}", [label])}
      className="inline-flex min-h-9 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {status === "copied" ? <CheckCheck className="size-3.5" /> : <Copy className="size-3.5" />}
      {uiText(status === "copied" ? "已複製" : "複製")}
    </button>}
    {status === "failed" && <span role="alert" className="text-xs text-destructive">{uiText("複製失敗，請長按文字複製")}</span>}
  </span>;
}
