'use client';
import { useCallback, useEffect, useState } from 'react';

type Settings = {
  propertyName: string; enabled: boolean; includeUnconfirmed: boolean;
  selectedAccountId: string | null; selectedEmail: string | null;
  lineConnected: boolean; lineVerifiedAt: string | null;
  canManage: boolean; canPair: boolean;
  members: { accountId: string; email?: string; role: string }[];
};
type Pairing = { command: string; expiresAt: string };
const classInput = 'mt-2 w-full rounded-xl border border-slate-300 bg-white p-3';
const classButton = 'rounded-xl bg-teal-800 px-5 py-3 font-medium text-white disabled:opacity-50';

export function ArrivalNotificationSettings({ slug, properties, initialProperty }: {
  slug: string; properties: { id: string; name: string }[]; initialProperty?: string;
}) {
  const [property, setProperty] = useState(properties.find(p => p.id === initialProperty)?.id ?? properties[0]?.id ?? '');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selected, setSelected] = useState(''), [enabled, setEnabled] = useState(false), [includeUnconfirmed, setIncludeUnconfirmed] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const url = `/api/arrival-reminders/settings?${new URLSearchParams({ workspace: slug, property })}`;
  const receive = (value: Settings) => {
    setSettings(value); setSelected(value.selectedAccountId ?? ''); setEnabled(value.enabled); setIncludeUnconfirmed(value.includeUnconfirmed);
  };
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!property) return;
    setBusy(true); setError(''); setSettings(null); setPairing(null);
    try {
      const response = await fetch(url, { cache: 'no-store', signal });
      const data = await response.json();
      if (!response.ok) throw Error(data.detail ?? '讀取通知設定失敗');
      if (!signal?.aborted) receive(data);
    } catch (caught) { if (!signal?.aborted) setError((caught as Error).message); }
    finally { if (!signal?.aborted) setBusy(false); }
  }, [property, url]);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); return () => controller.abort(); }, [refresh]);
  async function post(input: Record<string, unknown>) {
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw Error(data.detail ?? '保存失敗');
      if (input.action === 'save') { receive(data); setPairing(null); setNotice('通知設定已保存。若尚未配對 LINE，請由選定的管家登入後完成配對。'); }
      else setPairing(data);
    } catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="space-y-6">
    <p className="text-slate-700">每間旅宿可指定一位已加入工作區的管家或業主。收件人須親自登入 OS、用自己的 LINE 私訊民宿小幫手完成配對。已啟用且配對完成後，系統每天台北時間 09:00–09:59 為今日與明日入住、含備註的每筆訂單各發一則；沒有符合條件的訂單就不發訊息。</p>
    <label className="block font-medium">旅宿
      <select className={classInput} value={property} disabled={busy} onChange={event => setProperty(event.target.value)}>{properties.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
    </label>
    {error && <p role="alert" className="rounded-xl bg-amber-50 p-4 text-amber-900">{error}</p>}
    {notice && <p role="status" className="rounded-xl bg-teal-50 p-4 text-teal-900">{notice}</p>}
    {busy && <p role="status">讀取或保存中…</p>}
    {settings && <>
      {settings.canManage && <form className="space-y-4 rounded-2xl border bg-white p-5" onSubmit={event => { event.preventDefault(); void post({ action: 'save', recipientAccountId: selected, enabled, includeUnconfirmed }); }}>
        <h2 className="text-lg font-semibold">誰接收提醒</h2>
        <label className="block">選擇管家
          <select className={classInput} value={selected} onChange={event => setSelected(event.target.value)} required disabled={busy}>
            <option value="">請選擇已加入的成員</option>
            {settings.members.map(member => <option key={member.accountId} value={member.accountId}>{member.email ?? '未提供信箱'} · {member.role === 'owner' ? '業主' : member.role === 'housekeeper' ? '管家' : '管理員'}</option>)}
          </select>
        </label>
        <p className="text-sm text-slate-600">管家尚未加入？請先到<a className="ml-1 text-teal-800 underline" href={`/w/${slug}/settings?property=${encodeURIComponent(property)}`}>旅宿與協作設定</a>邀請並開放這間旅宿。</p>
        <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={busy} />啟用每日入住備註提醒</label>
        <label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={includeUnconfirmed} onChange={event => setIncludeUnconfirmed(event.target.checked)} disabled={busy} />另發「房晚待核對」摘要；不把可能續住的房晚說成新入住</label>
        <button className={classButton} type="submit" disabled={busy || !selected}>保存通知設定</button>
      </form>}
      <section className="space-y-3 rounded-2xl border bg-white p-5" aria-label="LINE 配對狀態">
        <h2 className="text-lg font-semibold">LINE 收件人</h2>
        <p role="status">{settings.lineConnected ? '已配對，可接收提醒' : settings.selectedAccountId ? '選定管家尚未完成 LINE 配對' : '尚未選擇管家'}{!settings.enabled ? '；目前提醒關閉' : ''}</p>
        {settings.selectedEmail && <p className="text-sm text-slate-600">選定成員：{settings.selectedEmail}</p>}
        {settings.lineVerifiedAt && <p className="text-sm text-slate-600">最近配對：{new Date(settings.lineVerifiedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}（台北）</p>}
        {settings.canPair && <>
          <p className="text-sm leading-7">請用你要接收訊息的 LINE 帳號，與「民宿小幫手」一對一私訊。取得以下指令後，10 分鐘內送出，再回來查詢狀態。</p>
          <button className={classButton} type="button" disabled={busy} onClick={() => void post({ action: 'pair' })}>產生我的 LINE 配對指令</button>
          {pairing && <div className="space-y-2 rounded-xl bg-slate-50 p-4"><label className="block">配對指令<textarea className={`${classInput} break-all font-mono text-sm`} value={pairing.command} readOnly rows={3} onFocus={event => event.currentTarget.select()} /></label><p className="text-sm">有效至 {new Date(pairing.expiresAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}（台北）</p><button type="button" className="rounded-xl border px-4 py-2" onClick={() => { void navigator.clipboard.writeText(pairing.command).then(() => setNotice('已複製配對指令。')).catch(() => setNotice('無法自動複製，請選取上方指令手動複製。')); }}>複製指令</button></div>}
        </>}
        <button type="button" className="rounded-xl border px-4 py-2" disabled={busy} onClick={() => void refresh()}>重新查詢配對狀態</button>
      </section>
      <section className="space-y-3 rounded-2xl border bg-white p-5" aria-label="通知內容預覽">
        <h2 className="text-lg font-semibold">通知內容預覽</h2>
        <p className="text-sm text-slate-600">以下為範例，正式通知依當天已確認的訂單產生；只有含備註且尚未標記已處理的入住才發送。</p>
        <pre className="whitespace-pre-wrap break-words rounded-xl bg-slate-50 p-4 text-sm leading-7">{`${settings.propertyName}｜明日入住備註\n王先生｜雙人房\n入住 2026-10-13；退房 2026-10-15\n\n請準備嬰兒床。\n\nhttps://sweetfun-os.vercel.app/w/旅宿代碼/orders/訂單編號\n送達不代表已處理，請在 OS 入住備註頁確認。`}</pre>
        {settings.includeUnconfirmed && <p className="text-sm text-amber-900">來源不完整時，待核對房晚會另發一則摘要與後台連結，不附未核定的姓名或備註。</p>}
      </section>
    </>}
  </section>;
}
