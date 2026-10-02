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
import { sharedSheetEmail } from "@/lib/customer-workspaces/shared-sheet";
import type { Journey } from "@/lib/customer-intake/onboarding";
import { INTAKE_RECIPIENT } from "@/lib/customer-intake/config";
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
    if (workspace.onboarding && !workspace.onboarding.approvedAt) {
      const journey = (
        await store.read<Journey>(
          `onboarding:${workspace.onboarding.requestId}`,
        )
      ).value;
      return (
        <main className="mx-auto max-w-xl p-8">
          <h1 className="text-2xl font-semibold">信箱已確認，等待權限核對</h1>
          <p className="my-5 leading-7">
            你的登入帳號已設定完成。Google
            尚未提供足夠資料讓系統確認你有權使用這份
            Sheet，服務人員會核對後寄信通知你繼續。
          </p>
          {journey?.message && (
            <p className="my-4 rounded-xl bg-amber-50 p-4">{journey.message}</p>
          )}
          <p className="my-4 break-all text-sm">
            申請編號：{workspace.onboarding.requestId}
          </p>
          <a className="underline" href={`mailto:${INTAKE_RECIPIENT}`}>
            聯絡服務人員
          </a>
          <a className="ml-5 underline" href="/start">
            回我的旅宿
          </a>
        </main>
      );
    }
    const journey = workspace.onboarding
      ? (
          await store.read<Journey>(
            `onboarding:${workspace.onboarding.requestId}`,
          )
        ).value
      : null;
    return (
      <SheetImport
        slug={slug}
        property={property}
        configured={
          workspace.onboarding ? Boolean(sharedSheetEmail()) : googleReady()
        }
        connected={search.google === "connected"}
        sharedUrl={workspace.onboarding?.sheetUrl}
        helpMessage={journey?.message}
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
