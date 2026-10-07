import { bookingStatusLabel } from "@/lib/customer-workspaces/hold-state";
import { notFound } from "next/navigation";
import { customerPage } from "@/lib/customer-workspaces/page-context";
import {
  queryOrders,
  stayCounts,
  tagsFor,
  type OrderQuery,
} from "@/lib/customer-workspaces/order-query";
import { financeSummary } from "@/lib/customer-workspaces/domain";
import { WorkspaceNav } from "@/components/customer-workspaces/workspace-nav";
import { OrderTags } from "@/components/customer-workspaces/order-tags";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "旅宿工作區｜訂單查詢",
  robots: { index: false, follow: false },
};
const field =
  "mt-1 block w-full min-w-0 rounded-xl border border-slate-300 bg-white p-3 text-sm";
const money = (amount: number | null) =>
  amount === null ? "待確認" : `NT$ ${amount.toLocaleString("zh-TW")}`;
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<OrderQuery>;
}) {
  const { slug } = await params,
    raw = await searchParams;
  const query = Object.fromEntries(
    Object.entries(raw).filter(
      (pair): pair is [string, string] => typeof pair[1] === "string",
    ),
  ) as OrderQuery;
  const search = new URLSearchParams(query),
    back = `/w/${slug}/orders${search.size ? `?${search}` : ""}`;
  const data = await customerPage(
    slug,
    `orders${search.size ? `?${search}` : ""}`,
  );
  if (!data) notFound();
  let result;
  try {
    result = queryOrders(data, query);
  } catch {
    return (
      <main className="p-8">
        <h1>無法使用這組查詢條件</h1>
        <a className="underline" href={`/w/${slug}/orders`}>
          清除條件並重新查詢
        </a>
      </main>
    );
  }
  const platforms = [
    ...new Set(
      data.bookings
        .filter((b) => !query.property || b.propertyId === query.property)
        .flatMap((b) => (b.platform ? [b.platform] : [])),
    ),
  ].sort();
  const pageHref = (page: number) => {
    const next = new URLSearchParams(query);
    next.set("page", String(page));
    return `?${next}`;
  };
  return (
    <main className="min-h-dvh bg-stone-50 p-4 text-slate-900 sm:p-8">
      <div className="mx-auto max-w-6xl">
        <a href="/start" className="text-sm text-teal-800 underline">
          我的旅宿
        </a>
        <h1 className="mt-3 text-2xl font-semibold">{data.name} · 訂單查詢</h1>
        <WorkspaceNav
          data={data}
          current="orders"
          propertyId={query.property}
        />
        <form
          method="get"
          className="grid gap-4 rounded-2xl border bg-white p-5 sm:grid-cols-2 lg:grid-cols-4"
        >
          <label className="sm:col-span-2">
            搜尋旅客、訂單編號、備註
            <input
              className={field}
              name="q"
              defaultValue={query.q}
              maxLength={200}
              placeholder="姓名、平台訂單編號或需求關鍵字"
            />
          </label>
          <label>
            旅宿
            <select
              className={field}
              name="property"
              defaultValue={query.property || ""}
            >
              <option value="">全部有權限的旅宿</option>
              {data.properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            房間
            <select
              className={field}
              name="room"
              defaultValue={query.room || ""}
            >
              <option value="">全部房間</option>
              {data.properties.flatMap((p) =>
                p.rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {p.name} · {r.name}
                  </option>
                )),
              )}
            </select>
          </label>
          <label>
            日期類型
            <select
              className={field}
              name="dateKind"
              defaultValue={query.dateKind || "stay"}
            >
              {Object.entries({
                stay: "住宿期間",
                checkIn: "入住日期",
                checkOut: "退房日期",
                bookedAt: "訂房日期",
              }).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            起日
            <input
              className={field}
              name="from"
              type="date"
              min="2000-01-01"
              max="2100-12-31"
              defaultValue={query.from}
            />
          </label>
          <label>
            迄日
            <input
              className={field}
              name="to"
              type="date"
              min="2000-01-01"
              max="2100-12-31"
              defaultValue={query.to}
            />
          </label>
          <label>
            預訂平台
            <select
              className={field}
              name="platform"
              defaultValue={query.platform || ""}
            >
              <option value="">全部平台</option>
              <option value="__missing">平台未填</option>
              {platforms.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            訂單狀態
            <select
              className={field}
              name="status"
              defaultValue={query.status || "confirmed"}
            >
              <option value="confirmed">正式訂單</option>
              <option value="held">保留單</option>
              <option value="awaiting_owner">保留待處理（到期／釋出後到款）</option>
              <option value="cancelled">已取消</option>
              <option value="all">全部</option>
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="missingDate"
              value="true"
              defaultChecked={query.missingDate === "true"}
            />
            只看訂房日期未填（忽略日期範圍）
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name="attention"
              value="true"
              defaultChecked={query.attention === "true"}
            />
            姓名未填／房晚重疊
          </label>
          <div className="flex items-center gap-4">
            <button className="rounded-xl bg-teal-800 px-5 py-3 text-white">
              查詢訂單
            </button>
            <a className="text-sm underline" href={`/w/${slug}/orders`}>
              清除條件
            </a>
          </div>
        </form>
        {data.properties
          .filter((p) => !query.property || p.id === query.property)
          .map(
            (p) =>
              data.readiness?.[p.id]?.complete === false && (
                <p
                  key={p.id}
                  className="my-4 rounded-xl bg-amber-50 p-4 text-sm"
                >
                  {p.name}：{data.readiness[p.id].unresolvedCount || "有"}{" "}
                  筆來源或同步狀態待核對；以下僅列已保存訂單。
                  {["owner", "admin"].includes(data.role) && (
                    <a
                      className="ml-2 underline"
                      href={`/w/${slug}/import?property=${encodeURIComponent(p.id)}`}
                    >
                      查看待核對來源
                    </a>
                  )}
                </p>
              ),
          )}
        {result.reviewCount > 0 && (
          <details
            className="my-5 rounded-2xl border border-amber-200 bg-amber-50 p-5"
            open={query.attention === "true"}
          >
            <summary className="cursor-pointer font-semibold">
              尚未成為完整訂單的來源紀錄 · {result.reviewCount} 筆
            </summary>
            <p className="my-3 text-sm">
              這些紀錄仍需核對，未列入訂單或金額合計；因日期與平台可能未確認，這份來源清單不套用日期或平台條件。
            </p>
            <ul className="space-y-3">
              {result.reviewRecords.map((r) => (
                <li key={r.id} className="rounded-xl bg-white p-3 text-sm">
                  <strong>{r.guestName || r.label || "來源紀錄"}</strong>
                  <p className="mt-1">
                    {r.checkIn || "入住待確認"} → {r.checkOut || "退房待確認"}
                  </p>
                  <p className="mt-1 text-amber-900">{r.issues.join("；")}</p>
                  {["owner", "admin"].includes(data.role) && (
                    <a
                      className="mt-2 inline-block underline"
                      href={`/w/${slug}/import?property=${encodeURIComponent(r.propertyId)}`}
                    >
                      回來源核對
                    </a>
                  )}
                </li>
              ))}
            </ul>
            {result.reviewCount > 100 && (
              <p className="mt-3 text-sm">
                先顯示 100 筆，請縮小旅宿、房間或關鍵字範圍。
              </p>
            )}
          </details>
        )}
        <div className="my-5 flex flex-wrap justify-between gap-2 text-sm text-slate-600">
          <p>{result.total} 筆訂單 · 入住日期由早到晚</p>
          <p>
            查詢時間：
            {new Date(result.verifiedAt).toLocaleString("zh-TW", {
              timeZone: "Asia/Taipei",
            })}
          </p>
        </div>
        <div className="space-y-3">
          {result.bookings.map((b) => {
            const p = data.properties.find((p) => p.id === b.propertyId)!,
              counts = stayCounts(b),
              summary = financeSummary(b);
            return (
              <a
                key={b.id}
                id={`order-${b.id}`}
                href={`/w/${slug}/orders/${encodeURIComponent(b.id)}?${new URLSearchParams({ back: `${back}#order-${b.id}` })}`}
                className="block rounded-2xl border bg-white p-5 hover:border-teal-600 focus-visible:outline-2 focus-visible:outline-teal-700"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">
                      {b.guestName || "未填姓名"}{" "}
                      <span className="ml-2 text-sm font-normal text-slate-500">
                        {b.platform || "平台未填"}
                      </span>
                    </h2>
                    <p className="mt-2 text-sm">
                      {b.checkIn} 入住 → {b.checkOut} 退房
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      {p.name} ·{" "}
                      {p.rooms
                        .filter((r) => b.roomIds.includes(r.id))
                        .map((r) => r.name)
                        .join("、")}{" "}
                      · {counts.nights} 晚／{counts.roomNights} 房晚
                      {b.stays && b.stays.length > 1
                        ? ` · ${b.stays.length} 段住宿`
                        : ""}
                    </p>
                  </div>
                  {data.role !== "viewer_no_price" && (
                    <p className="text-sm sm:text-right">
                      整筆總額 {money(b.total)}
                      <span className="mt-1 block text-slate-600">
                        房費實收 {money(summary.received)} · 尚待收款{" "}
                        {money(summary.remaining)}
                      </span>
                    </p>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <OrderTags
                    tags={tagsFor(p).filter((t) => b.tagIds?.includes(t.id))}
                  />
                  {result.issues[b.id].map((issue) => (
                    <span key={issue} className="text-sm text-amber-800">
                      {issue}
                    </span>
                  ))}
                  {b.status !== "confirmed" && (
                    <span className="text-sm text-slate-500">{bookingStatusLabel(b)}</span>
                  )}
                </div>
              </a>
            );
          })}
        </div>
        {!result.total && (
          <div className="my-8 rounded-xl border bg-white p-8 text-center">
            <p>沒有符合條件的已保存訂單。</p>
            <a
              className="mt-3 inline-block text-teal-800 underline"
              href={`/w/${slug}/orders`}
            >
              清除條件重新查詢
            </a>
          </div>
        )}
        {result.pages > 1 && (
          <nav aria-label="訂單分頁" className="my-6 flex justify-center gap-5">
            {result.page > 1 && (
              <a className="underline" href={pageHref(result.page - 1)}>
                上一頁
              </a>
            )}
            <span>
              {result.page}／{result.pages}
            </span>
            {result.page < result.pages && (
              <a className="underline" href={pageHref(result.page + 1)}>
                下一頁
              </a>
            )}
          </nav>
        )}
      </div>
    </main>
  );
}
