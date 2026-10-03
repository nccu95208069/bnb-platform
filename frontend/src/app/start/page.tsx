import { enabled } from "@/lib/customer-workspaces/auth";
import { calendarGoogleReady } from "@/lib/customer-workspaces/calendar-google";
import { Onboarding } from "@/components/customer-workspaces/onboarding";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "旅宿工作區｜房況日曆",
  description: "管理自己的旅宿、房間與訂房。",
  robots: { index: false, follow: false },
};
export default async function StartPage({
  searchParams,
}: {
  searchParams: Promise<{ google?: string }>;
}) {
  if (!enabled())
    return (
      <main className="mx-auto max-w-lg p-10">
        <h1 className="text-2xl font-semibold">旅宿工作區</h1>
        <p className="mt-4">自助開通目前尚未開放。</p>
        <a className="mt-5 inline-block text-teal-800 underline" href="/join">
          了解服務、申請加入或專人諮詢
        </a>
      </main>
    );
  const search = await searchParams;
  return (
    <>
      {search.google === "failed" && (
        <p
          role="alert"
          className="mx-auto mt-4 max-w-lg rounded-xl bg-amber-50 p-4"
        >
          Google
          登入或授權未完成。請使用同一個瀏覽器重試，或改用信箱登入連結；新加入的旅宿可先從加入頁預覽日曆。
        </p>
      )}
      <Onboarding
        googleConfigured={calendarGoogleReady()}
        allowRegistration={process.env.CUSTOMER_SELF_SIGNUP_PREVIEW === "true"}
      />
    </>
  );
}
