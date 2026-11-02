export const metadata = { title: "記帳｜Sweetfun OS" };
import {Suspense} from 'react';
import {FinanceWorkspace} from '@/components/finance/finance-workspace';
export default function BookkeepingPage(){return <Suspense fallback={<p>讀取記帳…</p>}><FinanceWorkspace view="bookkeeping"/></Suspense>;}
