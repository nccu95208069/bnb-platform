import type { CalendarStreamTarget } from './config.server.ts';

export type StreamCallbacks = {
  ready: () => void;
  changed: (property: string, payload: unknown) => void;
  failed: () => void;
};
export type StreamDependencies = {
  targets: CalendarStreamTarget[];
  subscribe: (callbacks: StreamCallbacks) => () => void;
  authorized: () => Promise<boolean>;
  signal: AbortSignal;
  lifetimeMs?: number;
  heartbeatMs?: number;
  joinTimeoutMs?: number;
};

export function calendarEventStream(deps: StreamDependencies): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let stopped = false, ready = false, checking = false;
      let unsubscribe = () => {};
      const timers: { lifetime?: ReturnType<typeof setTimeout>;
        heartbeat?: ReturnType<typeof setInterval>; join?: ReturnType<typeof setTimeout> } = {};
      const revisions = new Map<string, string>();
      const targets = new Map<string, CalendarStreamTarget>(deps.targets.map(target => [target.property, target]));
      const send = (event: string, payload: unknown) => {
        if (!stopped) controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
      };
      cleanup = () => {
        if (stopped) return;
        stopped = true;
        clearTimeout(timers.lifetime); clearTimeout(timers.join); clearInterval(timers.heartbeat);
        deps.signal.removeEventListener('abort', close);
        unsubscribe();
      };
      function close() {
        if (stopped) return;
        cleanup();
        controller.close();
      }
      if (deps.signal.aborted) { close(); return; }
      deps.signal.addEventListener('abort', close, { once: true });
      controller.enqueue(encoder.encode('retry: 3000\n: connecting\n\n'));
      timers.lifetime = setTimeout(close, deps.lifetimeMs ?? 240_000);
      timers.join = setTimeout(close, deps.joinTimeoutMs ?? 12_000);
      timers.heartbeat = setInterval(async () => {
        if (stopped || checking) return;
        checking = true;
        try {
          if (!await deps.authorized()) { send('revoked', {}); close(); return; }
          if (!stopped) controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch { close(); }
        finally { checking = false; }
      }, deps.heartbeatMs ?? 15_000);
      try {
        unsubscribe = deps.subscribe({
          ready() {
            if (stopped || ready) return;
            ready = true;
            clearTimeout(timers.join);
            send('ready', { properties: deps.targets.map(target => target.property) });
          },
          changed(property, value) {
            if (stopped || !value || typeof value !== 'object' || Array.isArray(value)) return;
            const payload = value as Record<string, unknown>, target = targets.get(property);
            // Do not forward provider payloads. Validate the binding and construct
            // the tiny browser event explicitly, even if upstream sends extra data.
            if (!target || payload.property_id !== target.propertyId ||
                typeof payload.cursor !== 'string' || !/^[1-9][0-9]{0,19}$/.test(payload.cursor)) return;
            const prior = revisions.get(property);
            // Sequence allocation is not a global commit ordering guarantee.
            // Only exact repeats can be ignored; a lower cursor may commit later.
            if (prior === payload.cursor) return;
            revisions.set(property, payload.cursor);
            send('change', { property, revision: payload.cursor });
          },
          failed: close,
        });
        // A synchronous subscription failure may close before cleanup is assigned.
        if (stopped) unsubscribe();
      } catch { close(); }
    },
    cancel() { cleanup(); },
  });
}
