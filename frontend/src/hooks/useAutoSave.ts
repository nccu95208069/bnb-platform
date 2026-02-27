"use client";

import { useEffect, useRef } from "react";
import { useWizardStore } from "@/stores/wizardStore";

export function useAutoSave(intervalMs = 30000) {
  const isDirty = useWizardStore((s) => s.isDirty);
  const markSaved = useWizardStore((s) => s.markSaved);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    timerRef.current = setInterval(() => {
      if (isDirty) {
        markSaved();
      }
    }, intervalMs);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isDirty, markSaved, intervalMs]);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);
}
