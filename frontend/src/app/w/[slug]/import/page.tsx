import { cookies } from "next/headers";
import { CalendarImport } from "@/components/customer-workspaces/calendar-import";
import { calendarStatus } from "@/lib/customer-workspaces/calendar-import";
import {
  calendarGoogleReady,
  calendarSyncReady,
} from "@/lib/customer-workspaces/calendar-google";
import { isCalendarKind } from "@/lib/customer-workspaces/calendar-types";
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
export const dynamic = "force-dynamic";
export const metadata = {
  title: "匯入訂單｜旅宿工作區",
  robots: { index: false, follow: false },
};
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    property?: string;
    google?: string;
    calendar?: string;
    source?: string;
  }>;
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
    const initialProperty = workspace.properties[0]?.id === property.id;
    const establishedSource = property.setup?.mode || (initialProperty && (workspace.onboarding?.calendarKind || workspace.onboarding?.sheetUrl));
    if (!establishedSource && !search.source) return <main className="mx-auto max-w-2xl space-y-6 p-6">
      <a className="text-teal-800 underline" href={`/w/${slug}/calendar`}>← 回房況日曆</a>
      <h1 className="text-2xl font-semibold">你的訂房目前記在哪裡？</h1>
      <p className="text-slate-600">選擇來源後先預覽、核對房間與日期，再由你確認匯入。原始資料不會被修改。</p>
      <div className="grid gap-3 sm:grid-cols-2">{[["sheet", "Google Sheet"], ["google_calendar", "Google 日曆"], ["ios_calendar", "iPhone／iPad 日曆匯出檔"], ["android_calendar", "Android 日曆匯出檔"]].map(([source, label]) =>
        <a key={source} href={`?${new URLSearchParams({ property: property.id, source })}`} className="rounded-xl border bg-white p-5 text-teal-900 hover:border-teal-700">{label}</a>)}</div>
      <p className="text-sm text-slate-500">手機日曆需使用可匯出的 ICS／ZIP，或連接其 Google 帳號。</p>
    </main>;

    const calendarKind =
      property.setup?.calendarKind ??
      (initialProperty ? workspace.onboarding?.calendarKind : undefined) ??
      (isCalendarKind(search.source) ? search.source : undefined);
    if (calendarKind)
      return (
        <CalendarImport
          slug={slug}
          property={property}
          initialKind={calendarKind}
          initialStatus={await calendarStatus(
            store,
            account.id,
            slug,
            property.id,
          )}
          configured={calendarGoogleReady()}
          syncReady={calendarSyncReady()}
          connected={search.calendar === "connected"}
          googleFailed={search.calendar === "failed"}
        />
      );
    const journey =
      initialProperty && workspace.onboarding
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
        configured={Boolean(sharedSheetEmail()) || googleReady()}
        connected={search.google === "connected"}
        sharedUrl={
          property.setup?.sheetUrl ??
          (initialProperty ? workspace.onboarding?.sheetUrl : undefined)
        }
        shareEmail={sharedSheetEmail() ?? undefined}
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
