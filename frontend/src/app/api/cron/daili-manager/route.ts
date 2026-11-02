import {NextResponse} from 'next/server';
import {redisCommand} from '@/lib/workspace-auth/store';
import {authorized} from '@/lib/sheet-monitor/runner';
import {createManager} from '@/lib/host-agents/manager.mjs';
import {createDaili} from '@/lib/host-agents/daili.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function GET(request:Request){
 if(!authorized(request.headers.get('authorization'),process.env.CRON_SECRET))return NextResponse.json({error:'unauthorized'},{status:401});
 try{return NextResponse.json(await createDaili(redisCommand,createManager(redisCommand)).run(),{headers:{'Cache-Control':'no-store'}});}
 catch{return NextResponse.json({error:'daili_sync_unavailable'},{status:503});}
}
