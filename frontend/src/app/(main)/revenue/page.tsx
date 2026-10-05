import { sourceDefinition } from "@/lib/booking-sources/config";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { principalFor } from "@/lib/workspace-auth/session";
import { PROPERTY_IDS } from "@/lib/workspace-auth/types";
import { HealthPage } from "@/components/order-health/health-page";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "訂單健檢｜Sweetfun OS",
  robots: { index: false, follow: false },
};
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ property?: string }>;
}) {
  const p = await principalFor({ cookies: await cookies() });
  if (!p) redirect("/calendar-access");
  const allowed = PROPERTY_IDS.filter(
      (id) => p.allProperties || p.propertyIds.includes(id),
    ),
    property = (await searchParams).property || allowed[0];
  if (!p.viewPrices || !allowed.includes(property))
    return <p className="p-8">目前沒有這個旅宿的分析權限。</p>;
  return (
    <>
      <nav aria-label="選擇旅宿" className="flex flex-wrap gap-3 px-6">
        {allowed.map((id) => (
          <a
            key={id}
            className="rounded-lg border px-4 py-2 text-sm"
            aria-current={id === property ? "page" : undefined}
            href={`/revenue?property=${id}`}
          >
            {sourceDefinition(id).property.name}
          </a>
        ))}
      </nav>
      <HealthPage
        key={property}
        workspace="legacy"
        property={property}
        name={sourceDefinition(property).property.name}
      />
    </>
  );
}
