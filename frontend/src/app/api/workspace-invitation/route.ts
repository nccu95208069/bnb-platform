import {NextRequest,NextResponse} from 'next/server';
import {RedisWorkspaceStore} from '@/lib/workspace-auth/store';
import {activateMember,invitedMember} from '@/lib/workspace-auth/members';
import {authFailure,privateHeaders,sameOrigin,inputBody} from '@/lib/workspace-auth/http';
export async function POST(request:NextRequest){try{sameOrigin(request);const input=await inputBody(request),store=new RedisWorkspaceStore();await store.limit('activation',60,900);if(input.action==='inspect'){const member=invitedMember(input.token,(await store.read()).value.members);return NextResponse.json({email:member.email,displayName:member.displayName},{headers:privateHeaders});}await activateMember(store,input);return NextResponse.json({activated:true},{headers:privateHeaders});}catch(e){return authFailure(e);}}
