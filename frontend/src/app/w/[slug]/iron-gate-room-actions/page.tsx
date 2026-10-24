import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authenticate, CUSTOMER_COOKIE, enabled } from "@/lib/customer-workspaces/auth";
import { RedisCustomerStore } from "@/lib/customer-workspaces/store";
import { loadWorkspace, view } from "@/lib/customer-workspaces/service";
import { WorkspaceNav } from "@/components/customer-workspaces/workspace-nav";
import { ironGateReadConfig, listIronGateRoomActions } from
  "@/lib/customer-workspaces/iron-gate-read.server";

export const dynamic = "force-dynamic";
export const metadata = { title: "旅宿工作區｜房態待處理與已取消", robots: { index: false, follow: false } };

const stateLabel: Record<string, string> = {
  action_required: "等待人工按鈕處理房態",
  pending: "OwlNest 處理中",
  review_required: "OwlNest 結果需人工核對",
  verified: "OwlNest 已核對",
  not_required: "無待處理房態",
};

function waitingAge(createdAt: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 60_000));
  return minutes >= 1440 ? `${Math.floor(minutes / 1440)} 天` :
    minutes >= 60 ? `${Math.floor(minutes / 60)} 小時` : `${minutes} 分鐘`;
}

export default async function Page({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ property?: string; cursor?: string }>;
}) {
  const { slug } = await params;
  if (!enabled()) return <main className="p-10">新客戶入口尚未開放。</main>;
  const store = new RedisCustomerStore();
  let account;
  try { account = await authenticate(store, (await cookies()).get(CUSTOMER_COOKIE)?.value); }
  catch { redirect(`/start?next=${encodeURIComponent(`/w/${slug}/iron-gate-room-actions`)}`); }
  let loaded;
  try { loaded = await loadWorkspace(store, account.id, slug); }
  catch { return <main className="p-10">目前無法開啟此旅宿。</main>; }
  const { workspace, member } = loaded;
  const data = view(workspace, member);
  let config;
  try { config = ironGateReadConfig(); }
  catch { return <main className="p-10">此旅宿尚未啟用 Iron Gate 房態檢視。</main>; }
  const allowed = workspace.properties.filter((property) =>
    (member.allProperties || member.propertyIds.includes(property.id)) &&
    config.grants.some((grant) => grant.workspaceId === workspace.id &&
      grant.propertyId === property.id));
  const search = await searchParams;
  const property = allowed.find((item) => item.id === search.property) ?? allowed[0];
  if (!property) return <main className="p-10">此旅宿沒有可檢視的房態。</main>;
  let result;
  try {
    result = await listIronGateRoomActions(store, account.id, slug, property.id,
      typeof search.cursor === "string" ? search.cursor : null, config);
  } catch {
    return <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-xl font-semibold">房態暫時無法讀取</h1>
      <a className="mt-4 inline-block underline" href={`/w/${slug}/orders`}>返回訂單查詢</a>
    </main>;
  }
  return <main className="min-h-dvh bg-stone-50 p-4 text-slate-900 sm:p-8">
    <div className="mx-auto max-w-6xl">
      <h1 className="text-2xl font-semibold">{workspace.name} · 房態待處理與已取消</h1>
      <p className="mt-2 text-sm text-slate-600">Iron Gate 唯讀資料。LINE 群組中的訂單資訊卡可操作關房與開房；此處用於追蹤結果。</p>
      <WorkspaceNav data={data} current="orders" propertyId={property.id} />
      <nav aria-label="選擇旅宿" className="mb-5 flex flex-wrap gap-2">
        {allowed.map((item) => <a key={item.id}
          aria-current={item.id === property.id ? "page" : undefined}
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
          href={`/w/${slug}/iron-gate-room-actions?property=${encodeURIComponent(item.id)}`}>{item.name}</a>)}
      </nav>
      <p className="mb-4 text-sm text-slate-600">每頁最多檢視 50 筆訂單；僅顯示待處理、處理中、需核對及已取消訂單。</p>
      <ul className="space-y-3">
        {result.rows.map((row) => <li key={row.id} className="rounded-2xl border bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <strong>{row.guestName || "未填姓名"}</strong>
            <span className="text-sm font-medium text-amber-800">{row.status === "cancelled" ? "已取消 · " : ""}{stateLabel[row.channelSyncState]}</span>
          </div>
          <p className="mt-2 text-sm">{row.stays.map((stay) => `${stay.checkIn} → ${stay.checkOut}`).join("、") || "住宿日期未填"}</p>
          <p className="mt-1 text-sm text-slate-600">待關 {row.pendingClose} 房晚 · 待開 {row.pendingOpen} 房晚</p>
          <p className="mt-1 text-sm text-slate-600">建立後已過 {waitingAge(row.createdAt)}</p>
          <p className="mt-1 break-all text-xs text-slate-500">訂單 {row.id}</p>
        </li>)}
      </ul>
      {result.rows.length === 0 && <p className="rounded-xl border bg-white p-5">本頁沒有符合條件的訂單。</p>}
      {result.nextCursor && <a className="mt-5 inline-block rounded-xl bg-teal-800 px-5 py-3 text-white"
        href={`/w/${slug}/iron-gate-room-actions?${new URLSearchParams({ property: property.id, cursor: result.nextCursor })}`}>
        下一頁</a>}
    </div>
  </main>;
}
