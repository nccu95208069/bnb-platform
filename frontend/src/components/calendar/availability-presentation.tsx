"use client";
import {useT} from "@/components/i18n/language-provider";
import { probabilityBand, probabilityStyles, probabilityText } from "@/lib/sales-probability";
import { inventoryLabels, policyLabels, priceText, type RoomNight } from "@/lib/availability";
const stateStyles: Record<string, string> = {
  available: "border-emerald-200 bg-emerald-50/70 text-emerald-950",
  held: "border-amber-200 bg-amber-50 text-amber-950",
  maintenance: "border-slate-200 bg-slate-100 text-slate-600",
  blocked: "border-slate-200 bg-slate-100 text-slate-600",
  unknown: "border-amber-300 bg-amber-50 text-amber-900",
  conflict: "border-red-200 bg-red-50 text-red-900",
  sold: "border-border bg-muted/40 text-muted-foreground",
  past: "border-transparent bg-muted/30 text-muted-foreground",
};
export function roomNightStyle(cell: RoomNight) {
  return cell.state === "available" ? probabilityStyles[probabilityBand(cell.sales_probability)] : stateStyles[cell.state];
}
export function PricePair({
  cell,
  compact = false,
  hidePrice = false,
}: {
  cell: RoomNight;
  compact?: boolean;
  hidePrice?: boolean;
}) {
  const uiText=useT();
  const p = cell.pricing;
  if (cell.state !== "available")
    return <span className="text-xs">{uiText(inventoryLabels[cell.state])}</span>;
  if (hidePrice || !p) return <span className="text-xs">{uiText("可售")}</span>;
  const delta =
    p.current_price != null && p.suggested_price != null
      ? p.suggested_price - p.current_price
      : null;
  return (
    <div className={compact ? "space-y-0.5" : "space-y-1"}>
      <p
        className={
          compact
            ? "text-[11px] font-semibold tabular-nums sm:text-sm"
            : "text-xl font-semibold tabular-nums"
        }
      >
        {priceText(p.current_price)}
      </p>
      <p className={compact ? "text-[9px] leading-tight opacity-80" : "text-xs"}>{uiText(probabilityText(cell.sales_probability))}</p>
      {!compact && (
        <p className="text-xs text-muted-foreground">
          {p.suggested_price != null
            ? `${uiText("建議")} ${priceText(p.suggested_price)}${delta ? `（${delta > 0 ? "+" : ""}${delta}）` : ""}`
            : p.source === "bnb-pricing / OwlNest readback" ? `${uiText("牌價")} ${priceText(p.base_price)}${p.policy === "stale_snapshot" ? ` · ${uiText("價格待更新")}` : ""}` : uiText(policyLabels[p.exclusion ?? p.policy] ?? "尚無建議")}
        </p>
      )}
    </div>
  );
}

