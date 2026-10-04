import type { WorkspaceView } from "@/lib/customer-workspaces/types";
export function WorkspaceNav({
  data,
  current,
  propertyId,
}: {
  data: WorkspaceView;
  current: "calendar" | "availability" | "finance" | "revenue" | "settings";
  propertyId?: string;
}) {
  const suffix = propertyId
    ? `?property=${encodeURIComponent(propertyId)}`
    : "";
  const tabs = [
    ["calendar", "房況日曆"],
    ["availability", "尚未出售"],
    ...(data.role !== "viewer_no_price" ? [["finance", "收款記帳"]] : []),
    ...(["owner", "admin", "viewer"].includes(data.role) ? [["revenue", "訂單健檢"]] : []),
    ...(["owner", "admin"].includes(data.role)
      ? [["settings", "旅宿與協作設定"]]
      : []),
  ];
  return (
    <nav aria-label="旅宿功能" className="my-5 flex flex-wrap gap-2">
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
