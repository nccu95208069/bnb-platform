export const maxDuration = 60;
import {NextRequest,NextResponse} from 'next/server';
import {requireOwner} from '@/lib/workspace-auth/session';
import {RedisWorkspaceStore} from '@/lib/workspace-auth/store';
import {publicMember} from '@/lib/workspace-auth/types';
import {inviteMember,updateMember} from '@/lib/workspace-auth/members';
import {mailStatus,sendInvitation} from '@/lib/workspace-auth/mail';
import {authFailure,privateHeaders,sameOrigin,inputBody} from '@/lib/workspace-auth/http';
export async function GET(request:NextRequest){try{const owner=await requireOwner(request);const state=await new RedisWorkspaceStore().read();return NextResponse.json({members:[{...owner,phone:null,status:'active',invitedAt:'',acceptedAt:null,lastActiveAt:null},...state.value.members.map(publicMember)],mail:await mailStatus()},{headers:privateHeaders});}catch(e){return authFailure(e);}}
export async function POST(request:NextRequest){try{sameOrigin(request);await requireOwner(request);const store=new RedisWorkspaceStore();await store.limit('invitations',30,3600);if(!(await mailStatus()).configured)throw new Error('MAIL_NOT_CONFIGURED');const result=await inviteMember(store,await inputBody(request),sendInvitation);return NextResponse.json({member:publicMember(result.member),delivery:result.delivery},{status:result.delivery==='sent'?200:502,headers:privateHeaders});}catch(e){return authFailure(e);}}
export async function PATCH(request:NextRequest){try{sameOrigin(request);await requireOwner(request);const store=new RedisWorkspaceStore();const member=await updateMember(store,await inputBody(request));return NextResponse.json({member:publicMember(member)},{headers:privateHeaders});}catch(e){return authFailure(e);}}
