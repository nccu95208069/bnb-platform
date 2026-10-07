import type { WorkspaceView } from "@/lib/customer-workspaces/types";
export function WorkspaceNav({
  data,
  current,
  propertyId,
}: {
  data: WorkspaceView;
  current: "orders" | "calendar" | "availability" | "finance" | "revenue" | "settings";
  propertyId?: string;
}) {
  const suffix = propertyId
    ? `?property=${encodeURIComponent(propertyId)}`
    : "";
  const tabs = [
    ["calendar", "房況日曆"],
    ["orders", "訂單查詢"],
    ["availability", "尚未出售"],
    ...(data.role !== "viewer_no_price" ? [["finance", "收款記帳"]] : []),
    ...(["owner", "admin", "viewer"].includes(data.role) ? [["revenue", "訂單健檢"]] : []),
    ...(["owner", "admin"].includes(data.role)
      ? [["settings", "旅宿與協作設定"]]
      : []),
  ];
  return (
    <nav aria-label="旅宿功能" className="my-5 flex flex-wrap gap-2">
      {(data.features?.holds || data.bookings.some(b => b.hold)) && <>
        <a className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm" href={`/w/${data.slug}/orders?${new URLSearchParams({ status: "held", ...(propertyId ? { property: propertyId } : {}) })}`}>保留單</a>
        {["owner", "admin"].includes(data.role) && <a className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm" href={`/w/${data.slug}/orders?${new URLSearchParams({ status: "awaiting_owner", ...(propertyId ? { property: propertyId } : {}) })}`}>保留待處理</a>}
      </>}
      {tabs.map(([path, title]) => (
        <a
          key={path}
          href={`/w/${data.slug}/${path}${suffix}`}
          aria-current={current === path ? "page" : undefined}
          className={`rounded-xl px-4 py-3 text-sm font-medium ${current === path ? "bg-teal-800 text-white" : "border border-slate-300 bg-white text-slate-700"}`}
        >
          {title}
        </a>
      ))}
    </nav>
  );
}
