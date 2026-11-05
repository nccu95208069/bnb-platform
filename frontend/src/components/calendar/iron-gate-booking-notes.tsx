"use client";

import { useEffect, useState } from 'react';
import { useT } from '@/components/i18n/language-provider';

type State = { status: 'loading' | 'error' } | { status: 'ready'; notes: string | null };

export function IronGateBookingNotes({ bookingId, property }: {
  bookingId: string; property: string;
}) {
  const t = useT();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function read() {
      try {
        const response = await fetch(`/api/v1/bookings/${encodeURIComponent(bookingId)}/notes?property=${encodeURIComponent(property)}`,
          { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw Error('NOTES_UNAVAILABLE');
        const data = await response.json();
        if (data.bookingId !== bookingId || data.property !== property ||
          !Number.isSafeInteger(data.version) || data.version < 1 ||
          !(data.notes === null || typeof data.notes === 'string')) throw Error('NOTES_UNAVAILABLE');
        if (active) setState({ status: 'ready', notes: data.notes });
      } catch {
        if (active) setState({ status: 'error' });
      }
    }
    void read();
    return () => { active = false; controller.abort(); };
  }, [bookingId, property, attempt]);
  return <section className="rounded-xl border p-4" aria-label={t('訂單備註')}>
    <h3 className="text-sm font-semibold">{t('訂單備註')}</h3>
    <div className="mt-3 space-y-3" aria-live="polite">
      {state.status === 'loading' && <p className="text-sm text-muted-foreground">{t('讀取中')}</p>}
      {state.status === 'error' && <>
        <p className="text-sm text-amber-800">{t('暫時無法讀取備註，請重試。')}</p>
        <button type="button" className="text-sm underline" onClick={() => {
          setState({ status: 'loading' }); setAttempt(value => value + 1);
        }}>{t('重試')}</button>
      </>}
      {state.status === 'ready' && (state.notes?.trim()
        ? <p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{state.notes}</p>
        : <p className="text-sm text-muted-foreground">{t('尚無訂單備註')}</p>)}
    </div>
  </section>;
}
