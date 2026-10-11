import { notFound } from 'next/navigation';
import { customerPage } from '@/lib/customer-workspaces/page-context';
import { WorkspaceNav } from '@/components/customer-workspaces/workspace-nav';
import { ArrivalReminders } from '@/components/arrival-reminders';
export const dynamic = 'force-dynamic';
export default async function ArrivalsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ property?: string }> }) {
  const { slug } = await params, query = await searchParams, data = await customerPage(slug, 'arrivals');
  if (!data) notFound();
  if (!['owner', 'admin'].includes(data.role)) return <p>此功能僅開放旅宿管理者使用。</p>;
  return <main className="mx-auto max-w-4xl p-5"><h1 className="text-2xl font-semibold">{data.name} · 入住備註</h1><WorkspaceNav data={data} current="arrivals" propertyId={query.property} /><ArrivalReminders workspace={slug} initialProperty={query.property} properties={data.properties.map(p => ({ id: p.id, name: p.name }))} /></main>;
}
