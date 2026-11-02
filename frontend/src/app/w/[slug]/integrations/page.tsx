import { customerPage } from "@/lib/customer-workspaces/page-context";
import { SourceIntegrations } from "@/components/customer-workspaces/source-integrations";

export const dynamic = "force-dynamic";
export const metadata = { title: "來源與通路連接｜Sweetfun OS", robots: { index: false, follow: false } };
export default async function Page({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ property?: string; client_id?: string; provider?: string; state?: string; code_challenge?: string }>;
}) {
  const { slug } = await params, query = await searchParams;
  const flow = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (typeof value === "string") flow.set(key, value);
  const data = await customerPage(slug, `integrations${flow.size ? `?${flow}` : ""}`);
  if (!data || data.role !== "owner") return <main className="p-10">請使用旅宿業主帳號登入。<a className="ml-3 underline" href="/start">回我的旅宿</a></main>;
  return <SourceIntegrations data={data} initialPropertyId={query.property} request={query} />;
}
