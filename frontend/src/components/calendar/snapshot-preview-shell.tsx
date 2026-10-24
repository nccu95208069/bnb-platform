"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

export function SnapshotPreviewShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      const response = await fetch("/api/calendar-session", { method: "DELETE" });
      if (!response.ok) throw Error();
      router.replace("/calendar-access");
    } catch { setBusy(false); }
  }
  return <div className="min-h-dvh bg-muted/20">
    <header className="flex items-center justify-between border-b bg-background px-4 py-3">
      <span className="font-semibold">Sweetfun · Iron Gate 固定快照預覽</span>
      <button type="button" onClick={signOut} disabled={busy} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-60">
        {busy ? "登出中…" : "登出"}
      </button>
    </header>
    <main className="mx-auto max-w-[1760px] p-2 sm:p-4 md:p-6">{children}</main>
  </div>;
}
