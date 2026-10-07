import { CustomerAvailability } from "@/components/customer-workspaces/availability";
import { customerPage } from "@/lib/customer-workspaces/page-context";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "尚未出售清單",
  robots: { index: false, follow: false },
};
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ property?: string; list?: string }>;
}) {
  const data = await customerPage((await params).slug, "availability"),
    query = await searchParams;
  if (!data)
    return (
      <main className="p-10">
        找不到有權限使用的旅宿。
        <a className="ml-3 underline" href="/start">
          回我的旅宿
        </a>
      </main>
    );
  return (
    <CustomerAvailability
      initial={data}
      initialPropertyId={query.property}
      initialListId={query.list}
    />
  );
}
