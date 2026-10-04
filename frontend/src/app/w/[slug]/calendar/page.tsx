import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  authenticate,
  CUSTOMER_COOKIE,
  enabled,
} from "@/lib/customer-workspaces/auth";
import { RedisCustomerStore } from "@/lib/customer-workspaces/store";
import { loadWorkspace, view } from "@/lib/customer-workspaces/service";
import { CustomerCalendar } from "@/components/customer-workspaces/calendar";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "旅宿工作區｜房況日曆",
  description: "管理自己的旅宿、房間與訂房。",
  robots: { index: false, follow: false },
};
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    property?: string;
    month?: string;
    day?: string;
    room?: string;
  }>;
}) {
  const { slug } = await params;
  if (!enabled()) return <main className="p-10">新客戶入口尚未開放。</main>;
  const store = new RedisCustomerStore();
  let account;
  try {
    account = await authenticate(
      store,
      (await cookies()).get(CUSTOMER_COOKIE)?.value,
    );
  } catch {
    redirect(`/start?next=${encodeURIComponent(`/w/${slug}/calendar`)}`);
  }
  let loaded;
  try {
    loaded = await loadWorkspace(store, account.id, slug);
  } catch {
    return (
      <main className="mx-auto max-w-lg p-10">
        <h1 className="text-xl font-semibold">目前無法開啟此旅宿</h1>
        <p className="my-4">請確認帳號權限，或稍後重試。</p>
        <a className="underline" href="/start">
          回到旅宿列表
        </a>
      </main>
    );
  }
  const { workspace, member } = loaded;
  const query = await searchParams;
  return (
    <CustomerCalendar
      initial={view(workspace, member)}
      initialPropertyId={query.property}
      initialMonth={
        typeof query.month === "string" &&
        /^(20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(query.month)
          ? query.month
          : undefined
      }
      initialDay={
        typeof query.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.day)
          ? query.day
          : undefined
      }
      initialRoom={query.room}
    />
  );
}
