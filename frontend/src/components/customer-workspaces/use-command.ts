"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "./client";
export function useCommand(endpoint: string) {
  const pending = useRef<Record<string, unknown> | null>(null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!busy && !uncertain) return;
    const keepPending = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", keepPending);
    return () => window.removeEventListener("beforeunload", keepPending);
  }, [busy, uncertain]);
  async function execute<T>(input: Record<string, unknown> = {}) {
    if (running.current) return null;
    running.current = true;
    pending.current ??= { ...input, requestKey: crypto.randomUUID() };
    setBusy(true);
    setError("");
    const original = pending.current;
    try {
      const data = await api<T>(endpoint, "POST", original);
      pending.current = null;
      setUncertain(false);
      return { data, input: original };
    } catch (e) {
      setError((e as Error).message);
      const status = e instanceof Error && "status" in e ? Number(e.status) : 0;
      if (status >= 400 && status < 500) {
        pending.current = null;
        setUncertain(false);
      } else setUncertain(true);
      return null;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { execute, busy, uncertain, error, setError };
}
