export const maxDuration = 60;
import {NextRequest,NextResponse} from 'next/server';
import {requireManager} from '@/lib/workspace-auth/session';
import {RedisWorkspaceStore} from '@/lib/workspace-auth/store';
import {beginRecovery,recoverySettings,setRecoveryPassword} from '@/lib/workspace-auth/recovery';
import {publicMember} from '@/lib/workspace-auth/types';
import {authFailure,privateHeaders,sameOrigin,inputBody} from '@/lib/workspace-auth/http';
export async function GET(request:NextRequest){try{await requireManager(request);return NextResponse.json(await recoverySettings(),{headers:privateHeaders});}catch(e){return authFailure(e);}}
export async function POST(request:NextRequest){try{sameOrigin(request);const actor=await requireManager(request);const store=new RedisWorkspaceStore();await store.limit('admin-recovery',30,3600);const result=await beginRecovery(store,await inputBody(request),actor);return NextResponse.json({password:result.password,member:publicMember(result.member)},{headers:privateHeaders});}catch(e){return authFailure(e);}}

export async function PUT(request:NextRequest){try{sameOrigin(request);const actor=await requireManager(request);await new RedisWorkspaceStore().limit("recovery-settings",10,3600);return NextResponse.json(await setRecoveryPassword(await inputBody(request),actor),{headers:privateHeaders});}catch(e){return authFailure(e);}}
