import {NextRequest,NextResponse} from 'next/server';
import {principalFor} from '@/lib/workspace-auth/session';
import {privateHeaders,sameOrigin,inputBody} from '@/lib/workspace-auth/http';
import {canUseFinance} from '@/lib/finance-store';
import {activeSources} from '@/lib/booking-sources/config';
import {financeContext} from '@/lib/finance-context';
import {readOperationalSheet} from '@/lib/sheet-monitor/google';
import {normalizeRows,HEADERS} from '@/lib/sheet-monitor/reconcile';
import {adaptSheetBookings} from '@/lib/booking-sources/sweetfun-sheet';
import {attachPrivateGuestNames} from '@/lib/booking-sources/private-guest-names';
import {readSummaryRegistry,saveSummaryRegistry} from '@/lib/finance-summary-store';
import {summarizeOrders,summaryVersion,captureIdentities} from '@/lib/finance-summary';
import {RedisWorkspaceStore} from '@/lib/workspace-auth/store';
async function context(request:NextRequest){
 const actor=await principalFor(request);
 if(!actor)throw new Error('UNAUTHORIZED');
 if(!canUseFinance(actor))throw new Error('FORBIDDEN');
 const sources=activeSources().filter(s=>actor.allProperties||actor.propertyIds.includes(s.property.id));
 const property=request.nextUrl.searchParams.get('property')||sources[0]?.property.id;
 const source=sources.find(s=>s.property.id===property);if(!source)throw new Error('FORBIDDEN');
 await new RedisWorkspaceStore().limit(`finance-summary:${actor.id}`,120,3600);
 const [report,values,registry]=await Promise.all([financeContext(source,new Date().getUTCFullYear()),readOperationalSheet(source),readSummaryRegistry(source.property.id)]);
 const normalized=normalizeRows(values,source);
 const snapshot=adaptSheetBookings([HEADERS,...normalized.map(r=>r.cells)],source.sourceId,new Date().toISOString(),[],normalized.map(r=>r.sourceRow),source.property);
 const rows=attachPrivateGuestNames(snapshot.bookings,values,source);
 const summary=summarizeOrders(source.property.id,rows,report.entries,registry.state);
 return {actor,source,registry,summary,source_version:summaryVersion([summary.orders,report.projection_version]),properties:sources.map(s=>({id:s.property.id,name:s.property.name})),issues:snapshot.issues.length};
}
function failure(e:unknown){const code=e instanceof Error?e.message:'';const status=({UNAUTHORIZED:401,FORBIDDEN:403,VERSION_CONFLICT:409,INVALID_INPUT:400,RATE_LIMITED:429} as Record<string,number>)[code]??503;return NextResponse.json({code:status===503?'UNAVAILABLE':code},{status,headers:privateHeaders});}
export async function GET(request:NextRequest){try{const c=await context(request);return NextResponse.json({schema:1,property_id:c.source.property.id,properties:c.properties,registry_version:c.registry.state.version,source_version:c.source_version,orders:c.summary.orders,retained_orders:c.summary.retained.length,source_issues:c.issues,last_capture:c.registry.state.audits.at(-1)?.at??null,sheet_write:false,updated_at:new Date().toISOString()},{headers:privateHeaders});}catch(e){return failure(e);}}
export async function POST(request:NextRequest){try{
 sameOrigin(request);const input=await inputBody(request);const c=await context(request);
 if(input.source_version!==c.source_version||input.expected_version!==c.registry.state.version)throw new Error('VERSION_CONFLICT');
 const next=captureIdentities(c.registry.state,c.summary.orders,Number(input.expected_version),c.actor.id,c.source_version,new Date().toISOString());
 await saveSummaryRegistry(c.source.property.id,c.registry.raw,next);
 return NextResponse.json({verified:true,version:next.version,sheet_write:false},{headers:privateHeaders});
 }catch(e){return failure(e);}}
