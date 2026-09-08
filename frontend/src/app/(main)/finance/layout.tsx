import {cookies} from 'next/headers';
import {T} from '@/components/i18n/language-provider';
import Link from 'next/link';
import {principalFor} from '@/lib/workspace-auth/session';
import {canUseFinance} from '@/lib/finance-store';
export default async function FinanceLayout({children}:{children:React.ReactNode}){const actor=await principalFor({cookies:await cookies()});if(!canUseFinance(actor))return <div className="p-8"><h1 className="text-xl font-semibold"><T>無法查看財務</T></h1><p className="my-3 text-sm text-muted-foreground"><T>財務目前開放擁有者、God 與 Admin。</T></p><Link href="/home" className="underline"><T>回首頁</T></Link></div>;return children;}
