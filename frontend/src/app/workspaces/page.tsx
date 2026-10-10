import { cookies } from 'next/headers';
import { principalFor } from '@/lib/workspace-auth/session';
import { activeSources } from '@/lib/booking-sources/config';
import { allowedProperty } from '@/lib/workspace-auth/projection';
import { authenticate, CUSTOMER_COOKIE, enabled } from '@/lib/customer-workspaces/auth';
import { RedisCustomerStore } from '@/lib/customer-workspaces/store';
import { workspaceDirectory } from '@/lib/customer-workspaces/directory';

export const dynamic = 'force-dynamic';
export const metadata = { title: '我的旅宿｜Sweetfun OS', robots: { index: false, follow: false } };
export default async function WorkspacesPage() {
  const jar = await cookies();
  let legacy: { name: string; href: string }[] = [];
  let customers: Awaited<ReturnType<typeof workspaceDirectory>> = [];
  const errors: string[] = [];
  try {
    const principal = await principalFor({ cookies: jar });
    if (principal) legacy = activeSources().filter(s => allowedProperty(principal, s.property.id))
      .map(s => ({ name: s.property.name, href: `/calendar?properties=${encodeURIComponent(s.property.id)}` }));
  } catch { errors.push('既有旅宿暫時無法讀取，請稍後重新整理。'); }
  if (enabled() && jar.get(CUSTOMER_COOKIE)?.value) {
    try {
      const store = new RedisCustomerStore();
      customers = await workspaceDirectory(store, await authenticate(store, jar.get(CUSTOMER_COOKIE)?.value));
    } catch (error) {
      if (!(error instanceof Error && error.message === 'UNAUTHORIZED')) errors.push('旅宿工作區暫時無法讀取，請稍後重新整理。');
    }
  }
  const card = 'block rounded-2xl border bg-white p-6 text-teal-900 hover:border-teal-600 focus-visible:outline-2';
  return <main className="min-h-dvh bg-stone-50 px-5 py-10 text-slate-800"><div className="mx-auto max-w-3xl space-y-6">
    <header><p className="text-sm font-semibold text-teal-800">Sweetfun OS</p><h1 className="mt-3 text-3xl font-semibold">我的旅宿</h1><p className="mt-3 text-slate-600">選擇旅宿，回到房況與訂單。此處只列出目前帳號有權限的旅宿。</p></header>
    {errors.map(error => <p role="alert" key={error} className="rounded-xl bg-amber-50 p-4">{error}</p>)}
    <div className="grid gap-4 sm:grid-cols-2">
      {legacy.map(p => <a key={p.href} href={p.href} className={card}><h2 className="font-semibold">{p.name}</h2><p className="mt-2 text-sm text-slate-600">查看目前訂房表同步的日曆</p></a>)}
      {customers.map(w => <a key={w.id} href={w.href} className={card}><h2 className="font-semibold">{w.name}</h2><p className="mt-2 text-sm text-slate-600">{w.properties.map(p => p.name).join('、')}</p></a>)}
    </div>
    {!legacy.length && !customers.length && !errors.length && <p className="rounded-xl bg-white p-5">尚未登入旅宿帳號，或目前帳號尚無可使用的旅宿。</p>}
    <nav aria-label="旅宿帳號" className="flex flex-wrap gap-4 text-sm text-teal-800">
      <a href="/start" className="underline">登入／新增旅宿工作區</a>
      <a href="/calendar-access" className="underline">登入既有兩館日曆</a>
      <a href="/join" className="underline">第一次加入</a>
    </nav>
  </div></main>;
}
