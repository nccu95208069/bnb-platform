"use client";

import { useEffect, useRef } from 'react';

type Input = {
  properties: string;
  scope: string;
  enabled: boolean;
  busy: boolean;
  changed: () => void;
};

// Events only invalidate a display. The normal authorized read remains the
// source of booking data, role redaction and room-night validation.
export function useCalendarRealtime({ properties, scope, enabled, busy, changed }: Input) {
  const latest = useRef({ busy, changed });
  const wake = useRef<(() => void) | null>(null);
  useEffect(() => {
    latest.current = { busy, changed };
    if (!busy) wake.current?.();
  }, [busy, changed]);

  useEffect(() => {
    const selected = properties.split(',').filter(Boolean);
    if (!enabled || !scope || !selected.length ||
      selected.some(property => property !== 'sweetfun' && property !== 'offland') ||
      new Set(selected).size !== selected.length || typeof EventSource === 'undefined') return;
    let stopped = false, revoked = false, dirty = false, stream: EventSource | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;
    const revisions = new Map<string, string>();
    const visible = () => !document.hidden && window.navigator.onLine !== false;
    const scheduleRefresh = () => {
      if (stopped || !dirty || !visible() || latest.current.busy || refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (stopped || !dirty || !visible() || latest.current.busy) return;
        dirty = false;
        latest.current.changed();
      }, 200);
    };
    wake.current = scheduleRefresh;
    const markChanged = () => { dirty = true; scheduleRefresh(); };
    const close = () => {
      stream?.close(); stream = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };
    const connect = () => {
      if (stopped || revoked || stream || !visible()) return;
      const source = new EventSource(`/api/v1/calendar/stream?${new URLSearchParams({ properties })}`);
      stream = source;
      let ready = false;
      const current = () => !stopped && stream === source;
      source.addEventListener('ready', event => {
        if (!current() || ready) return;
        try {
          const value = JSON.parse((event as MessageEvent).data);
          if (!Array.isArray(value.properties) || value.properties.length !== selected.length ||
            new Set(value.properties).size !== selected.length ||
            !value.properties.every((property: unknown) => typeof property === 'string' && selected.includes(property))) return;
          ready = true;
          retryDelay = 1000;
          // Always reconcile after joining: a commit may have occurred between
          // the last read and subscription, or while a phone was suspended.
          markChanged();
        } catch { /* Malformed events never replace or erase calendar data. */ }
      });
      source.addEventListener('change', event => {
        if (!current()) return;
        try {
          const value = JSON.parse((event as MessageEvent).data);
          if (!selected.includes(value.property) || typeof value.revision !== 'string' ||
            !/^[a-zA-Z0-9_.:-]{1,160}$/.test(value.revision) ||
            revisions.get(value.property) === value.revision) return;
          revisions.set(value.property, value.revision);
          markChanged();
        } catch { /* The periodic authorized read remains the fallback. */ }
      });
      source.addEventListener('error', () => {
        if (!current()) return;
        close();
        if (!visible()) return;
        reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      });
      source.addEventListener('revoked', () => {
        if (!current()) return;
        revoked = true;
        close();
        // An ordinary authorized read owns access-loss handling, including
        // clearing private snapshots. Do not repeatedly reopen a denied stream.
        markChanged();
      });
    };
    const resume = () => {
      if (!visible()) { close(); return; }
      connect(); scheduleRefresh();
    };
    const offline = () => close();
    connect();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    window.addEventListener('offline', offline);
    return () => {
      stopped = true;
      close();
      if (refreshTimer) clearTimeout(refreshTimer);
      if (wake.current === scheduleRefresh) wake.current = null;
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      window.removeEventListener('offline', offline);
    };
    // Busy/changed deliberately use the latest callback without reconnecting.
  }, [properties, scope, enabled]);
}
