import { customerPage } from "@/lib/customer-workspaces/page-context";
import { WebsiteWorkspace } from "@/components/website-booking/website-workspace";
export const dynamic = "force-dynamic";
export const metadata = { title: "民宿管理入口｜Sweetfun OS", robots: { index: false, follow: false } };
export default async function Page({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ property?: string }>;
}) {
  const { slug } = await params;
  const data = await customerPage(slug, "website");
  if (!data) return <main className="p-10">目前無法開啟此旅宿。<a className="ml-3 underline" href="/start">回我的旅宿</a></main>;
  return <WebsiteWorkspace data={data} initialPropertyId={(await searchParams).property} />;
}
