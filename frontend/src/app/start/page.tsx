import { enabled } from "@/lib/customer-workspaces/auth";
import { Onboarding } from "@/components/customer-workspaces/onboarding";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "旅宿工作區｜房況日曆",
  description: "管理自己的旅宿、房間與訂房。",
  robots: { index: false, follow: false },
};
export default function StartPage() {
  if (!enabled())
    return (
      <main className="mx-auto max-w-lg p-10">
        <h1 className="text-2xl font-semibold">旅宿工作區</h1>
        <p className="mt-4">新客戶入口尚未開放。</p>
      </main>
    );
  return <Onboarding />;
}
