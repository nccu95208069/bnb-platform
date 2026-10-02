import { enabled } from "@/lib/customer-workspaces/auth";
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
        <p className="mt-4">新客戶入口尚未開放。</p>
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
          授權未完成或已過期。請回到旅宿的匯入頁重新連線，並使用同一個瀏覽器完成授權。
        </p>
      )}
      <Onboarding />
    </>
  );
}
