import type { OrderTag } from "@/lib/customer-workspaces/types";
export const tagColors: Record<OrderTag["color"], string> = {
  blue: "bg-blue-100 text-blue-900",
  orange: "bg-orange-100 text-orange-900",
  purple: "bg-purple-100 text-purple-900",
  green: "bg-emerald-100 text-emerald-900",
  rose: "bg-rose-100 text-rose-900",
  slate: "bg-slate-200 text-slate-800",
};
export function OrderTags({
  tags,
  compact = false,
  limit = 30,
}: {
  tags: OrderTag[];
  compact?: boolean;
  limit?: number;
}) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {tags.slice(0, limit).map((tag) => (
        <span
          key={tag.id}
          title={tag.name}
          aria-label={tag.name}
          className={`inline-flex min-w-5 items-center justify-center rounded px-1 text-xs leading-5 ${tagColors[tag.color]}`}
        >
          {compact ? tag.short : tag.name}
        </span>
      ))}
      {tags.length > limit && (
        <span className="text-xs">+{tags.length - limit}</span>
      )}
    </span>
  );
}
