import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  authenticate,
  CUSTOMER_COOKIE,
  enabled,
} from "@/lib/customer-workspaces/auth";
import { RedisCustomerStore } from "@/lib/customer-workspaces/store";
import { loadWorkspace } from "@/lib/customer-workspaces/service";
import { googleReady } from "@/lib/customer-workspaces/customer-google";
import { importAccess } from "@/lib/customer-workspaces/sheet-import";
import { SheetImport } from "@/components/customer-workspaces/sheet-import";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "從試算表匯入｜旅宿工作區",
  robots: { index: false, follow: false },
};
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ property?: string; google?: string }>;
}) {
  if (!enabled()) return <main className="p-10">新客戶入口尚未開放。</main>;
  const { slug } = await params,
    search = await searchParams,
    store = new RedisCustomerStore();
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
    const loaded = await loadWorkspace(store, account.id, slug);
    const { workspace, property } = await importAccess(
      store,
      account.id,
      slug,
      search.property ?? loaded.workspace.properties[0]?.id,
    );
    return (
      <SheetImport
        slug={slug}
        property={property}
        configured={googleReady()}
        connected={search.google === "connected"}
        initialVersion={workspace.version}
        initialBatches={(workspace.importBatches ?? []).filter(
          (b) => b.propertyId === property.id,
        )}
      />
    );
  } catch {
    return (
      <main className="p-10">
        目前無法匯入，請確認管理權限或稍後重試。
        <a className="ml-3 underline" href={`/w/${slug}/calendar`}>
          回房況
        </a>
      </main>
    );
  }
}
