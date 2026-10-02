import { CustomerFinance } from "@/components/customer-workspaces/finance";
import { customerPage } from "@/lib/customer-workspaces/page-context";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "收款記帳",
  robots: { index: false, follow: false },
};
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ property?: string }>;
}) {
  const data = await customerPage((await params).slug, "finance");
  if (!data || data.role === "viewer_no_price")
    return (
      <main className="p-10">
        目前帳號沒有查看金額的權限。
        <a className="ml-3 underline" href="/start">
          回我的旅宿
        </a>
      </main>
    );
  return (
    <CustomerFinance
      initial={data}
      initialPropertyId={(await searchParams).property}
    />
  );
}
