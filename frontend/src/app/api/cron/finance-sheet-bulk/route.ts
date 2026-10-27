import {NextResponse} from 'next/server';
import {authorized} from '@/lib/sheet-monitor/runner';
import {runFinanceSheetBulkScan} from '@/lib/finance-sheet-bulk-runner';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;

export async function GET(request:Request){
  if(!authorized(request.headers.get('authorization'),process.env.CRON_SECRET))
    return NextResponse.json({code:'UNAUTHORIZED'},{status:401});
  if(process.env.FINANCE_SHEET_BULK_ENABLED!=='true')
    return NextResponse.json({code:'SHEET_BULK_DISABLED'},{status:503});
  try{
    const result=await runFinanceSheetBulkScan();
    return NextResponse.json(result,{status:result.status==='ok'?200:503,
      headers:{'Cache-Control':'no-store'}});
  }catch{
    return NextResponse.json({code:'SHEET_BULK_CHECK_FAILED'},{status:503,
      headers:{'Cache-Control':'no-store'}});
  }
}
