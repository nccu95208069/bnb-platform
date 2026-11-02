import {Suspense} from 'react';
import {FinanceLegacyHistory} from '@/components/finance/finance-legacy-history';
export const metadata={title:'OS 舊帳紀錄｜Sweetfun OS'};
export default function FinanceHistoryPage(){return <Suspense fallback={<p>讀取舊帳…</p>}><FinanceLegacyHistory/></Suspense>;}
