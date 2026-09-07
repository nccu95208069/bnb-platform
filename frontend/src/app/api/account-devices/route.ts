import {canManageMember} from '@/lib/workspace-auth/management';
import {RedisWorkspaceStore} from '@/lib/workspace-auth/store';
import {NextRequest,NextResponse} from 'next/server';
import {principalFor} from '@/lib/workspace-auth/session';
import {accountDevices,DEVICE_COOKIE} from '@/lib/workspace-auth/devices';
import {authFailure,privateHeaders} from '@/lib/workspace-auth/http';
export async function GET(request:NextRequest){try{const principal=await principalFor(request);if(!principal)throw new Error('FORBIDDEN');const requested=request.nextUrl.searchParams.get('account');if(requested&&requested!==principal.id&&principal.role!=='owner'&&principal.role!=='god'){const target=(await new RedisWorkspaceStore().read()).value.members.find(m=>m.id===requested);if(!target||target.role==='god'||!canManageMember(principal,target))throw new Error('FORBIDDEN');}const account=requested??principal.id;if(!/^(calendar-owner|[a-f0-9]{32})$/.test(account))throw new Error('INVALID_INPUT');return NextResponse.json({devices:await accountDevices(account),currentDeviceId:request.cookies.get(DEVICE_COOKIE)?.value??null},{headers:privateHeaders});}catch(e){return authFailure(e);}}
