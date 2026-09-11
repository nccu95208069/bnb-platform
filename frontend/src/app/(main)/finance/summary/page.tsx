import {Suspense} from 'react';
import {FinanceSummary} from '@/components/finance/finance-summary';
export const metadata={title:'訂單收款｜Sweetfun OS'};
export default function Page(){return <Suspense fallback={null}><FinanceSummary/></Suspense>;}
