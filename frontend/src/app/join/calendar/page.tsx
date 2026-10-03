import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CalendarImport } from "@/components/customer-workspaces/calendar-import";
import {
  ONBOARDING_COOKIE,
  draftHash,
  calendarOnboardingView,
} from "@/lib/customer-workspaces/calendar-onboarding";
import { authenticate, CUSTOMER_COOKIE } from "@/lib/customer-workspaces/auth";
import { store } from "@/lib/customer-workspaces/http";
import { previewAvailable } from "@/lib/customer-workspaces/calendar-onboarding-http";
import {
  calendarGoogleReady,
  calendarSyncReady,
} from "@/lib/customer-workspaces/calendar-google";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "先預覽日曆｜旅宿工作區",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
};
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ calendar?: string }>;
}) {
  let view;
  try {
    previewAvailable();
    const jar = await cookies();
    let account;
    const customer = jar.get(CUSTOMER_COOKIE)?.value;
    if (customer) {
      try {
        account = await authenticate(store, customer);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "UNAUTHORIZED")
          throw error;
      }
    }
    view = await calendarOnboardingView(
      store,
      draftHash(jar.get(ONBOARDING_COOKIE)?.value),
      account,
    );
  } catch {
    return (
      <main className="mx-auto max-w-lg space-y-5 p-8">
        <h1 className="text-2xl font-semibold">重新開始日曆預覽</h1>
        <p>
          暫存預覽已過期，或目前無法讀取。請在原本的瀏覽器重試；也可以回加入頁重新選檔。尚未保存的資料不會建立正式訂單。
        </p>
        <a className="text-teal-800 underline" href="/join">
          回加入頁
        </a>
      </main>
    );
  }
  if (view.completed) redirect(view.completed);
  const search = await searchParams;
  return (
    <CalendarImport
      slug="onboarding-preview"
      property={view.property}
      initialKind={view.kind}
      initialStatus={view.status}
      configured={calendarGoogleReady()}
      syncReady={calendarSyncReady()}
      connected={search.calendar === "connected"}
      onboarding={{
        source: view.source,
        preview: view.preview,
        prepared: view.prepared,
        account: view.account,
        googleEmail: view.googleEmail,
        expiresAt: view.expiresAt,
        googleFailed: search.calendar === "failed",
      }}
    />
  );
}
