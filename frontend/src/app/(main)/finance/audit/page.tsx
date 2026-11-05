import {Suspense} from 'react';
import {FinanceAudit} from '@/components/finance/finance-audit';
export const metadata={title:'財務操作紀錄｜Desk Center'};
export default function Page(){return <Suspense><FinanceAudit/></Suspense>;}
