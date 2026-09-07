export const maxDuration = 60;
import {NextRequest,NextResponse} from 'next/server';
import {requireOwner} from '@/lib/workspace-auth/session';
import {RedisWorkspaceStore} from '@/lib/workspace-auth/store';
import {beginRecovery,recoverySettings,setRecoveryPassword} from '@/lib/workspace-auth/recovery';
import {publicMember} from '@/lib/workspace-auth/types';
import {authFailure,privateHeaders,sameOrigin,inputBody} from '@/lib/workspace-auth/http';
export async function GET(request:NextRequest){try{await requireOwner(request);return NextResponse.json(await recoverySettings(),{headers:privateHeaders});}catch(e){return authFailure(e);}}
export async function POST(request:NextRequest){try{sameOrigin(request);await requireOwner(request);const store=new RedisWorkspaceStore();await store.limit('admin-recovery',30,3600);const result=await beginRecovery(store,await inputBody(request));return NextResponse.json({password:result.password,member:publicMember(result.member)},{headers:privateHeaders});}catch(e){return authFailure(e);}}

export async function PUT(request:NextRequest){try{sameOrigin(request);await requireOwner(request);await new RedisWorkspaceStore().limit("recovery-settings",10,3600);return NextResponse.json(await setRecoveryPassword(await inputBody(request)),{headers:privateHeaders});}catch(e){return authFailure(e);}}
