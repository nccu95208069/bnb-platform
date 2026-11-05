import {Suspense} from 'react';
import {FinanceLegacyHistory} from '@/components/finance/finance-legacy-history';
export const metadata={title:'Desk Center 舊帳紀錄｜Desk Center'};
export default function FinanceHistoryPage(){return <Suspense fallback={<p>讀取舊帳…</p>}><FinanceLegacyHistory/></Suspense>;}
