import {cookies} from 'next/headers';
import Link from 'next/link';
import {principalFor} from '@/lib/workspace-auth/session';
import {canUseFinance} from '@/lib/finance-store';
export default async function FinanceLayout({children}:{children:React.ReactNode}){const actor=await principalFor({cookies:await cookies()});if(!canUseFinance(actor))return <div className="p-8"><h1 className="text-xl font-semibold">無法查看財務</h1><p className="my-3 text-sm text-muted-foreground">財務目前開放擁有者、God 與 Admin。</p><Link href="/home" className="underline">回首頁</Link></div>;return children;}
