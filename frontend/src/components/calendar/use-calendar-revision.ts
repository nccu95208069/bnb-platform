"use client";
import { useEffect } from 'react';

// Version checks only hit OS storage. They never initiate an OwlNest read.
export function useCalendarRevision(properties: string, enabled: boolean, changed: () => void) {
  useEffect(() => {
    if (!enabled || !properties) return;
    let stopped = false, busy = false;
    const versions = new Map<string, string>();
    const controller = new AbortController();
    async function check() {
      if (stopped || busy || document.hidden) return;
      busy = true;
      try {
        let updated = false;
        await Promise.all(properties.split(',').filter(Boolean).map(async property => {
          try {
            const response = await fetch(`/api/v1/calendar/changes?${new URLSearchParams({property})}`, {cache:'no-store',signal:controller.signal});
            if (!response.ok) return;
            const result = await response.json();
            if (typeof result.revision !== 'string' || result.property_id !== property || stopped) return;
            if (versions.has(property) && versions.get(property) !== result.revision) updated = true;
            versions.set(property, result.revision);
          } catch { /* The existing minute refresh remains the fallback. */ }
        }));
        if (updated && !stopped) changed();
      } finally { busy = false; }
    }
    void check();
    const timer = setInterval(() => void check(), 15_000);
    const visible = () => void check();
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => { stopped=true; controller.abort(); clearInterval(timer); window.removeEventListener('focus',visible); document.removeEventListener('visibilitychange',visible); };
  }, [properties, enabled, changed]);
}
