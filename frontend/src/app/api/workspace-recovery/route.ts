import {NextRequest,NextResponse} from 'next/server';
import {requireOwner} from '@/lib/workspace-auth/session';
import {RedisWorkspaceStore} from '@/lib/workspace-auth/store';
import {beginRecovery,sharedRecoveryPassword} from '@/lib/workspace-auth/recovery';
import {publicMember} from '@/lib/workspace-auth/types';
import {authFailure,privateHeaders,sameOrigin,inputBody} from '@/lib/workspace-auth/http';
export async function GET(request:NextRequest){try{await requireOwner(request);return NextResponse.json({password:await sharedRecoveryPassword()},{headers:privateHeaders});}catch(e){return authFailure(e);}}
export async function POST(request:NextRequest){try{sameOrigin(request);await requireOwner(request);const store=new RedisWorkspaceStore();await store.limit('admin-recovery',30,3600);const result=await beginRecovery(store,await inputBody(request));return NextResponse.json({password:result.password,member:publicMember(result.member)},{headers:privateHeaders});}catch(e){return authFailure(e);}}
