import { CustomerSettings } from "@/components/customer-workspaces/settings";
import { customerPage } from "@/lib/customer-workspaces/page-context";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "旅宿與協作設定",
  robots: { index: false, follow: false },
};
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ property?: string }>;
}) {
  const data = await customerPage((await params).slug, "settings");
  if (!data || !["owner", "admin"].includes(data.role))
    return (
      <main className="p-10">
        目前帳號沒有設定權限。
        <a className="ml-3 underline" href="/start">
          回我的旅宿
        </a>
      </main>
    );
  return (
    <CustomerSettings
      initial={data}
      initialPropertyId={(await searchParams).property}
    />
  );
}
