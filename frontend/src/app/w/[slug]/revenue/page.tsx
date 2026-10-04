import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  authenticate,
  CUSTOMER_COOKIE,
  enabled,
} from "@/lib/customer-workspaces/auth";
import { RedisCustomerStore } from "@/lib/customer-workspaces/store";
import { loadWorkspace } from "@/lib/customer-workspaces/service";
import { HealthPage } from "@/components/order-health/health-page";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "訂單健檢｜旅宿工作區",
  robots: { index: false, follow: false },
};
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ property?: string }>;
}) {
  if (!enabled()) return <main className="p-10">新客戶入口尚未開放。</main>;
  const store = new RedisCustomerStore(),
    { slug } = await params;
  let account;
  try {
    account = await authenticate(
      store,
      (await cookies()).get(CUSTOMER_COOKIE)?.value,
    );
  } catch {
    redirect("/start");
  }
  try {
    const { workspace, member } = await loadWorkspace(store, account.id, slug);
    if (["housekeeper", "viewer_no_price"].includes(member.role))
      throw Error("FORBIDDEN");
    const allowed = workspace.properties.filter(
        (p) => member.allProperties || member.propertyIds.includes(p.id),
      ),
      id = (await searchParams).property || allowed[0]?.id,
      property = allowed.find((p) => p.id === id);
    if (!property) throw Error("FORBIDDEN");
    return (
      <main className="min-h-screen bg-slate-50">
        <nav
          aria-label="選擇旅宿"
          className="mx-auto flex max-w-6xl flex-wrap gap-3 px-6 pt-5"
        >
          {allowed.map((p) => (
            <a
              key={p.id}
              className="rounded-lg border bg-white px-4 py-2 text-sm"
              aria-current={p.id === id ? "page" : undefined}
              href={`/w/${slug}/revenue?property=${p.id}`}
            >
              {p.name}
            </a>
          ))}
        </nav>
        <HealthPage
          key={id}
          workspace={slug}
          property={property.id}
          name={property.name}
          back={`/w/${slug}/calendar?property=${id}`}
        />
      </main>
    );
  } catch {
    return (
      <main className="p-10">
        目前沒有這個旅宿的分析權限，或工作區暫時無法讀取。
      </main>
    );
  }
}
