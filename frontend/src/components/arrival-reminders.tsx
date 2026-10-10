'use client';
import { useCallback, useEffect, useState } from 'react';
type Item = { id: string; guest: string; checkIn: string; checkOut: string; rooms: string[]; notes: string; href: string; fingerprint: string; handledAt: string | null };
type Data = { propertyName: string; checkedAt: string; day: string; arrivals: Item[] };
export function ArrivalReminders({ properties, workspace, initialProperty }: { initialProperty?: string; properties: { id: string; name: string }[]; workspace?: string }) {
  const [property, setProperty] = useState(properties.find(p => p.id === initialProperty)?.id ?? properties[0]?.id ?? '');
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const url = `/api/arrival-reminders?${new URLSearchParams({ property, ...(workspace ? { workspace } : {}) })}`;
  const load = useCallback(async (signal?: AbortSignal) => {
    setBusy(true); setError(''); setData(null);
    try {
      const response = await fetch(url, { cache: 'no-store', signal }); const body = await response.json();
      if (!response.ok) throw Error(body.detail || '暫時無法讀取');
      if (!signal?.aborted) setData(body);
    } catch (e) { if (!signal?.aborted) setError((e as Error).message); }
    finally { if (!signal?.aborted) setBusy(false); }
  }, [url]);
  useEffect(() => { if (!property) return; const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load, property]);
  async function handled(item: Item) {
    setBusy(true); setError('');
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'handled', id: item.id, fingerprint: item.fingerprint }) });
      const body = await response.json(); if (!response.ok) throw Error(body.detail || '保存失敗');
      await load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="space-y-5">
    <div className="flex flex-wrap items-center gap-3"><label>旅宿 <select aria-label="旅宿" className="ml-2 rounded-lg border bg-white p-3" value={property} disabled={busy} onChange={e => setProperty(e.target.value)}>{properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><button type="button" className="rounded-lg border px-4 py-3" disabled={busy || !property} onClick={() => void load()}>重新載入</button></div>
    <p className="text-sm text-slate-600">列出今日與明日入住、含備註的已確認訂單。確認完成接待準備後可標記已處理；備註變更會重新顯示待處理。</p>
    {error && <p role="alert" className="rounded-xl bg-amber-50 p-4">{error}</p>}
    {busy && <p role="status">核對來源中…</p>}
    {data && <><p className="text-xs text-slate-500">核對時間：{new Date(data.checkedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}（台北）</p>
      {!data.arrivals.length && <p className="rounded-xl border bg-white p-5">目前沒有今日或明日入住且含備註的已確認訂單。</p>}
      {data.arrivals.map(item => <article key={item.id} className="space-y-3 rounded-2xl border bg-white p-5"><div className="flex flex-wrap justify-between gap-2"><h2 className="font-semibold">{item.checkIn === data.day ? '今日' : '明日'}入住 · {item.guest}</h2><span className={item.handledAt ? 'text-teal-700' : 'text-amber-800'}>{item.handledAt ? '已處理' : '待處理'}</span></div><p className="text-sm text-slate-600">{item.checkIn} → {item.checkOut} · {item.rooms.join('、')}</p><p className="whitespace-pre-wrap break-words text-sm leading-7">{item.notes}</p><div className="flex flex-wrap gap-4"><a className="py-3 text-teal-800 underline" href={item.href}>查看完整訂單</a>{!item.handledAt && <button type="button" disabled={busy} onClick={() => void handled(item)} className="rounded-lg bg-teal-800 px-4 py-3 text-white">標記已處理</button>}</div></article>)}
    </>}
  </section>;
}
