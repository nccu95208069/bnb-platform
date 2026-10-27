import {cookies} from 'next/headers';
import {principalFor} from '@/lib/workspace-auth/session';
import {FinanceSheetBulkWorkspace} from '@/components/finance/finance-sheet-bulk-workspace';

export const metadata={title:'批次補登｜Sweetfun OS'};

export default async function FinanceSheetBulkPage(){
  const actor=await principalFor({cookies:await cookies()});
  if(!actor?.viewPrices||!(actor.allProperties||actor.propertyIds.includes('sweetfun')))
    return <main className="p-6">無法查看此館的批次補登。</main>;
  if(process.env.FINANCE_SHEET_BULK_ENABLED!=='true')
    return <main className="p-6">批次補登尚未啟用。</main>;
  return <FinanceSheetBulkWorkspace/>;
}
