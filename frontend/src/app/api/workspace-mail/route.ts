export const maxDuration = 60;
import {NextRequest,NextResponse} from 'next/server';
import {requireManager} from '@/lib/workspace-auth/session';
import {RedisWorkspaceStore} from '@/lib/workspace-auth/store';
import {configureMail,mailStatus} from '@/lib/workspace-auth/mail';
import {authFailure,privateHeaders,sameOrigin,inputBody} from '@/lib/workspace-auth/http';
export async function GET(request:NextRequest){try{await requireManager(request);return NextResponse.json(await mailStatus(),{headers:privateHeaders});}catch(e){return authFailure(e);}}
export async function PUT(request:NextRequest){try{sameOrigin(request);await requireManager(request);await new RedisWorkspaceStore().limit('mail-config',5,3600);const input=await inputBody(request);return NextResponse.json(await configureMail(input.appPassword),{headers:privateHeaders});}catch(e){return authFailure(e);}}
