import { cookies } from 'next/headers';
import { principalFor } from '@/lib/workspace-auth/session';
import { activeSources } from '@/lib/booking-sources/config';
import { ArrivalReminders } from '@/components/arrival-reminders';
export const dynamic = 'force-dynamic';
export default async function ArrivalsPage() {
  const actor = await principalFor({ cookies: await cookies() });
  if (!actor || !['owner', 'god', 'admin'].includes(actor.role)) return <p>此功能僅開放旅宿管理者使用。</p>;
  const properties = activeSources().filter(s => actor.allProperties || actor.propertyIds.includes(s.property.id)).map(s => ({ id: s.property.id, name: s.property.name }));
  return <div className="mx-auto max-w-3xl space-y-6"><h1 className="text-2xl font-semibold">入住備註</h1><ArrivalReminders properties={properties} /></div>;
}
