"use client";

import { useEffect, useRef } from "react";

// Fixed metric names and numeric durations only. Never include dates, query
// strings, booking IDs, guest fields, permissions or response bodies.
function enabled() {
  const navigation = performance.getEntriesByType("navigation")[0];
  return new URLSearchParams(window.location.search).get("calendar_perf") === "1" ||
    Boolean(navigation && new URL(navigation.name).searchParams.get("calendar_perf") === "1");
}
export function recordCalendarMeasure(name: "calendar.open" | "calendar.range" | "calendar.auth", start: number, end: number) {
  if (typeof performance === "undefined" || !Number.isFinite(start) || end < start) return;
  performance.clearMeasures(name);
  performance.measure(name, { start, end });
  if (enabled()) {
    console.info("[calendar-performance]", JSON.stringify({ metric: name,
      durationMs: Math.round((end - start) * 10) / 10 }));
  }
}

export function useCalendarPerformance(rangeKey: string, ready: boolean) {
  const request = useRef({ key: "", start: 0, measured: false });
  const opened = useRef(false);
  const mountedAt = useRef<number | null>(null);

  useEffect(() => {
    mountedAt.current ??= performance.now();
    if (request.current.key !== rangeKey)
      request.current = { key: rangeKey, start: performance.now(), measured: false };
    if (!ready || request.current.measured) return;
    const current = request.current;
    let secondFrame = 0;
    // The first frame commits layout; the second is an opportunity for the
    // loaded calendar to have painted, including legitimately empty months.
    const frame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (request.current !== current) return;
        current.measured = true;
        const end = performance.now();
        recordCalendarMeasure("calendar.range", current.start, end);
        if (!opened.current) {
          opened.current = true;
          const navigation = performance.getEntriesByType("navigation")[0];
          const directEntry = !performance.getEntriesByName("calendar.open").length &&
            navigation && new URL(navigation.name).pathname === "/calendar";
          recordCalendarMeasure("calendar.open", directEntry ? 0 : mountedAt.current!, end);
        }
      });
    });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(secondFrame); };
  }, [rangeKey, ready]);

  useEffect(() => {
    if (!enabled() || typeof PerformanceObserver === "undefined") return;
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
        const path = new URL(entry.name).pathname;
        if (path !== "/api/v1/bookings/calendar" && path !== "/api/calendar-session") continue;
        const stages = Object.fromEntries(entry.serverTiming
          .filter(stage => ["auth", "source", "payment", "total"].includes(stage.name))
          .map(stage => [stage.name, stage.duration]));
        console.info("[calendar-performance]", JSON.stringify({
          metric: path === "/api/calendar-session" ? "calendar.session" : "calendar.api",
          durationMs: Math.round(entry.duration * 10) / 10, stages,
        }));
      }
    });
    observer.observe({ type: "resource", buffered: true });
    return () => observer.disconnect();
  }, []);
}
