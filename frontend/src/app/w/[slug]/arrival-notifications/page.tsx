import { notFound } from 'next/navigation';
import { customerPage } from '@/lib/customer-workspaces/page-context';
import { WorkspaceNav } from '@/components/customer-workspaces/workspace-nav';
import { ArrivalNotificationSettings } from '@/components/arrival-notification-settings';
export const dynamic = 'force-dynamic';
export const metadata = { title: '入住提醒通知設定', robots: { index: false, follow: false } };
export default async function Page({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ property?: string }> }) {
  const { slug } = await params, query = await searchParams, data = await customerPage(slug, 'arrival-notifications');
  if (!data) notFound();
  if (!['owner', 'admin', 'housekeeper'].includes(data.role)) return <main className="p-8">此帳號沒有入住提醒設定權限。</main>;
  return <main className="mx-auto max-w-4xl p-5">
    <h1 className="text-2xl font-semibold">入住提醒通知設定</h1>
    <WorkspaceNav data={data} current="arrival-notifications" propertyId={query.property} />
    <ArrivalNotificationSettings slug={slug} initialProperty={query.property} properties={data.properties.map(p => ({ id: p.id, name: p.name }))} />
  </main>;
}
