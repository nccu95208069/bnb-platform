export const metadata = { title: "財務首頁｜Sweetfun OS" };
import {Suspense} from 'react';
import {FinanceWorkspace} from '@/components/finance/finance-workspace';
export default function FinancePage(){return <Suspense fallback={<p>讀取財務…</p>}><FinanceWorkspace view="overview"/></Suspense>;}
