"use client";
import { useEffect, useState } from "react";
import type {
  AvailabilityList,
  WorkspaceView,
} from "@/lib/customer-workspaces/types";
import { api, button, field, plusDays, secondary, today } from "./client";
import { WorkspaceNav } from "./workspace-nav";
import { useCommand } from "./use-command";
import { formatMoney } from "./order-finance";
type Availability = {
  property: { id: string; name: string };
  title: string;
  from: string;
  to: string;
  showPrices: boolean;
  rows: {
    date: string;
    roomId: string;
    roomName: string;
    amount?: number | null;
  }[];
  lists: AvailabilityList[];
  verifiedAt: string;
  version: number;
};
export function CustomerAvailability({
  initial,
  initialPropertyId,
  initialListId,
}: {
  initial: WorkspaceView;
  initialPropertyId?: string;
  initialListId?: string;
}) {
  const [data, setData] = useState(initial),
    [propertyId, setPropertyId] = useState(
      initial.properties.some((p) => p.id === initialPropertyId)
        ? initialPropertyId!
        : (initial.properties[0]?.id ?? ""),
    ),
    [from, setFrom] = useState(today()),
    [to, setTo] = useState(plusDays(today(), 6)),
    [showPrices, setShowPrices] = useState(false),
    [listId, setListId] = useState(initialListId ?? ""),
    [title, setTitle] = useState("未售房間清單"),
    [lists, setLists] = useState<AvailabilityList[]>([]),
    [response, setResponse] = useState<{
      key: string;
      value: Availability | null;
      error: string;
    }>({ key: "", value: null, error: "" }),
    [notice, setNotice] = useState(""),
    [revision, setRevision] = useState(0);
  const command = useCommand(
      `/api/customer-workspaces/${data.slug}/operations`,
    ),
    property = data.properties.find((p) => p.id === propertyId),
    canSave = ["owner", "admin"].includes(data.role),
    locked = command.busy || command.uncertain;
  const query = new URLSearchParams(
    listId
      ? { view: "availability", listId }
      : {
          view: "availability",
          propertyId,
          from,
          to,
          showPrices: String(showPrices),
        },
  ).toString();
  const requestKey = `${query}:${revision}`;
  const loading = response.key !== requestKey;
  const result = loading ? null : response.value;
  const error = loading ? "" : response.error;
  useEffect(() => {
    let active = true;
    api<Availability>(
      `/api/customer-workspaces/${data.slug}/operations?${query}`,
    )
      .then((value) => {
        if (!active) return;
        setResponse({ key: requestKey, value, error: "" });
        setLists(value.lists);
        setData((old) => ({ ...old, version: value.version }));
        if (listId) {
          setPropertyId(value.property.id);
          setFrom(value.from);
          setTo(value.to);
          setShowPrices(value.showPrices);
          setTitle(value.title);
        }
      })
      .catch((e) => {
        if (active)
          setResponse({ key: requestKey, value: null, error: e.message });
      });
    return () => {
      active = false;
    };
  }, [data.slug, query, requestKey, listId]);
  const text = result
    ? `${result.title}\n${result.property.name}｜${result.from} 至 ${result.to}\n${result.rows.map((row) => `${row.date} ${row.roomName}${result.showPrices ? ` · ${row.amount == null ? "價格另洽" : formatMoney(row.amount)}` : ""}`).join("\n")}\n\n房況以 ${new Date(result.verifiedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })} 查詢為準，實際預訂前請再次確認。`
    : "";
  async function save() {
    const saved = await command.execute<{ listId: string }>({
      action: "availability-list",
      title,
      propertyId,
      from,
      to,
      showPrices,
      version: data.version,
    });
    if (saved) {
      setListId(saved.data.listId);
      setNotice(
        "清單設定已保存。每次開啟都會依最新訂單重新查詢；複製出去的文字不會自動更新。",
      );
      setRevision((n) => n + 1);
    }
  }
  return (
    <main className="min-h-dvh bg-stone-50 p-4 text-slate-900 sm:p-8">
      <div className="mx-auto max-w-5xl">
        <a href="/start" className="text-sm text-teal-800 underline">
          我的旅宿
        </a>
        <h1 className="mt-3 text-2xl font-semibold">{data.name} · 尚未出售</h1>
        <WorkspaceNav
          data={data}
          current="availability"
          propertyId={propertyId}
        />
        <p className="mb-5 text-sm leading-6 text-slate-600">
          只列出沒有有效訂房或封房的房間與日期。退房當晚可再出售；包棟需全部房間都空著。這份清單依本工作區訂單產生，平台庫存與臨時保留房仍需另行核對。
        </p>
        <fieldset
          disabled={locked}
          className="space-y-4 rounded-2xl border bg-white p-5"
        >
          <label className="block">
            已保存的清單
            <select
              className={field}
              value={listId}
              onChange={(e) => setListId(e.target.value)}
            >
              <option value="">自訂一份新清單</option>
              {lists.map((list) => (
                <option value={list.id} key={list.id}>
                  {list.title}
                </option>
              ))}
            </select>
          </label>
          {listId && (
            <button className={secondary} onClick={() => setListId("")}>
              以這些條件建立新清單
            </button>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <label>
              旅宿
              <select
                className={field}
                value={propertyId}
                disabled={Boolean(listId)}
                onChange={(e) => setPropertyId(e.target.value)}
              >
                {data.properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              起日
              <input
                className={field}
                type="date"
                value={from}
                disabled={Boolean(listId)}
                min="2000-01-01"
                max="2100-12-31"
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              迄日（最多 90 天）
              <input
                className={field}
                type="date"
                value={to}
                disabled={Boolean(listId)}
                min={from}
                max={from ? plusDays(from, 89) : undefined}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </div>
          {data.role !== "viewer_no_price" && (
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1"
                disabled={Boolean(listId) || !property?.pricing?.enabled}
                checked={showPrices}
                onChange={(e) => setShowPrices(e.target.checked)}
              />
              <span>
                顯示每晚價格
                {!property?.pricing?.enabled && (
                  <span className="block text-sm text-slate-500">
                    此館尚未開啟價格。
                    {canSave && (
                      <a
                        className="ml-1 underline"
                        href={`/w/${data.slug}/settings?property=${propertyId}`}
                      >
                        前往房價設定
                      </a>
                    )}
                  </span>
                )}
              </span>
            </label>
          )}
          {canSave && !listId && (
            <label className="block">
              清單名稱
              <input
                className={field}
                maxLength={80}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              className={secondary}
              onClick={() => setRevision((n) => n + 1)}
            >
              更新房況
            </button>
            {canSave && !listId && (
              <button
                className={button}
                disabled={!result || loading || !title.trim()}
                onClick={() => void save()}
              >
                保存清單條件
              </button>
            )}
          </div>
        </fieldset>
        {(error || command.error) && (
          <p role="alert" className="my-4 rounded-xl bg-red-50 p-4">
            {error || command.error}
          </p>
        )}
        {notice && (
          <p role="status" className="my-4 rounded-xl bg-teal-50 p-4">
            {notice}
          </p>
        )}
        {command.uncertain && (
          <div className="my-4 rounded-xl bg-amber-50 p-4">
            <p>清單保存結果尚待確認。</p>
            <button
              className={`${button} mt-3`}
              disabled={command.busy}
              onClick={() => void save()}
            >
              重試保存相同清單
            </button>
          </div>
        )}
        {loading && <p className="my-8">正在核對最新房況…</p>}
        {result && (
          <section className="my-5 rounded-2xl border bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">
                {result.title} · {result.rows.length} 個可售房晚／包棟選項
              </h2>
              <button
                className={secondary}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(text);
                    setNotice("已複製清單文字。送出前可再核對房況與價格。");
                  } catch {
                    setNotice("無法自動複製，請選取下方清單文字複製。");
                  }
                }}
              >
                複製清單文字
              </button>
            </div>
            <p className="my-3 text-xs text-slate-500">
              包棟和其中的房間是互斥的販售選項，不可相加計算庫存。
            </p>
            {result.rows.length ? (
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-3">住宿日期</th>
                      <th>房間／包棟</th>
                      {result.showPrices && (
                        <th className="text-right">每晚價格</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row) => (
                      <tr
                        className="border-b last:border-0"
                        key={`${row.date}:${row.roomId}`}
                      >
                        <td className="py-3">{row.date}</td>
                        <td>{row.roomName}</td>
                        {result.showPrices && (
                          <td className="text-right">
                            {row.amount == null
                              ? "價格另洽"
                              : formatMoney(row.amount)}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="my-6">此範圍沒有可出售的房間。</p>
            )}
            <details className="mt-5">
              <summary className="cursor-pointer text-sm underline">
                查看可複製文字
              </summary>
              <textarea
                aria-label="尚未出售清單文字"
                className={field}
                readOnly
                rows={10}
                value={text}
              />
            </details>
          </section>
        )}
      </div>
    </main>
  );
}
